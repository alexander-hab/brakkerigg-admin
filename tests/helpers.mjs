import { readFile } from "node:fs/promises"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"

const root = fileURLToPath(new URL("../", import.meta.url))

export const admin = { clientContext: { user: { id: "admin", app_metadata: { roles: ["admin"] } } } }
export const viewer = { clientContext: { user: { id: "viewer", app_metadata: { roles: [] } } } }
export const dates = { checkin_date: "2026-10-05", checkout_date: "2026-10-12" }
export const post = (body) => ({ httpMethod: "POST", body: JSON.stringify(body) })

export async function createEnvironment() {
  const db = new PGlite()
  await db.exec(`
    create table units (id serial primary key, unit_code text not null);
    create table bookings (
      id serial primary key, unit_id integer references units,
      tenant_name text, company text, tenant_email text, tenant_phone text,
      checkin_date date, checkout_date date, status text
    );
    create table booking_requests (
      id serial primary key, requested_by_user_id text, requested_by_email text,
      requester_email text, requester_phone text
    );
    create table booking_request_lines (
      id serial primary key, request_id integer references booking_requests,
      unit_id integer references units, tenant_name text, company text, comment text,
      checkin_date date, checkout_date date, status text,
      decided_at timestamptz, decided_by_user_id text, approved_booking_id integer
    );
    insert into units (unit_code) values ('101'), ('102');
  `)
  const env = { db, beforeQuery: null, emails: [] }
  const sql = async (strings, ...params) => {
    const query = strings.reduce((s, part, i) => s + (i ? "$" + i : "") + part, "")
    if (env.beforeQuery) await env.beforeQuery(query, params)
    return (await db.query(query, params)).rows
  }
  env.sql = sql
  const context = vm.createContext({ process: { env: { DATABASE_URL: "test" } }, console })
  const modules = new Map()
  async function loadModule(filename) {
    if (modules.has(filename)) return modules.get(filename)
    let mod
    if (filename === "@netlify/neon") {
      mod = new vm.SyntheticModule(["neon"], function () { this.setExport("neon", () => sql) }, { context })
    } else if (filename.endsWith("_emailjs.mjs")) {
      mod = new vm.SyntheticModule(["sendEmailjsEmail"], function () {
        this.setExport("sendEmailjsEmail", async (email) => { env.emails.push(email) })
      }, { context })
    } else {
      mod = new vm.SourceTextModule(await readFile(filename, "utf8"), { context, identifier: filename })
    }
    modules.set(filename, mod)
    await mod.link((specifier, parent) => loadModule(specifier === "@netlify/neon" ? specifier : path.resolve(path.dirname(parent.identifier), specifier)))
    return mod
  }
  env.load = async (name) => {
    const mod = await loadModule(path.join(root, "netlify/functions", name + ".mjs"))
    if (mod.status !== "evaluated") await mod.evaluate()
    return mod.namespace
  }
  env.call = async (name, event, user = viewer) => (await env.load(name)).handler(event, user)
  return env
}
