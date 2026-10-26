import assert from "node:assert/strict"
import { before, beforeEach, after, test } from "node:test"
import { createEnvironment, admin, viewer, dates, post } from "./helpers.mjs"
import { ensureUnitAvailability as upgradeAvailability } from "../netlify/functions/_unit-availability.mjs"

let env
before(async () => {
  env = await createEnvironment()
  await (await env.load("_unit-availability")).ensureUnitAvailability(env.sql)
})
beforeEach(async () => {
  env.beforeQuery = null
  env.emails.length = 0
  await env.db.exec(`
    truncate booking_request_lines, booking_requests, bookings restart identity;
    update units set is_available = true, unavailability_reason = '';
  `)
})
after(async () => { await env?.db.close() })

async function setAvailable(unitId, available) {
  return env.call("set-unit-availability", post({ unit_id: unitId, is_available: available }), admin)
}
async function count(table) {
  return (await env.db.query(`select count(*)::int as n from ${table}`)).rows[0].n
}

test("migration is repeatable and keeps all existing rooms available", async () => {
  await (await env.load("_unit-availability")).ensureUnitAvailability(env.sql)
  const response = await env.call("units", { httpMethod: "GET" })
  assert.equal(response.statusCode, 200)
  assert.ok(JSON.parse(response.body).rows.every((r) => r.is_available === true))
  const triggers = await env.db.query("select tgname from pg_trigger where tgname like '%require_available_unit'")
  assert.equal(triggers.rows.length, 2)
})

test("only assigned admin roles can change room availability", async () => {
  const event = post({ unit_id: 1, is_available: false })
  assert.equal((await env.call("set-unit-availability", event, {})).statusCode, 401)
  assert.equal((await env.call("set-unit-availability", event, viewer)).statusCode, 403)
  const spoofed = { clientContext: { user: { user_metadata: { roles: ["admin"] }, roles: ["admin"] } } }
  assert.equal((await env.call("set-unit-availability", event, spoofed)).statusCode, 403)
  assert.equal((await setAvailable(1, false)).statusCode, 200)
})

test("availability API validates requests and missing rooms", async () => {
  assert.equal((await env.call("set-unit-availability", { httpMethod: "GET" }, admin)).statusCode, 405)
  for (const body of [null, {}, { unit_id: 1, is_available: "false" }, { unit_id: 1.5, is_available: false }]) {
    assert.equal((await env.call("set-unit-availability", post(body), admin)).statusCode, 400)
  }
  assert.equal((await env.call("set-unit-availability", { httpMethod: "POST", body: "{" }, admin)).statusCode, 400)
  assert.equal((await setAvailable(999, false)).statusCode, 404)
})

test("comments are stored for admins and never returned to other users", async () => {
  const reason = "Mangler nøkkel.\nNy lås bestilt."
  const result = await env.call("set-unit-availability", post({ unit_id: 1, is_available: false, unavailability_reason: "  " + reason + "  " }), admin)
  assert.equal(result.statusCode, 200)
  assert.equal(JSON.parse(result.body).unit.unavailability_reason, reason)
  const adminRows = JSON.parse((await env.call("units", { httpMethod: "GET" }, admin)).body).rows
  assert.equal(adminRows[0].unavailability_reason, reason)
  const publicResponse = await env.call("units", { httpMethod: "GET" }, viewer)
  assert.equal(publicResponse.body.includes(reason), false)
  assert.ok(JSON.parse(publicResponse.body).rows.every(row => !Object.hasOwn(row, "unavailability_reason")))
  const unauthorized = await env.call("set-unit-availability", post({ unit_id: 1, is_available: false, unavailability_reason: "Endret" }), viewer)
  assert.equal(unauthorized.statusCode, 403)
  assert.equal((await env.db.query("select unavailability_reason from units where id = 1")).rows[0].unavailability_reason, reason)
})

test("an admin can edit or clear a comment while keeping the room blocked", async () => {
  for (const reason of ["Mangler nøkkel", "Nøkkel funnet. Venter på vask.", ""]) {
    const result = await env.call("set-unit-availability", post({ unit_id: 1, is_available: false, unavailability_reason: reason }), admin)
    assert.equal(result.statusCode, 200)
    assert.equal(JSON.parse(result.body).unit.is_available, false)
    assert.equal(JSON.parse(result.body).unit.unavailability_reason, reason)
  }
  assert.equal((await env.call("create-booking", post({ unit_id: 1, ...dates }), admin)).statusCode, 409)
})

test("reopening clears the old reason; older clients preserve comments when blocking", async () => {
  await env.call("set-unit-availability", post({ unit_id: 1, is_available: false, unavailability_reason: "Mangler nøkkel" }), admin)
  await setAvailable(1, false)
  assert.equal((await env.db.query("select unavailability_reason from units where id = 1")).rows[0].unavailability_reason, "Mangler nøkkel")
  await setAvailable(1, true)
  await setAvailable(1, false)
  assert.equal((await env.db.query("select unavailability_reason from units where id = 1")).rows[0].unavailability_reason, "")
})

test("invalid comments are rejected without changing room availability", async () => {
  for (const reason of [null, 42, {}, [], "x".repeat(1001), "null\u0000tegn"]) {
    const result = await env.call("set-unit-availability", post({ unit_id: 1, is_available: false, unavailability_reason: reason }), admin)
    assert.equal(result.statusCode, 400)
  }
  const row = (await env.db.query("select is_available, unavailability_reason from units where id = 1")).rows[0]
  assert.equal(row.is_available, true)
  assert.equal(row.unavailability_reason, "")
  assert.equal((await env.call("set-unit-availability", post({ unit_id: 1, is_available: false, unavailability_reason: "x".repeat(1000) }), admin)).statusCode, 200)
})

test("existing installations gain the comment column while preserving blocked rooms and triggers", async () => {
  await setAvailable(1, false)
  const triggersBefore = (await env.db.query("select oid, tgname from pg_trigger where tgname like '%require_available_unit' order by tgname")).rows
  await env.db.exec("alter table units drop column unavailability_reason")
  await upgradeAvailability(env.sql)
  await upgradeAvailability(env.sql)
  const row = (await env.db.query("select is_available, unavailability_reason from units where id = 1")).rows[0]
  assert.equal(row.is_available, false)
  assert.equal(row.unavailability_reason, "")
  const triggersAfter = (await env.db.query("select oid, tgname from pg_trigger where tgname like '%require_available_unit' order by tgname")).rows
  assert.deepEqual(triggersAfter, triggersBefore)
  assert.equal((await env.call("create-booking", post({ unit_id: 1, ...dates }), admin)).statusCode, 409)
})

test("blocking persists in room list and availability search; reopening restores it", async () => {
  await setAvailable(1, false)
  const units = JSON.parse((await env.call("units", { httpMethod: "GET" })).body).rows
  assert.equal(units.find((r) => r.unit_id === 1).is_available, false)
  const search = { httpMethod: "GET", queryStringParameters: dates }
  assert.deepEqual(JSON.parse((await env.call("available-units", search)).body).map((r) => r.unit_id), [2])
  await setAvailable(1, true)
  assert.deepEqual(JSON.parse((await env.call("available-units", search)).body).map((r) => r.unit_id), [1, 2])
})

test("ordinary users cannot request a blocked room, including mixed requests", async () => {
  await setAvailable(1, false)
  const res = await env.call("create-booking-request", post({ lines: [{ unit_id: 2, ...dates }, { unit_id: 1, ...dates }] }))
  assert.equal(res.statusCode, 409)
  assert.equal(await count("booking_requests"), 0)
  assert.equal(await count("booking_request_lines"), 0)
  assert.equal(env.emails.length, 0)
})

test("admin bookings are blocked until the room is reopened", async () => {
  await setAvailable(1, false)
  const event = post({ unit_id: 1, ...dates })
  assert.equal((await env.call("create-booking", event, admin)).statusCode, 409)
  await setAvailable(1, true)
  assert.equal((await env.call("create-booking", event, admin)).statusCode, 200)
  assert.equal(await count("bookings"), 1)
})

test("pending requests cannot be approved while blocked and can be approved after reopening", async () => {
  assert.equal((await env.call("create-booking-request", post({ lines: [{ unit_id: 1, ...dates }] }))).statusCode, 200)
  await setAvailable(1, false)
  const event = post({ line_id: 1, action: "approve" })
  assert.equal((await env.call("decide-booking-request-line", event, admin)).statusCode, 409)
  assert.equal(await count("bookings"), 0)
  assert.equal((await env.db.query("select status from booking_request_lines")).rows[0].status, "pending")
  await setAvailable(1, true)
  assert.equal((await env.call("decide-booking-request-line", event, admin)).statusCode, 200)
  assert.equal(await count("bookings"), 1)
})

test("blocked rooms do not prevent rejection of an old request", async () => {
  await env.call("create-booking-request", post({ lines: [{ unit_id: 1, ...dates }] }))
  await setAvailable(1, false)
  assert.equal((await env.call("decide-booking-request-line", post({ line_id: 1, action: "reject" }), admin)).statusCode, 200)
})

test("a room blocked after the availability check is still rejected by the database", async () => {
  env.beforeQuery = async (query) => {
    if (/^\s*insert into bookings/.test(query)) {
      env.beforeQuery = null
      await env.db.query("update units set is_available = false where id = 1")
    }
  }
  assert.equal((await env.call("create-booking", post({ unit_id: 1, ...dates }), admin)).statusCode, 409)
  assert.equal(await count("bookings"), 0)
})

test("a late block rolls back every line and header of a multi-room request", async () => {
  env.beforeQuery = async (query) => {
    if (/with request as/.test(query)) {
      env.beforeQuery = null
      await env.db.query("update units set is_available = false where id = 1")
    }
  }
  const event = post({ lines: [{ unit_id: 2, ...dates }, { unit_id: 1, ...dates }] })
  assert.equal((await env.call("create-booking-request", event)).statusCode, 409)
  assert.equal(await count("booking_requests"), 0)
  assert.equal(await count("booking_request_lines"), 0)
})

test("late block also prevents approval without changing pending state", async () => {
  await env.call("create-booking-request", post({ lines: [{ unit_id: 1, ...dates }] }))
  env.beforeQuery = async (query) => {
    if (/^\s*insert into bookings/.test(query)) {
      env.beforeQuery = null
      await env.db.query("update units set is_available = false where id = 1")
    }
  }
  const res = await env.call("decide-booking-request-line", post({ line_id: 1, action: "approve" }), admin)
  assert.equal(res.statusCode, 409)
  assert.equal(await count("bookings"), 0)
  assert.equal((await env.db.query("select status from booking_request_lines")).rows[0].status, "pending")
})

test("existing bookings survive blocking; extensions fail, corrections and cancellation work", async () => {
  await env.call("create-booking", post({ unit_id: 1, ...dates }), admin)
  await setAvailable(1, false)
  assert.equal(await count("bookings"), 1)
  const extend = post({ booking_id: 1, ...dates, checkout_date: "2026-10-19" })
  assert.equal((await env.call("update-booking", extend, admin)).statusCode, 409)
  const correct = post({ booking_id: 1, ...dates, tenant_name: "Ny leietaker" })
  assert.equal((await env.call("update-booking", correct, admin)).statusCode, 200)
  await setAvailable(1, true)
  const search = { httpMethod: "GET", queryStringParameters: dates }
  assert.deepEqual(JSON.parse((await env.call("available-units", search)).body).map((r) => r.unit_id), [2])
  await setAvailable(1, false)
  assert.equal((await env.call("delete-booking", post({ booking_id: 1 }), admin)).statusCode, 200)
})
