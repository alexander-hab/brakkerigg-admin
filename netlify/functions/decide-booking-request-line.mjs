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

function bookingWeeks(a, b) {
  const len = daysBetween(a, b)
  if (!Number.isFinite(len) || len < 7 || len % 7 !== 0) return null
  return len / 7
}

function bookingPriceForWeeks(weeks) {
  if (!Number.isFinite(weeks) || weeks <= 0) return null
  const rate = weeks >= 4 ? 2000 : 2500
  return weeks * rate
}

function formatPriceKr(amount) {
  if (!Number.isFinite(amount)) return null
  return `${amount.toLocaleString("nb-NO")} kr`
}

function isAdmin(context) {
  const user = context?.clientContext?.user || null
  const rolesRaw = user?.app_metadata?.roles || []
  const roles = Array.isArray(rolesRaw) ? rolesRaw.map(r => String(r).toLowerCase()) : []
  return Boolean(user) && roles.includes("admin")
}

export const handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" }

    const user = context?.clientContext?.user || null
    if (!user) return { statusCode: 401, headers: { "Cache-Control": "no-store" }, body: "Unauthorized" }
    if (!isAdmin(context)) return { statusCode: 403, headers: { "Cache-Control": "no-store" }, body: "Forbidden" }

    let body = {}
    try { body = event.body ? JSON.parse(event.body) : {} } catch { return { statusCode: 400, body: "Ugyldig JSON" } }

    const lineId = Number(body.line_id)
    const action = String(body.action || "").toLowerCase()

    if (!lineId || (action !== "approve" && action !== "reject")) {
      return { statusCode: 400, body: "Ugyldig input" }
    }

    const sql = neon(process.env.DATABASE_URL)

    const found = await sql`
      select
        rl.*,
        r.requester_email,
        r.requested_by_email,
        r.requester_phone,
        rl.checkin_date::text as checkin_date,
        rl.checkout_date::text as checkout_date
      from booking_request_lines rl
      join booking_requests r on r.id = rl.request_id
      where rl.id = ${lineId}
      limit 1;
    `
    const ln = found[0]
    if (!ln) return { statusCode: 404, body: "Fant ikke linje" }
    if (String(ln.status) !== "pending") return { statusCode: 409, body: "Allerede behandlet" }

    const decidedByUserId = String(user.id || user.sub || "").trim() || null
    const requesterEmail = String(ln.requester_email || ln.requested_by_email || "").trim() || null

    if (action === "reject") {
      await sql`
        update booking_request_lines
        set status = 'rejected',
            decided_at = now(),
            decided_by_user_id = ${decidedByUserId}
        where id = ${lineId};
      `

      const recipientEmail = requesterEmail
      if (recipientEmail) {
        const text = [
          "Beklager, forespørselen din er avslått.",
          "",
          `Forespørselsnummer: ${ln.request_id || ""}`,
          `Enhet: ${ln.unit_id}`,
          `Periode: ${ln.checkin_date} → ${ln.checkout_date}`,
          "",
          "Ta gjerne kontakt om du ønsker andre datoer."
        ].join("\n")

        const html = `
          <p>Beklager, forespørselen din er avslått.</p>
          <p><strong>Forespørselsnummer:</strong> ${ln.request_id || ""}</p>
          <p><strong>Enhet:</strong> ${ln.unit_id}</p>
          <p><strong>Periode:</strong> ${ln.checkin_date} → ${ln.checkout_date}</p>
          <p>Ta gjerne kontakt om du ønsker andre datoer.</p>
        `

        try {
          await sendEmailjsEmail({
            to: recipientEmail,
            subject: `Forespørsel avslått (#${ln.request_id || ""})`,
            text,
            html,
            templateId: process.env.EMAILJS_TEMPLATE_ID_REJECTED
          })
        } catch (err) {
          console.error("Klarte ikke å sende avslagsepost", err)
        }
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ ok: true })
      }
    }

    const unitId = Number(ln.unit_id)
    const checkin = String(ln.checkin_date || "")
    const checkout = String(ln.checkout_date || "")

    if (!isIsoDate(checkin) || !isIsoDate(checkout)) {
      return { statusCode: 500, body: "Ugyldige datoer på forespørselen" }
    }

    const conflict = await sql`
      select 1
      from bookings b
      where b.unit_id = ${unitId}
        and b.status <> 'cancelled'
        and b.checkin_date < ${checkout}::date
        and b.checkout_date > ${checkin}::date
      limit 1;
    `
    if (conflict.length > 0) return { statusCode: 409, body: "Konflikt. Enheten ble booket i mellomtiden" }

    const inserted = await sql`
      insert into bookings (unit_id, tenant_name, company, tenant_email, tenant_phone, checkin_date, checkout_date, status)
      values (
        ${unitId},
        ${ln.tenant_name || null},
        ${ln.company || null},
        ${requesterEmail},
        ${ln.requester_phone || null},
        ${checkin}::date,
        ${checkout}::date,
        'booked'
      )
      returning id;
    `
    const bookingId = inserted[0]?.id || null
    if (!bookingId) return { statusCode: 500, body: "Klarte ikke å opprette booking" }

    await sql`
      update booking_request_lines
      set status = 'approved',
          approved_booking_id = ${bookingId},
          decided_at = now(),
          decided_by_user_id = ${decidedByUserId}
      where id = ${lineId};
    `

    const recipientEmail = requesterEmail
    if (recipientEmail) {
      const weeks = bookingWeeks(checkin, checkout)
      const price = formatPriceKr(bookingPriceForWeeks(weeks))
      
      const text = [
        "Bookingforespørselen din er godkjent.",
        "",
        `Bookingnummer: ${bookingId}`,
        `Forespørselsnummer: ${ln.request_id || ""}`,
        `Enhet: ${ln.unit_id}`,
        `Periode: ${checkin} → ${checkout}`,
        price ? `Pris: ${price}` : null,
        ln.tenant_name ? `Navn: ${ln.tenant_name}` : null,
        ln.company ? `Firma: ${ln.company}` : null
      ].filter(Boolean).join("\n")

      const html = `
        <p>Bookingforespørselen din er godkjent.</p>
        <p><strong>Bookingnummer:</strong> ${bookingId}</p>
        <p><strong>Forespørselsnummer:</strong> ${ln.request_id || ""}</p>
        <p><strong>Enhet:</strong> ${ln.unit_id}</p>
        <p><strong>Periode:</strong> ${checkin} → ${checkout}</p>
        ${price ? `<p><strong>Pris:</strong> ${price}</p>` : ""}
        ${ln.tenant_name ? `<p><strong>Navn:</strong> ${ln.tenant_name}</p>` : ""}
        ${ln.company ? `<p><strong>Firma:</strong> ${ln.company}</p>` : ""}
      `

      try {
        await sendEmailjsEmail({
          to: recipientEmail,
          subject: `Booking godkjent (#${bookingId})`,
          text,
          html,
          templateId: process.env.EMAILJS_TEMPLATE_ID_APPROVED
        })
      } catch (err) {
        console.error("Klarte ikke å sende godkjenningsepost", err)
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, booking_id: bookingId })
    }
  } catch (err) {
    return { statusCode: 500, headers: { "Cache-Control": "no-store" }, body: String(err?.message || err) }
  }
}
