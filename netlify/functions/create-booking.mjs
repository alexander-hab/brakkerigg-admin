import { neon } from "@netlify/neon"

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function daysBetween(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  return Math.round((db - da) / (1000 * 60 * 60 * 24))
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
    const email = String(body.tenant_email || "").trim() || null
    const phone = String(body.tenant_phone || "").trim() || null

    if (!unitId || !isIsoDate(checkin) || !isIsoDate(checkout)) return { statusCode: 400, body: "Ugyldig input" }

    const len = daysBetween(checkin, checkout)
    if (!Number.isFinite(len) || len < 7) return { statusCode: 400, body: "Minimum leieperiode er 7 netter" }

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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, id: inserted[0]?.id || null })
    }
  } catch (err) {
    return { statusCode: 500, headers: { "Cache-Control": "no-store" }, body: String(err?.message || err) }
  }
}
