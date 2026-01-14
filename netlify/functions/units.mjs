import { neon } from "@netlify/neon"

export const handler = async (event, context) => {
  try {
    const user = context?.clientContext?.user
    const roles = (user?.app_metadata?.roles) || []
    const lowerRoles = Array.isArray(roles) ? roles.map(r => String(r).toLowerCase()) : []
    const isAdmin = user && lowerRoles.includes("admin")

    if (!isAdmin) {
      return { statusCode: 403, body: "Forbidden" }
    }

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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rows)
    }
  } catch (err) {
    return { statusCode: 500, body: String(err?.message || err) }
  }
}
