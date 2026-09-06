-- 0012_record_validation.sql
-- Añade validación server-side a record_trip_position para mitigar inyección de coordenadas falsas
-- Replica filtros de tracing.js: 0,0, NaN, fuera Chile, accuracy>50, salto>50km, velocidad>150km/h

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
  v_dt_sec double precision;
  v_speed_mps double precision;
  v_new_total_km numeric(10,2);
  v_km_before numeric(10,2);
begin
  -- Validación básica
  if p_lat is null or p_lon is null or p_lat = 0 and p_lon = 0 then
    return jsonb_build_object('error', 'Coordenadas nulas o (0,0) no permitidas');
  end if;
  if p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
    return jsonb_build_object('error', 'Coordenadas fuera de rango');
  end if;
  if p_lat < -56 or p_lat > -17 or p_lon < -76 or p_lon > -66 then
    return jsonb_build_object('error', 'Coordenadas fuera de Chile');
  end if;
  if p_accuracy is not null and p_accuracy > 50 then
    return jsonb_build_object('error', 'Accuracy muy baja (>50m)');
  end if;

  select * into v_trip from public.trips
  where id = p_trip_id and driver_id = auth.uid() and status != 'finalizado';
  if not found then return jsonb_build_object('error', 'Viaje no encontrado o no autorizado'); end if;

  select lat, lon, recorded_at into v_last_pos from public.trip_positions where trip_id = p_trip_id order by recorded_at desc limit 1;

  if v_last_pos is not null then
    v_dist_m := 6371000 * 2 * asin(sqrt(sin(radians(p_lat - v_last_pos.lat) / 2) ^ 2 + cos(radians(v_last_pos.lat)) * cos(radians(p_lat)) * sin(radians(p_lon - v_last_pos.lon) / 2) ^ 2));
    v_dt_sec := extract(epoch from (now() - v_last_pos.recorded_at));
    if v_dt_sec < 1 then v_dt_sec := 1; end if;
    v_speed_mps := v_dist_m / v_dt_sec;
    if v_dist_m > 50000 then
      return jsonb_build_object('error', 'Salto >50km entre puntos, posible outlier');
    end if;
    if v_speed_mps > 41.6 then
      return jsonb_build_object('error', 'Velocidad >150km/h no permitida');
    end if;
    if v_dist_m < 0.5 then
      return jsonb_build_object('error', 'Ruido GPS <0.5m');
    end if;
  end if;

  insert into public.trip_positions (trip_id, driver_id, lat, lon, accuracy, altitude, speed, heading, recorded_at)
  values (p_trip_id, auth.uid(), p_lat, p_lon, p_accuracy, p_altitude, p_speed, p_heading, now());

  if v_last_pos is not null then
    -- v_dist_m ya calculado arriba si había punto previo, recalcular si fue primer punto (v_last_pos null arriba no entra, pero si hay punto, ya está)
    if v_last_pos.lat is not null then
      v_dist_m := 6371000 * 2 * asin(sqrt(sin(radians(p_lat - v_last_pos.lat) / 2) ^ 2 + cos(radians(v_last_pos.lat)) * cos(radians(p_lat)) * sin(radians(p_lon - v_last_pos.lon) / 2) ^ 2));
    end if;
    v_km_before := coalesce(v_trip.total_km, 0);
    v_new_total_km := round((v_km_before + v_dist_m / 1000) * 100) / 100;
    update public.trips set total_km = v_new_total_km, updated_at = now() where id = p_trip_id;
    return jsonb_build_object('ok', true, 'distance_m', round(v_dist_m), 'total_km', v_new_total_km);
  else
    return jsonb_build_object('ok', true, 'distance_m', 0, 'total_km', coalesce(v_trip.total_km, 0));
  end if;
end;
$$;

revoke all on function public.record_trip_position(uuid, double precision, double precision, double precision, double precision, double precision, double precision) from public;
grant execute on function public.record_trip_position(uuid, double precision, double precision, double precision, double precision, double precision, double precision) to authenticated;
