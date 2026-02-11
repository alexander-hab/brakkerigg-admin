import { neon } from "@netlify/neon"
import { userIsAdmin } from "./_roles.mjs"

function isAdminFromContext(context) {
  const user = context?.clientContext?.user || null
  return userIsAdmin(user)
}

function text(statusCode, msg) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: msg || ""
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  }
}

export const handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") return text(405, "Method not allowed")

    if (!isAdminFromContext(context)) {
      return text(403, "Forbidden")
    }

    let body = {}
    try {
      body = event.body ? JSON.parse(event.body) : {}
    } catch {
      return text(400, "Ugyldig JSON")
    }

    const bookingId = Number(body.booking_id)
    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return text(400, "Mangler booking_id")
    }

    const sql = neon(process.env.DATABASE_URL)

    const cancelled = await sql`
      update bookings
      set status = 'cancelled'
      where id = ${bookingId}
        and status <> 'cancelled'
      returning id, unit_id;
    `

    if (cancelled.length === 0) {
      const exists = await sql`
        select id, status
        from bookings
        where id = ${bookingId}
        limit 1;
      `
      if (exists.length === 0) return text(404, "Booking finnes ikke")
      return json(200, { ok: true, already_cancelled: true, id: exists[0].id })
    }

    return json(200, { ok: true, cancelled: true, id: cancelled[0].id, unit_id: cancelled[0].unit_id })
  } catch (err) {
    return text(500, String(err?.message || err))
  }
}
