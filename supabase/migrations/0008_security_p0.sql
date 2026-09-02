-- 0008_security_p0.sql
-- P0 Seguridad: search_path + RLS trip_positions + constraints
-- Aplicar manualmente en Supabase Dashboard > SQL Editor o vía CLI

-- 1) Fix search_path en funciones vulnerables a injection (0001, 0002, 0006)
--    Todas pasan a SET search_path = public, pg_temp

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.auth_role()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '');
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.auth_role() = 'admin';
$$;

create or replace function public.is_driver()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.auth_role() = 'conductor';
$$;

create or replace function public.prevent_edit_finalized_trip()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'finalizado' then
    raise exception 'Trip 40001: el viaje ya está finalizado y no puede modificarse';
  end if;
  return new;
end;
$$;

-- 2) RLS trip_positions: restringir a authenticated (antes era PUBLIC)
drop policy if exists "conductor_insert_own_positions" on public.trip_positions;
create policy "conductor_insert_own_positions" on public.trip_positions
  for insert to authenticated with check (driver_id = auth.uid());

drop policy if exists "conductor_select_own_positions" on public.trip_positions;
create policy "conductor_select_own_positions" on public.trip_positions
  for select to authenticated using (driver_id = auth.uid());

drop policy if exists "admin_all_positions" on public.trip_positions;
create policy "admin_all_positions" on public.trip_positions
  for all to authenticated using (exists (select 1 from public.admin_users where id = auth.uid()))
  with check (exists (select 1 from public.admin_users where id = auth.uid()));

-- 3) Constraints faltantes en trips
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'trips_total_km_check') then
    alter table public.trips add constraint trips_total_km_check check (total_km >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'trips_total_wait_check') then
    alter table public.trips add constraint trips_total_wait_check check (total_wait_seconds >= 0);
  end if;
end $$;

-- 4) Fix search_path en RPCs de trip_positions (0006) — se redefinen con search_path seguro
--    Nota: se mantienen como SECURITY DEFINER y validan auth.uid()

create or replace function public.record_trip_position(
  p_trip_id uuid,
  p_lat double precision,
  p_lon double precision,
  p_accuracy double precision default null,
  p_altitude double precision default null,
  p_speed double precision default null,
  p_heading double precision default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trip record;
  v_last_pos record;
  v_dist_m double precision;
  v_new_total_km numeric(10,2);
  v_km_before numeric(10,2);
begin
  select * into v_trip from public.trips
  where id = p_trip_id and driver_id = auth.uid() and status != 'finalizado';
  if not found then return jsonb_build_object('error', 'Viaje no encontrado o no autorizado'); end if;
  select lat, lon into v_last_pos from public.trip_positions where trip_id = p_trip_id order by recorded_at desc limit 1;
  insert into public.trip_positions (trip_id, driver_id, lat, lon, accuracy, altitude, speed, heading, recorded_at)
  values (p_trip_id, auth.uid(), p_lat, p_lon, p_accuracy, p_altitude, p_speed, p_heading, now());
  if v_last_pos is not null then
    v_dist_m := 6371000 * 2 * asin(sqrt(sin(radians(p_lat - v_last_pos.lat) / 2) ^ 2 + cos(radians(v_last_pos.lat)) * cos(radians(p_lat)) * sin(radians(p_lon - v_last_pos.lon) / 2) ^ 2));
    v_km_before := coalesce(v_trip.total_km, 0);
    v_new_total_km := round((v_km_before + v_dist_m / 1000) * 100) / 100;
    update public.trips set total_km = v_new_total_km, updated_at = now() where id = p_trip_id;
    return jsonb_build_object('ok', true, 'distance_m', round(v_dist_m), 'total_km', v_new_total_km);
  else
    return jsonb_build_object('ok', true, 'distance_m', 0, 'total_km', coalesce(v_trip.total_km, 0));
  end if;
end;
$$;

create or replace function public.get_trip_route(p_trip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_trip record; v_positions jsonb;
begin
  select 1 into v_trip from public.trips where id = p_trip_id and driver_id = auth.uid();
  if not found then return jsonb_build_object('error', 'Viaje no encontrado o no autorizado'); end if;
  select jsonb_agg(jsonb_build_object('lat', lat, 'lon', lon, 'accuracy', accuracy, 'altitude', altitude, 'speed', speed, 'heading', heading, 'recorded_at', recorded_at) order by recorded_at)
  into v_positions from public.trip_positions where trip_id = p_trip_id;
  return jsonb_build_object('trip_id', p_trip_id, 'positions', coalesce(v_positions, '[]'::jsonb));
end;
$$;

create or replace function public.get_trip_last_position(p_trip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_trip record; v_pos record;
begin
  select * into v_trip from public.trips where id = p_trip_id and driver_id = auth.uid() and status != 'finalizado';
  if not found then return jsonb_build_object('error', 'Viaje no encontrado o no autorizado'); end if;
  select lat, lon, accuracy, altitude, speed, heading, recorded_at into v_pos from public.trip_positions where trip_id = p_trip_id order by recorded_at desc limit 1;
  if v_pos is null then return jsonb_build_object('trip_id', p_trip_id, 'has_position', false); end if;
  return jsonb_build_object('trip_id', p_trip_id, 'has_position', true, 'lat', v_pos.lat, 'lon', v_pos.lon, 'accuracy', v_pos.accuracy, 'altitude', v_pos.altitude, 'speed', v_pos.speed, 'heading', v_pos.heading, 'recorded_at', v_pos.recorded_at);
end;
$$;

create or replace function public.set_trip_positions_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin new.created_at = now(); return new; end;
$$;
