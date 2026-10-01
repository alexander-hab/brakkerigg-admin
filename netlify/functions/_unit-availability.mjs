// Install once per function instance. Existing rooms remain available by default.
let setupPromise = null

export async function ensureUnitAvailability(sql) {
  if (!setupPromise) {
    setupPromise = sql`
      do $migration$
      begin
        if exists (
          select 1 from pg_trigger
          where tgrelid = 'bookings'::regclass
            and tgname = 'bookings_require_available_unit' and not tgisinternal
        ) and exists (
          select 1 from pg_trigger
          where tgrelid = 'booking_request_lines'::regclass
            and tgname = 'requests_require_available_unit' and not tgisinternal
        ) then
          return;
        end if;

        -- Serialize first-time setup across independently deployed functions.
        perform pg_advisory_xact_lock(184297, 1);
        alter table units add column if not exists is_available boolean not null default true;

        create or replace function require_available_unit() returns trigger
        language plpgsql as $function$
        declare
          unit_available boolean;
        begin
          -- Existing bookings can still be corrected or shortened while blocked.
          if tg_table_name = 'bookings' and tg_op = 'UPDATE' then
            if old.status <> 'cancelled' and new.unit_id = old.unit_id
              and new.checkin_date >= old.checkin_date
              and new.checkout_date <= old.checkout_date then
              return new;
            end if;
          end if;

          -- This lock makes booking and blocking the same room mutually exclusive.
          select is_available into unit_available from units
          where id = new.unit_id for share;
          if not found then
            raise exception 'UNIT_NOT_FOUND' using errcode = 'P0001';
          end if;
          if not unit_available then
            raise exception 'UNIT_UNAVAILABLE' using errcode = 'P0001';
          end if;
          return new;
        end;
        $function$;

        drop trigger if exists bookings_require_available_unit on bookings;
        create trigger bookings_require_available_unit
          before insert or update of unit_id, checkin_date, checkout_date, status on bookings
          for each row when (new.status <> 'cancelled')
          execute function require_available_unit();

        drop trigger if exists requests_require_available_unit on booking_request_lines;
        create trigger requests_require_available_unit
          before insert or update of unit_id, checkin_date, checkout_date, status on booking_request_lines
          for each row when (new.status = 'pending')
          execute function require_available_unit();
      end;
      $migration$;
    `.catch((err) => {
      setupPromise = null
      throw err
    })
  }
  await setupPromise
}

export async function checkUnitAvailability(sql, unitId) {
  const rows = await sql`select id, is_available from units where id = ${unitId};`
  if (!rows.length) return { statusCode: 404, body: "Fant ikke enheten" }
  if (!rows[0].is_available) return { statusCode: 409, body: "Enheten er utilgjengelig for booking" }
  return null
}

export function unitAvailabilityError(err) {
  if (err?.code !== "P0001") return null
  if (err.message === "UNIT_UNAVAILABLE") {
    return { statusCode: 409, headers: { "Cache-Control": "no-store" }, body: "Enheten er utilgjengelig for booking" }
  }
  if (err.message === "UNIT_NOT_FOUND") {
    return { statusCode: 404, headers: { "Cache-Control": "no-store" }, body: "Fant ikke enheten" }
  }
  return null
}
