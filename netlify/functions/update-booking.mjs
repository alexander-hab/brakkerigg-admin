import { neon } from "@netlify/neon"

function isAdmin(context) {
  const user = context?.clientContext?.user || null
  const rolesRaw = user?.app_metadata?.roles || []
  const roles = Array.isArray(rolesRaw) ? rolesRaw.map(r => String(r).toLowerCase()) : []
  return Boolean(user) && roles.includes("admin")
}

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
    if (!isAdmin(context)) return { statusCode: 403, body: "Forbidden" }

    let body = {}
    try { body = event.body ? JSON.parse(event.body) : {} } catch { return { statusCode: 400, body: "Ugyldig JSON" } }

    const bookingId = Number(body.booking_id)
    const tenantName = String(body.tenant_name || "").trim() || null
    const company = String(body.company || "").trim() || null
    const email = String(body.tenant_email || body.email || "").trim() || null
    const phone = String(body.tenant_phone || body.phone || "").trim() || null
    const checkin = String(body.checkin_date || "")
    const checkout = String(body.checkout_date || "")

    if (!Number.isFinite(bookingId) || bookingId <= 0) return { statusCode: 400, body: "Mangler booking_id" }
    if (!isIsoDate(checkin) || !isIsoDate(checkout)) return { statusCode: 400, body: "Ugyldige datoer" }

    const len = daysBetween(checkin, checkout)
    if (!Number.isFinite(len) || len < 7) return { statusCode: 400, body: "Minimum leieperiode er 7 netter" }
    if (!isMondayIso(checkin) || !isMondayIso(checkout) || !isWholeWeeks(checkin, checkout)) {
      return { statusCode: 400, body: "Bookinger må være fra mandag til mandag i hele uker" }
    }

    const sql = neon(process.env.DATABASE_URL)

    const existing = await sql`
      select id, unit_id
      from bookings
      where id = ${bookingId}
        and status <> 'cancelled'
      limit 1;
    `

    if (existing.length === 0) return { statusCode: 404, body: "Fant ikke aktiv booking" }

    const unitId = Number(existing[0].unit_id)

    const conflict = await sql`
      select 1
      from bookings
      where unit_id = ${unitId}
        and id <> ${bookingId}
        and status <> 'cancelled'
        and checkin_date < ${checkout}::date
        and checkout_date > ${checkin}::date
      limit 1;
    `
    if (conflict.length > 0) return { statusCode: 409, body: "Konflikt. Enheten er allerede booket i perioden" }

    const updated = await sql`
      update bookings
      set tenant_name = ${tenantName},
          company = ${company},
          tenant_email = ${email},
          tenant_phone = ${phone},
          checkin_date = ${checkin}::date,
          checkout_date = ${checkout}::date
      where id = ${bookingId}
      returning id;
    `

    if (updated.length === 0) return { statusCode: 404, body: "Fant ikke booking" }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, id: bookingId })
    }
  } catch (err) {
    return { statusCode: 500, headers: { "Cache-Control": "no-store" }, body: String(err?.message || err) }
  }
}