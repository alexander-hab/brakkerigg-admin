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
    if (!isAdmin(context)) return { statusCode: 403, body: "Forbidden" }

    let body = {}
    try { body = event.body ? JSON.parse(event.body) : {} } catch { return { statusCode: 400, body: "Ugyldig JSON" } }

    const unitId = Number(body.unit_id)
    const tenantName = String(body.tenant_name || "").trim() || null
    const company = String(body.company || "").trim() || null
    const checkin = body.checkin_date
    const checkout = body.checkout_date
    const email = String(body.tenant_email || body.email || "").trim() || null
    const phone = String(body.tenant_phone || body.phone || "").trim() || null

    if (!unitId || !isIsoDate(checkin) || !isIsoDate(checkout)) return { statusCode: 400, body: "Ugyldig input" }

    const len = daysBetween(checkin, checkout)
    if (!Number.isFinite(len) || len < 7) return { statusCode: 400, body: "Minimum leieperiode er 7 netter" }
    if (!isMondayIso(checkin) || !isMondayIso(checkout) || !isWholeWeeks(checkin, checkout)) {
      return { statusCode: 400, body: "Bookinger må være fra mandag til mandag i hele uker" }
    }

    const sql = neon(process.env.DATABASE_URL)

    const conflict = await sql`
      select 1
      from bookings
      where unit_id = ${unitId}
        and status <> 'cancelled'
        and checkin_date < ${checkout}::date
        and checkout_date > ${checkin}::date
      limit 1;
    `
    if (conflict.length > 0) return { statusCode: 409, body: "Konflikt. Enheten er allerede booket i perioden" }

    const inserted = await sql`
      insert into bookings (unit_id, tenant_name, company, tenant_email, tenant_phone, checkin_date, checkout_date, status)
      values (${unitId}, ${tenantName}, ${company}, ${email}, ${phone}, ${checkin}::date, ${checkout}::date, 'booked')
      returning id;
    `

     const bookingId = inserted[0]?.id || null

    if (bookingId && email) {
      const weeks = bookingWeeks(checkin, checkout)
      const price = formatPriceKr(bookingPriceForWeeks(weeks))

      const text = [
        "Bookingen din er registrert.",
        "",
        `Bookingnummer: ${bookingId}`,
        `Enhet: ${unitId}`,
        `Periode: ${checkin} → ${checkout}`,
        price ? `Pris: ${price}` : null,
        tenantName ? `Navn: ${tenantName}` : null,
        company ? `Firma: ${company}` : null
      ].filter(Boolean).join("\n")

      const html = `
        <p>Bookingen din er registrert.</p>
        <p><strong>Bookingnummer:</strong> ${bookingId}</p>
        <p><strong>Enhet:</strong> ${unitId}</p>
        <p><strong>Periode:</strong> ${checkin} → ${checkout}</p>
        ${price ? `<p><strong>Pris:</strong> ${price}</p>` : ""}
        ${tenantName ? `<p><strong>Navn:</strong> ${tenantName}</p>` : ""}
        ${company ? `<p><strong>Firma:</strong> ${company}</p>` : ""}
      `

      try {
        await sendEmailjsEmail({
          to: email,
          subject: `Booking bekreftet (#${bookingId})`,
          text,
          html,
          templateId: process.env.EMAILJS_TEMPLATE_ID_BOOKING || process.env.EMAILJS_TEMPLATE_ID_APPROVED
        })
      } catch (err) {
        console.error("Klarte ikke å sende bookingepost", err)
      }
    }


    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, id: bookingId })
    }
  } catch (err) {
    return { statusCode: 500, headers: { "Cache-Control": "no-store" }, body: String(err?.message || err) }
  }
}
