import { neon } from "@netlify/neon"
import { userIsAdmin } from "./_roles.mjs"
import { ensureUnitAvailability } from "./_unit-availability.mjs"

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  }
}

export const handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed" })
    const user = context?.clientContext?.user || null
    if (!user) return response(401, { error: "Unauthorized" })
    if (!userIsAdmin(user)) return response(403, { error: "Ingen tilgang" })

    let body
    try { body = JSON.parse(event.body || "{}") } catch { return response(400, { error: "Ugyldig JSON" }) }
    const unitId = Number(body?.unit_id)
    if (!Number.isSafeInteger(unitId) || unitId <= 0 || typeof body?.is_available !== "boolean") {
      return response(400, { error: "Velg en enhet og gyldig tilgjengelighet" })
    }

    const sql = neon(process.env.DATABASE_URL)
    await ensureUnitAvailability(sql)
    const rows = await sql`
      update units set is_available = ${body.is_available}
      where id = ${unitId}
      returning id as unit_id, unit_code, is_available;
    `
    if (!rows.length) return response(404, { error: "Fant ikke enheten" })
    return response(200, { ok: true, unit: rows[0] })
  } catch (err) {
    console.error("Klarte ikke å endre romtilgjengelighet", err)
    return response(500, { error: "Klarte ikke å endre tilgjengeligheten. Prøv igjen." })
  }
}
