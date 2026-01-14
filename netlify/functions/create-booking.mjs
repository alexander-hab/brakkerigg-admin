import { neon } from "@netlify/neon"

function daysBetween(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  const diff = Math.round((db - da) / (1000 * 60 * 60 * 24))
  return Number.isFinite(diff) ? diff : 0
}

export default async (req, context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 })

  const user = context && context.clientContext && context.clientContext.user
  const roles = (user && user.app_metadata && user.app_metadata.roles) || []
  if (!user || !roles.includes("admin")) return new Response("Forbidden", { status: 403 })

  let body
  try {
    body = await req.json()
  } catch {
    return new Response("Ugyldig JSON", { status: 400 })
  }

  const unitId = Number(body.unit_id)
  const tenantName = (body.tenant_name || "").trim()
  const company = (body.company || "").trim()
  const checkin = body.checkin_date
  const checkout = body.checkout_date

  if (!Number.isFinite(unitId) || unitId <= 0 || !checkin || !checkout) {
    return new Response("Mangler felt", { status: 400 })
  }

  if (new Date(checkin) >= new Date(checkout)) {
    return new Response("Ugyldig dato", { status: 400 })
  }

  if (daysBetween(checkin, checkout) < 7) return new Response("Minimum leieperiode er 7 netter", { status: 400 })

  const sql = neon(process.env.DATABASE_URL)

  const overlap = await sql`
    select id
    from bookings
    where unit_id = ${unitId}
      and status <> 'cancelled'
      and checkin_date < ${checkout}
      and checkout_date > ${checkin}
    limit 1
  `

  if (overlap.length > 0) return new Response("Datoer overlapper eksisterende booking", { status: 409 })

  const inserted = await sql`
    insert into bookings (unit_id, tenant_name, company, checkin_date, checkout_date, status)
    values (${unitId}, ${tenantName}, ${company}, ${checkin}, ${checkout}, 'booked')
    returning id
  `

  return Response.json({ booking_id: inserted[0].id })
}
