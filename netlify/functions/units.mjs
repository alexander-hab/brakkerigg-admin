import { neon } from "@netlify/neon"

function toLowerRoles(rolesRaw) {
  if (!Array.isArray(rolesRaw)) return []
  return rolesRaw.map((r) => String(r).toLowerCase())
}

function parseUpcoming(x) {
  if (Array.isArray(x)) return x
  if (typeof x !== "string") return []
  try {
    const p = JSON.parse(x)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
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

    const roles = toLowerRoles(user?.app_metadata?.roles || [])
    const isAdmin = roles.includes("admin")

    const sql = neon(process.env.DATABASE_URL)

    const rows = await sql`
      with today as (select current_date as d)
      select
        u.id as unit_id,
        u.unit_code,

        cb.id as current_booking_id,
        cb.tenant_name as current_tenant_name,
        cb.company as current_company,
        cb.checkin_date::text as current_checkin_date,
        cb.checkout_date::text as current_checkout_date,

        nb.id as next_booking_id,
        nb.checkin_date::text as next_checkin_date,
        nb.checkout_date::text as next_checkout_date,

        coalesce(ub.upcoming_bookings, '[]'::json) as upcoming_bookings,

        coalesce(td.total_days_completed, 0) as total_days_completed
      from units u

      left join lateral (
        select b.*
        from bookings b, today
        where b.unit_id = u.id
          and b.status <> 'cancelled'
          and b.checkin_date <= today.d
          and b.checkout_date > today.d
        order by b.checkin_date desc
        limit 1
      ) cb on true

      left join lateral (
        select b.*
        from bookings b, today
        where b.unit_id = u.id
          and b.status <> 'cancelled'
          and b.checkin_date > today.d
        order by b.checkin_date asc
        limit 1
      ) nb on true

      left join lateral (
        select json_agg(
          json_build_object(
            'id', b.id,
            'tenant_name', b.tenant_name,
            'company', b.company,
            'checkin_date', b.checkin_date::text,
            'checkout_date', b.checkout_date::text
          )
          order by b.checkin_date asc
        ) as upcoming_bookings
        from bookings b, today
        where b.unit_id = u.id
          and b.status <> 'cancelled'
          and b.checkin_date > today.d
      ) ub on true

      left join lateral (
        select sum((b.checkout_date - b.checkin_date))::int as total_days_completed
        from bookings b, today
        where b.unit_id = u.id
          and b.status <> 'cancelled'
          and b.checkout_date <= today.d
      ) td on true

      order by u.unit_code asc;
    `

    if (isAdmin) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify(rows)
      }
    }

    const safeRows = rows.map((r) => {
      const up = parseUpcoming(r.upcoming_bookings).map((b) => ({
        checkin_date: b?.checkin_date || null,
        checkout_date: b?.checkout_date || null
      }))

      return {
        unit_id: r.unit_id,
        unit_code: r.unit_code,

        current_checkin_date: r.current_checkin_date || null,
        current_checkout_date: r.current_checkout_date || null,

        next_checkin_date: r.next_checkin_date || null,
        next_checkout_date: r.next_checkout_date || null,

        upcoming_bookings: up,

        total_days_completed: r.total_days_completed || 0
      }
    })

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(safeRows)
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: String(err?.message || err) })
    }
  }
}
