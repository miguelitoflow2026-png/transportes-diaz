-- 0009_finalize_km_authoritative.sql
-- Hace que finalize_trip recalcule total_km desde trip_positions (Haversine sum), no desde el valor cliente-spoofeable
-- Aplicar manualmente en Supabase Dashboard > SQL Editor o vía CLI

drop function if exists public.finalize_trip(uuid);

create function public.finalize_trip(p_trip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trip record;
  v_amounts public.trip_amounts;
  v_recalc_km numeric(10,2);
begin
  select * into v_trip from public.trips
  where id = p_trip_id and driver_id = auth.uid() and status != 'finalizado'
  for update;

  if not found then
    raise exception 'Trip 40401: viaje no encontrado o no autorizado';
  end if;

  -- Recalcular km de forma autoritativa desde posiciones reales (Haversine sum)
  select coalesce(round(sum(
    6371000 * 2 * asin(
      sqrt(
        sin(radians(sub.lat - sub.prev_lat) / 2) ^ 2
        + cos(radians(sub.prev_lat)) * cos(radians(sub.lat)) * sin(radians(sub.lon - sub.prev_lon) / 2) ^ 2
      )
    ) / 1000
  ) * 100) / 100, 0)
  into v_recalc_km
  from (
    select lat, lon, recorded_at,
           lag(lat) over (order by recorded_at) as prev_lat,
           lag(lon) over (order by recorded_at) as prev_lon
    from public.trip_positions where trip_id = p_trip_id
  ) sub
  where sub.prev_lat is not null;

  if v_recalc_km is not null and v_recalc_km > 0 then
    v_trip.total_km := v_recalc_km;
  end if;

  select * into v_amounts from public.calculate_trip_amounts(
    v_trip.contract_id, v_trip.trip_type, v_trip.total_km, v_trip.total_wait_seconds, v_trip.start_time::date
  );

  update public.trips set
    status = 'finalizado',
    end_time = now(),
    total_km = v_trip.total_km,
    tarifa_valor_km = v_amounts.tarifa_valor_km,
    tarifa_valor_min_espera = v_amounts.tarifa_valor_min_espera,
    tarifa_vigencia_desde = v_amounts.tarifa_vigencia_desde,
    monto_km = v_amounts.monto_km,
    monto_espera = v_amounts.monto_espera,
    monto_total = v_amounts.monto_total,
    updated_at = now()
  where id = p_trip_id
  returning * into v_trip;

  perform public.audit_event('trip_finalize', 'trips', p_trip_id, jsonb_build_object('total_km', v_trip.total_km, 'monto_total', v_trip.monto_total));

  return to_jsonb(v_trip);
end;
$$;

revoke all on function public.finalize_trip(uuid) from public;
grant execute on function public.finalize_trip(uuid) to authenticated;
