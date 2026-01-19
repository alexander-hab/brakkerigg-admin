import { neon } from "@netlify/neon"

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

export const handler = async (event, context) => {
  try {
    const user = context?.clientContext?.user || null
    if (!user) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "Unauthorized" })
      }
    }

    if (event.httpMethod !== "GET") {
      return { statusCode: 405, body: "Method not allowed" }
    }

    const start = event.queryStringParameters?.start || ""
    const end = event.queryStringParameters?.end || ""

    if (!isIsoDate(start) || !isIsoDate(end)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "Bad request. Use ?start=YYYY-MM-DD&end=YYYY-MM-DD" })
      }
    }

    const sql = neon(process.env.DATABASE_URL)

    const rows = await sql`
      select
        u.unit_code,
        b.id as booking_id,
        b.company,
        b.tenant_name,
        b.checkout_date::text as checkout_date
      from bookings b
      join units u on u.id = b.unit_id
      where b.status <> 'cancelled'
        and b.checkout_date > ${start}::date
        and b.checkout_date <= ${end}::date
      order by b.checkout_date asc, u.unit_code asc;
    `

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(rows)
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: String(err?.message || err) })
    }
  }
}
