-- 0007_trip_state_machine.sql
-- Máquina de estados explícita + puntos inicio/fin + tiempo de pausa separado
-- Aplicar manualmente en Supabase Dashboard > SQL Editor o vía CLI

-- 1) Nuevo estado 'pausa' (pausado por el conductor, distinto de 'espera' por cliente)
--    Nota: ALTER TYPE ... ADD VALUE no puede correr dentro de transacción con otras juntas en algunas versiones,
--    por eso usamos IF NOT EXISTS para idempotencia.
do $$
begin
  if not exists (select 1 from pg_enum where enumlabel = 'pausa' and enumtypid = 'public.trip_status'::regtype) then
    alter type public.trip_status add value 'pausa';
  end if;
end
$$;

-- 2) Contador de pausa separado de espera (espera = billable, pausa = no billable)
alter table public.trips
  add column if not exists total_pause_seconds integer not null default 0
    check (total_pause_seconds >= 0);

-- 3) Puntos de inicio y fin geocodificados (Nominatim OSM)
--    jsonb: { lat: number, lon: number, display_name: text, address: text }
alter table public.trips
  add column if not exists punto_inicio jsonb,
  add column if not exists punto_fin jsonb;

comment on column public.trips.total_pause_seconds is 'Segundos acumulados en estado pausa (conductor pausó). Distinto de total_wait_seconds (espera por cliente, billable).';
comment on column public.trips.punto_inicio is 'Punto de inicio seleccionado por el conductor (geocodificado Nominatim): {lat, lon, display_name}';
comment on column public.trips.punto_fin is 'Punto de destino seleccionado por el conductor (geocodificado Nominatim): {lat, lon, display_name}';

-- 4) Índice para búsquedas por estado (útil para backoffice)
create index if not exists trips_status_idx on public.trips (status);

-- Nota: no se toca RLS. Las mismas políticas de trips aplican a las nuevas columnas.
-- finalize_trip() seguirá calculando monto solo sobre total_wait_seconds; pausa no se factura por defecto.
