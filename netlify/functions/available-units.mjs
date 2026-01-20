import { neon } from "@netlify/neon"

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function daysBetween(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  return Math.round((db - da) / (1000 * 60 * 60 * 24))
}

export const handler = async (event, context) => {
  try {
    const user = context?.clientContext?.user || null
    if (!user) {
      return { statusCode: 401, headers: { "Cache-Control": "no-store" }, body: "Unauthorized" }
    }

    const qs = event.queryStringParameters || {}
    const checkin = qs.checkin_date
    const checkout = qs.checkout_date

    if (!isIsoDate(checkin) || !isIsoDate(checkout)) {
      return { statusCode: 400, headers: { "Cache-Control": "no-store" }, body: "Ugyldig dato" }
    }

    const len = daysBetween(checkin, checkout)
    if (!Number.isFinite(len) || len < 7) {
      return { statusCode: 400, headers: { "Cache-Control": "no-store" }, body: "Minimum 7 netter" }
    }

    const sql = neon(process.env.DATABASE_URL)

    const units = await sql`
      select u.id as unit_id, u.unit_code
      from units u
      where not exists (
        select 1
        from bookings b
        where b.unit_id = u.id
          and b.status <> 'cancelled'
          and b.checkin_date < ${checkout}::date
          and b.checkout_date > ${checkin}::date
      )
      and not exists (
        select 1
        from booking_request_lines rl
        where rl.unit_id = u.id
          and rl.status = 'pending'
          and rl.checkin_date < ${checkout}::date
          and rl.checkout_date > ${checkin}::date
      )
      order by u.unit_code asc;
    `

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(units)
    }
  } catch (err) {
    return { statusCode: 500, headers: { "Cache-Control": "no-store" }, body: String(err?.message || err) }
  }
}
