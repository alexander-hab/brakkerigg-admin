import { neon } from "@netlify/neon"
import { userIsAdmin } from "./_roles.mjs"

function getViewer(context) {
  const user = context?.clientContext?.user || null
  const isAdmin = userIsAdmin(user)
  return {
    user,
    email: user?.email || "",
    isAdmin
  }
}

function text(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    body
  }
}

export const handler = async (event, context) => {
  try {
    const v = getViewer(context)

    if (!v.user) {
      return text(401, "Unauthorized")
    }

    if (!v.isAdmin) {
      return text(403, "Forbidden")
    }

    if (event.httpMethod !== "POST") {
      return text(405, "Method not allowed")
    }

    const body = event.body ? JSON.parse(event.body) : {}
    const start = typeof body?.start === "string" ? body.start : ""
    const end = typeof body?.end === "string" ? body.end : ""
    if (!start || !end) {
      return text(400, "Mangler start eller end")
    }

    const sql = neon(process.env.DATABASE_URL)
    const bookings = await sql`
      select
        b.id as booking_id,
        u.unit_code,
        b.company,
        b.tenant_name,
        b.tenant_email,
        b.tenant_phone,
        b.checkin_date::text as checkin_date,
        b.checkout_date::text as checkout_date
      from bookings b
      join units u on u.id = b.unit_id
      where b.status <> 'cancelled'
        and b.checkin_date < ${end}
        and b.checkout_date > ${start}
      order by b.checkin_date asc, u.unit_code asc;
    `

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ bookings })
    }
  } catch (err) {
    return text(500, String(err?.message || err))
  }
}