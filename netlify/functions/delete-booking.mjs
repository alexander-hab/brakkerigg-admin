const { Pool } = require("pg")

let pool

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  }
  return pool
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }
}

function text(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: message || ""
  }
}

function hasAdminRole(user) {
  const roles = user && user.app_metadata && Array.isArray(user.app_metadata.roles)
    ? user.app_metadata.roles
    : []
  return roles.includes("admin") || roles.includes("Admin")
}

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") return text(405, "Method Not Allowed")

    const user = context && context.clientContext && context.clientContext.user
      ? context.clientContext.user
      : null

    if (!user) return text(401, "Not logged in")
    if (!hasAdminRole(user)) return text(403, "Forbidden")

    let body
    try {
      body = JSON.parse(event.body || "{}")
    } catch (e) {
      return text(400, "Invalid JSON")
    }

    const bookingId = Number(body.booking_id)
    if (!Number.isFinite(bookingId) || bookingId <= 0) return text(400, "Missing booking_id")

    const db = getPool()

    const res = await db.query(
      "DELETE FROM bookings WHERE id = $1 RETURNING id",
      [bookingId]
    )

    if (res.rowCount === 0) return text(404, "Booking not found")

    return json(200, { ok: true, deleted_id: res.rows[0].id })
  } catch (e) {
    return text(500, "Server error")
  }
}
