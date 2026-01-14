import { neon } from "@netlify/neon"

function base64UrlToJson(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4)
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/")
  const txt = Buffer.from(b64, "base64").toString("utf8")
  return JSON.parse(txt)
}

function getTokenFromHeaders(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim()

  const cookie = event.headers?.cookie || event.headers?.Cookie
  if (!cookie) return null

  const m = cookie.match(/(?:^|;\s*)nf_jwt=([^;]+)/)
  return m ? m[1] : null
}

function getRolesFromContext(context) {
  const user = context?.clientContext?.user
  const roles = user?.app_metadata?.roles
  if (Array.isArray(roles)) return roles.map((r) => String(r).toLowerCase())
  return []
}

function getRolesFromToken(token) {
  if (!token) return []
  const parts = token.split(".")
  if (parts.length < 2) return []
  try {
    const payload = base64UrlToJson(parts[1])
    const roles = payload?.app_metadata?.roles
    if (Array.isArray(roles)) return roles.map((r) => String(r).toLowerCase())
    return []
  } catch {
    return []
  }
}

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function daysBetween(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  return Math.round((db - da) / (1000 * 60 * 60 * 24))
}

export const handler = async (event, context) => {
  const token = getTokenFromHeaders(event)
  const roles = [
    ...getRolesFromContext(context),
    ...getRolesFromToken(token)
  ]

  const isAdmin = roles.includes("admin")
  if (!isAdmin) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Forbidden",
        roles_found: [...new Set(roles)]
      })
    }
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" }
  }

  let body = {}
  try {
    body = event.body ? JSON.parse(event.body) : {}
  } catch {
    return { statusCode: 400, body: "Ugyldig JSON" }
  }

  const unitId = Number(body.unit_id)
  const tenantName = (body.tenant_name || "").trim()
  const company = (body.company || "").trim()
  const checkin = body.checkin_date
  const checkout = body.checkout_date

  if (!unitId || !isIsoDate(checkin) || !isIsoDate(checkout)) {
    return { statusCode: 400, body: "Ugyldig input" }
  }

  const len = daysBetween(checkin, checkout)
  if (!Number.isFinite(len) || len < 7) {
    return { statusCode: 400, body: "Minimum leieperiode er 7 netter" }
  }

  try {
    const sql = neon()

    const conflict = await sql`
      select 1
      from bookings
      where unit_id = ${unitId}
        and status <> 'cancelled'
        and checkin_date < ${checkout}::date
        and checkout_date > ${checkin}::date
      limit 1;
    `
    if (conflict.length > 0) {
      return { statusCode: 409, body: "Konflikt. Enheten er allerede booket i perioden" }
    }

    const inserted = await sql`
      insert into bookings (unit_id, tenant_name, company, checkin_date, checkout_date, status)
      values (${unitId}, ${tenantName || null}, ${company || null}, ${checkin}::date, ${checkout}::date, 'booked')
      returning id;
    `

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, id: inserted[0]?.id })
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: String(err?.message || err)
    }
  }
}
