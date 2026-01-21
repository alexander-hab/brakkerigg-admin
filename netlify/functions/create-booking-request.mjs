import { neon } from "@netlify/neon"
import { sendEmailjsEmail } from "./_emailjs.mjs"

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function daysBetween(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  return Math.round((db - da) / (1000 * 60 * 60 * 24))
}

function isMondayIso(s) {
  if (!isIsoDate(s)) return false
  return new Date(s).getUTCDay() === 1
}

function isWholeWeeks(a, b) {
  const len = daysBetween(a, b)
  return Number.isFinite(len) && len >= 7 && len % 7 === 0
}

export const handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" }

    const user = context?.clientContext?.user || null
    if (!user) return { statusCode: 401, headers: { "Cache-Control": "no-store" }, body: "Unauthorized" }

    let body = {}
    try { body = event.body ? JSON.parse(event.body) : {} } catch { return { statusCode: 400, body: "Ugyldig JSON" } }

    const requesterEmail = String(body.requester_email || body.email || "").trim() || null
    const requesterPhone = String(body.requester_phone || body.phone || "").trim() || null
    const lines = Array.isArray(body.lines) ? body.lines : []

    if (lines.length === 0) return { statusCode: 400, body: "Mangler linjer" }
    if (lines.length > 30) return { statusCode: 400, body: "For mange linjer" }

    for (const ln of lines) {
      const unitId = Number(ln.unit_id)
      const checkin = ln.checkin_date
      const checkout = ln.checkout_date
      if (!unitId || !isIsoDate(checkin) || !isIsoDate(checkout)) return { statusCode: 400, body: "Ugyldig linje" }

      const len = daysBetween(checkin, checkout)
      if (!Number.isFinite(len) || len < 7) return { statusCode: 400, body: "Minimum 7 netter" }
      if (!isMondayIso(checkin) || !isMondayIso(checkout) || !isWholeWeeks(checkin, checkout)) {
        return { statusCode: 400, body: "Bookinger må være fra mandag til mandag i hele uker" }
      }
    }

    const sql = neon(process.env.DATABASE_URL)

    for (const ln of lines) {
      const unitId = Number(ln.unit_id)
      const checkin = ln.checkin_date
      const checkout = ln.checkout_date

      const conflict = await sql`
        select 1
        from bookings b
        where b.unit_id = ${unitId}
          and b.status <> 'cancelled'
          and b.checkin_date < ${checkout}::date
          and b.checkout_date > ${checkin}::date
        limit 1;
      `
      if (conflict.length > 0) return { statusCode: 409, body: "Konflikt med eksisterende booking" }

      const pending = await sql`
        select 1
        from booking_request_lines rl
        where rl.unit_id = ${unitId}
          and rl.status = 'pending'
          and rl.checkin_date < ${checkout}::date
          and rl.checkout_date > ${checkin}::date
        limit 1;
      `
      if (pending.length > 0) return { statusCode: 409, body: "Konflikt med forespurt booking" }
    }

    const req = await sql`
      insert into booking_requests (requested_by_user_id, requested_by_email, requester_email, requester_phone)
      values (${String(user.id || "")}, ${String(user.email || "")}, ${requesterEmail}, ${requesterPhone})
      returning id;
    `
    const requestId = req[0]?.id
    if (!requestId) return { statusCode: 500, body: "Klarte ikke å opprette forespørsel" }

    for (const ln of lines) {
      const unitId = Number(ln.unit_id)
      const checkin = ln.checkin_date
      const checkout = ln.checkout_date
      const tenantName = String(ln.tenant_name || "").trim() || null
      const company = String(ln.company || "").trim() || null
      const comment = String(ln.comment || "").trim() || null

      await sql`
        insert into booking_request_lines
          (request_id, unit_id, tenant_name, company, comment, checkin_date, checkout_date, status)
        values
          (${requestId}, ${unitId}, ${tenantName}, ${company}, ${comment}, ${checkin}::date, ${checkout}::date, 'pending');
      `
    }

    const recipientEmail = requesterEmail || String(user.email || "").trim() || null
    if (recipientEmail) {
      const linesText = lines.map((ln, idx) => {
        const tenantName = String(ln.tenant_name || "").trim()
        const company = String(ln.company || "").trim()
        const comment = String(ln.comment || "").trim()
        const unitId = ln.unit_id
        const checkin = ln.checkin_date
        const checkout = ln.checkout_date

        const meta = [
          tenantName ? `Navn: ${tenantName}` : null,
          company ? `Firma: ${company}` : null,
          comment ? `Kommentar: ${comment}` : null
        ].filter(Boolean).join(" | ")

        return `${idx + 1}. Enhet: ${unitId}, ${checkin} → ${checkout}${meta ? ` (${meta})` : ""}`
      }).join("\n")

      const text = [
        "Vi har mottatt bookingforespørselen din.",
        "",
        `Forespørselsnummer: ${requestId}`,
        linesText,
        "",
        "Påminnelse: Kontrakt må være signert før forespørselen kan godkjennes.",
        "",
        "Vi tar kontakt så snart forespørselen er behandlet."
      ].join("\n")

      const htmlLines = lines.map((ln, idx) => {
        const tenantName = String(ln.tenant_name || "").trim()
        const company = String(ln.company || "").trim()
        const comment = String(ln.comment || "").trim()
        const unitId = ln.unit_id
        const checkin = ln.checkin_date
        const checkout = ln.checkout_date

        const meta = [
          tenantName ? `Navn: ${tenantName}` : null,
          company ? `Firma: ${company}` : null,
          comment ? `Kommentar: ${comment}` : null
        ].filter(Boolean).join(" | ")

        return `<li><strong>${idx + 1}.</strong> Enhet ${unitId}, ${checkin} → ${checkout}${meta ? ` (${meta})` : ""}</li>`
      }).join("")

      const html = `
        <p>Vi har mottatt bookingforespørselen din.</p>
        <p><strong>Forespørselsnummer:</strong> ${requestId}</p>
        <ul>${htmlLines}</ul>
        <p><strong>Påminnelse:</strong> Kontrakt må være signert før forespørselen kan godkjennes.</p>
        <p>Vi tar kontakt så snart forespørselen er behandlet.</p>
      `

      try {
        await sendEmailjsEmail({
          to: recipientEmail,
          subject: `Forespørsel mottatt (#${requestId})`,
          text,
          html,
          templateId: process.env.EMAILJS_TEMPLATE_ID_REQUEST
        })
      } catch (err) {
        console.error("Klarte ikke å sende forespørselsepost", err)
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, request_id: requestId })
    }
  } catch (err) {
    return { statusCode: 500, headers: { "Cache-Control": "no-store" }, body: String(err?.message || err) }
  }
}
