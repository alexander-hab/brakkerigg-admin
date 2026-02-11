import { neon } from "@netlify/neon"
import { userIsAdmin } from "./_roles.mjs"

function isAdmin(context) {
  const user = context?.clientContext?.user || null
  return userIsAdmin(user)
}

export const handler = async (event, context) => {
  try {
    const user = context?.clientContext?.user || null
    if (!user) return { statusCode: 401, headers: { "Cache-Control": "no-store" }, body: "Unauthorized" }
    if (!isAdmin(context)) return { statusCode: 403, headers: { "Cache-Control": "no-store" }, body: "Forbidden" }

    const sql = neon(process.env.DATABASE_URL)

    const lines = await sql`
      select
        rl.id as line_id,
        rl.created_at,
        rl.status,
        rl.checkin_date::text as checkin_date,
        rl.checkout_date::text as checkout_date,
        rl.tenant_name,
        rl.company,
        rl.comment,
        rl.unit_id,
        u.unit_code,
        r.id as request_id,
        r.requested_by_email,
        r.requester_email,
        r.requester_phone,
        rl.decided_at
      from booking_request_lines rl
      join booking_requests r on r.id = rl.request_id
      join units u on u.id = rl.unit_id
      where rl.created_at >= now() - interval '30 days'
      order by
        case when rl.status = 'pending' then 0 else 1 end,
        rl.created_at desc;
    `

    const pendingCount = lines.filter(x => String(x.status) === "pending").length

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ pending_count: pendingCount, lines })
    }
  } catch (err) {
    return { statusCode: 500, headers: { "Cache-Control": "no-store" }, body: String(err?.message || err) }
  }
}
