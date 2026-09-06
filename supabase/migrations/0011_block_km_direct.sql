-- 0011_block_km_direct.sql
-- Bloquea UPDATE directo de total_km desde cliente (solo RPC y finalize pueden tocarlo)
-- Mitiga bypass RLS donde conductor spoofeaba km via updateTrip({total_km})

create or replace function public.prevent_direct_km_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Permitir si es SECURITY DEFINER (record_trip_position / finalize_trip lo son, bypass RLS y trigger con rol postgres)
  -- Para cliente directo (authenticated, driver), bloquear si intenta cambiar total_km
  if new.total_km is distinct from old.total_km then
    -- Si el caller es el owner del viaje pero no vía RPC, es spoof
    -- Los RPCs son SECURITY DEFINER y corren como postgres, no como authenticated driver
    -- Chequeamos si la sesión es de un driver intentando cambiar km fuera de RPC
    if auth.uid() = old.driver_id and old.status != 'finalizado' then
      raise exception 'Trip 40002: total_km solo puede actualizarse vía GPS (record_trip_position) o finalize_trip';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trips_prevent_direct_km on public.trips;
create trigger trips_prevent_direct_km
  before update of total_km on public.trips
  for each row execute function public.prevent_direct_km_update();
