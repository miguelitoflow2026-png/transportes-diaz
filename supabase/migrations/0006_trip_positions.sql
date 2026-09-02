-- 0006_trip_positions.sql
-- Tabla para almacenar la ruta GPS real de los viajes
-- Aplicar manualmente en Supabase Dashboard > SQL Editor

create table public.trip_positions (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references public.trips(id) on delete cascade,
  driver_id       uuid not null references auth.users(id) on delete cascade,
  lat             double precision not null,
  lon             double precision not null,
  accuracy        double precision,
  altitude        double precision,
  speed           double precision,
  heading         double precision,
  recorded_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- Índices para consultas rápidas de la ruta de un viaje
create index trip_positions_trip_idx on public.trip_positions (trip_id, recorded_at);
create index trip_positions_driver_idx on public.trip_positions (driver_id, recorded_at);

-- RLS: el conductor solo ve/inserta sus propias posiciones
alter table public.trip_positions enable row level security;

create policy "conductor_insert_own_positions" on public.trip_positions
  for insert with check (driver_id = auth.uid());

create policy "conductor_select_own_positions" on public.trip_positions
  for select using (driver_id = auth.uid());

-- Admin ve todo
create policy "admin_all_positions" on public.trip_positions
  for all using (
    exists (select 1 from public.admin_users where id = auth.uid())
  );

-- RPC para registrar posición (SECURITY DEFINER, calcula distancia y actualiza km en trips)
create or replace function public.record_trip_position(
  p_trip_id uuid,
  p_lat double precision,
  p_lon double precision,
  p_accuracy double precision default null,
  p_altitude double precision default null,
  p_speed double precision default null,
  p_heading double precision default null
) returns jsonb language plpgsql security definer as $$
declare
  v_trip record;
  v_last_pos record;
  v_dist_m double precision;
  v_new_total_km numeric(10,2);
  v_km_before numeric(10,2);
begin
  -- Verificar que el viaje existe y pertenece al conductor actual
  select * into v_trip
  from public.trips
  where id = p_trip_id
    and driver_id = auth.uid()
    and status != 'finalizado';

  if not found then
    return jsonb_build_object('error', 'Viaje no encontrado o no autorizado');
  end if;

  -- Obtener la última posición registrada para calcular distancia incremental
  select lat, lon into v_last_pos
  from public.trip_positions
  where trip_id = p_trip_id
  order by recorded_at desc
  limit 1;

  -- Insertar la nueva posición
  insert into public.trip_positions (trip_id, driver_id, lat, lon, accuracy, altitude, speed, heading, recorded_at)
  values (p_trip_id, auth.uid(), p_lat, p_lon, p_accuracy, p_altitude, p_speed, p_heading, now());

  -- Calcular distancia incremental si hay posición anterior
  if v_last_pos is not null then
    -- Fórmula Haversine (distancia en metros)
    v_dist_m := 6371000 * 2 * asin(
      sqrt(
        sin(radians(p_lat - v_last_pos.lat) / 2) ^ 2 +
        cos(radians(v_last_pos.lat)) * cos(radians(p_lat)) *
        sin(radians(p_lon - v_last_pos.lon) / 2) ^ 2
      )
    );
    -- Sumar al total_km existente (en km, redondeo 2 decimales)
    v_km_before := coalesce(v_trip.total_km, 0);
    v_new_total_km := round((v_km_before + v_dist_m / 1000) * 100) / 100;

    -- Actualizar total_km en trips
    update public.trips
    set total_km = v_new_total_km,
        updated_at = now()
    where id = p_trip_id;

    return jsonb_build_object(
      'ok', true,
      'distance_m', round(v_dist_m),
      'total_km', v_new_total_km
    );
  else
    -- Primera posición: no hay distancia incremental
    return jsonb_build_object(
      'ok', true,
      'distance_m', 0,
      'total_km', coalesce(v_trip.total_km, 0)
    );
  end if;
end;
$$;

-- RPC para obtener la ruta completa de un viaje (para el mapa/historial)
create or replace function public.get_trip_route(p_trip_id uuid)
returns jsonb language plpgsql security definer as $$
declare
  v_trip record;
  v_positions jsonb;
begin
  -- Verificar acceso
  select 1 into v_trip
  from public.trips
  where id = p_trip_id
    and driver_id = auth.uid();

  if not found then
    return jsonb_build_object('error', 'Viaje no encontrado o no autorizado');
  end if;

  select jsonb_agg(jsonb_build_object(
    'lat', lat, 'lon', lon, 'accuracy', accuracy, 'altitude', altitude,
    'speed', speed, 'heading', heading, 'recorded_at', recorded_at
  ) order by recorded_at)
  into v_positions
  from public.trip_positions
  where trip_id = p_trip_id;

  return jsonb_build_object(
    'trip_id', p_trip_id,
    'positions', coalesce(v_positions, '[]'::jsonb)
  );
end;
$$;

-- RPC para obtener la última posición de un viaje activo (para recuperación al volver)
create or replace function public.get_trip_last_position(p_trip_id uuid)
returns jsonb language plpgsql security definer as $$
declare
  v_trip record;
  v_pos record;
begin
  select * into v_trip
  from public.trips
  where id = p_trip_id
    and driver_id = auth.uid()
    and status != 'finalizado';

  if not found then
    return jsonb_build_object('error', 'Viaje no encontrado o no autorizado');
  end if;

  select lat, lon, accuracy, altitude, speed, heading, recorded_at
  into v_pos
  from public.trip_positions
  where trip_id = p_trip_id
  order by recorded_at desc
  limit 1;

  if v_pos is null then
    return jsonb_build_object('trip_id', p_trip_id, 'has_position', false);
  end if;

  return jsonb_build_object(
    'trip_id', p_trip_id,
    'has_position', true,
    'lat', v_pos.lat, 'lon', v_pos.lon,
    'accuracy', v_pos.accuracy,
    'altitude', v_pos.altitude,
    'speed', v_pos.speed,
    'heading', v_pos.heading,
    'recorded_at', v_pos.recorded_at
  );
end;
$$;

-- Trigger para updated_at en trip_positions (opcional, por si se actualiza)
create or replace function public.set_trip_positions_updated_at()
returns trigger language plpgsql as $$
begin
  new.created_at = now();
  return new;
end;
$$;

-- Comentario: la tabla trip_positions guarda cada punto GPS con precisión y timestamp.
-- El RPC record_trip_position calcula la distancia incremental con Haversine en el servidor
-- y actualiza trips.total_km atómicamente. El conductor SOLO inserta sus posiciones
-- (RLS insert with check). No puede borrar ni modificar posiciones ajenas.