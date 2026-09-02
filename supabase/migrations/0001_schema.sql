-- ===========================================================================
-- Transportes Díaz SpA - Migración 0001
-- Esquema base (tablas, tipos, triggers internos)
-- Ejecutar en orden: 0001 -> 0002 -> 0003 -> 0004
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tipos compartidos
-- ---------------------------------------------------------------------------
create type public.trip_type as enum ('urbano', 'interurbano');
create type public.trip_status as enum ('conduccion', 'espera', 'finalizado');
create type public.contract_status as enum ('activo', 'inactivo');

-- Resultado del cálculo de montos (devuelto por el servidor, nunca por el navegador)
create type public.trip_amounts as (
  tarifa_valor_km         numeric(12,2),
  tarifa_valor_min_espera numeric(12,2),
  tarifa_vigencia_desde   date,
  monto_km                numeric(12,2),
  monto_espera            numeric(12,2),
  monto_total             numeric(12,2)
);

-- ---------------------------------------------------------------------------
-- Extensiones
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tablas maestras (admin-only por RLS, ver migración 0002)
-- ---------------------------------------------------------------------------
create table public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 2 and 160),
  rut        text not null unique check (rut ~ '^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$'),
  created_at timestamptz not null default now()
);

create table public.contracts (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete restrict,
  name           text not null check (char_length(name) between 2 and 200),
  status         public.contract_status not null default 'activo',
  vigencia_desde date not null,
  pdf_path       text,                      -- ruta del objeto en Storage (bucket privado)
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.cecos (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  unique (contract_id, name)
);

create table public.tarifas (
  id               uuid primary key default gen_random_uuid(),
  contract_id      uuid not null references public.contracts(id) on delete cascade,
  tipo_viaje       public.trip_type not null,
  valor_km         numeric(12,2) not null check (valor_km >= 0),
  valor_min_espera numeric(12,2) not null check (valor_min_espera >= 0),
  vigencia_desde   date not null,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  unique (contract_id, tipo_viaje, vigencia_desde)
);

create table public.drivers (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  rut        text not null unique check (rut ~ '^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$'),
  email      text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.admin_users (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  email      text not null unique,
  cargo      text,
  role       text not null default 'admin' check (role = 'admin'),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.vehicles (
  id         uuid primary key default gen_random_uuid(),
  plate      text not null unique,
  model      text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Viajes
-- ---------------------------------------------------------------------------
-- El viaje en curso se guarda aquí con status 'conduccion'/'espera'.
-- Al finalizar, la función public.finalize_trip() fija status 'finalizado',
-- end_time y los montos calculados del lado del servidor.
create table public.trips (
  id                     uuid primary key default gen_random_uuid(),
  driver_id              uuid not null references public.drivers(id) on delete restrict,
  vehicle_id             uuid not null references public.vehicles(id) on delete restrict,
  contract_id            uuid not null references public.contracts(id) on delete restrict,
  ceco_id                uuid not null references public.cecos(id) on delete restrict,
  trip_type              public.trip_type not null,
  status                 public.trip_status not null default 'conduccion',
  start_time             timestamptz not null default now(),
  end_time               timestamptz,
  total_km               numeric(10,2) not null default 0,
  total_wait_seconds     integer not null default 0,
  notes                  text check (char_length(notes) <= 2000),
  tarifa_valor_km        numeric(12,2),
  tarifa_valor_min_espera numeric(12,2),
  tarifa_vigencia_desde  date,
  monto_km               numeric(12,2),
  monto_espera           numeric(12,2),
  monto_total            numeric(12,2),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index trips_driver_idx   on public.trips (driver_id, start_time desc);
create index trips_contract_idx on public.trips (contract_id, start_time desc);

-- ---------------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  user_id      uuid references auth.users(id),
  action       text not null,
  target_table text,
  target_id    uuid,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_user_idx  on public.audit_log (user_id, created_at desc);
create index audit_log_action_idx on public.audit_log (action, created_at desc);

-- ---------------------------------------------------------------------------
-- Trigger compartido: updated_at
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger contracts_set_updated_at before update on public.contracts
  for each row execute function public.set_updated_at();
create trigger trips_set_updated_at before update on public.trips
  for each row execute function public.set_updated_at();