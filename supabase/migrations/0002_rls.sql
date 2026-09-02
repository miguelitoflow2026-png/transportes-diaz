-- ===========================================================================
-- Migración 0002 - Row Level Security
--
-- Reglas:
--  * Ningún acceso anónimo: la clave anónima del cliente web NO puede leer nada
--    sin sesión (las policies usan auth.uid()/auth.jwt()).
--  * El rol se toma del claim app_metadata.role del JWT (definido al crear el
--    usuario vía la Edge Function create-user). Fuente única de verdad.
-- ===========================================================================

-- Helpers de rol (functions no definer -> respetan RLS; los claims del JWT no
-- dependen de tablas, por lo que no hay recursión).
create or replace function public.auth_role()
returns text
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '');
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select public.auth_role() = 'admin';
$$;

create or replace function public.is_driver()
returns boolean
language sql
stable
as $$
  select public.auth_role() = 'conductor';
$$;

-- ---------------------------------------------------------------------------
alter table public.clients     enable row level security;
alter table public.contracts   enable row level security;
alter table public.cecos       enable row level security;
alter table public.tarifas     enable row level security;
alter table public.drivers     enable row level security;
alter table public.admin_users enable row level security;
alter table public.vehicles    enable row level security;
alter table public.trips       enable row level security;
alter table public.audit_log   enable row level security;

-- ---------------------------------------------------------------------------
-- clients: solo admin
-- ---------------------------------------------------------------------------
drop policy if exists "clients_admin_all" on public.clients;
create policy "clients_admin_all" on public.clients
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- contracts: solo admin
-- ---------------------------------------------------------------------------
drop policy if exists "contracts_admin_all" on public.contracts;
create policy "contracts_admin_all" on public.contracts
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- cecos: solo admin (los conductores acceden vía RPC selectivo get_driver_context)
-- ---------------------------------------------------------------------------
drop policy if exists "cecos_admin_all" on public.cecos;
create policy "cecos_admin_all" on public.cecos
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- tarifas: solo admin. Base para el cálculo de montos del lado del servidor.
-- Los conductores NUNCA consultan esta tabla directamente.
-- ---------------------------------------------------------------------------
drop policy if exists "tarifas_admin_all" on public.tarifas;
create policy "tarifas_admin_all" on public.tarifas
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- drivers: admin gestiona todo; el conductor accede a su propio perfil solo
-- mediante RPC my_profile() (que devuelve únicamente su propia fila).
-- ---------------------------------------------------------------------------
drop policy if exists "drivers_admin_all" on public.drivers;
create policy "drivers_admin_all" on public.drivers
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- admin_users: solo admin.
-- ---------------------------------------------------------------------------
drop policy if exists "admin_users_admin_all" on public.admin_users;
create policy "admin_users_admin_all" on public.admin_users
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- vehicles: solo admin y conductores (necesitan elegir vehículo al crear viaje).
-- ---------------------------------------------------------------------------
drop policy if exists "vehicles_admin_all" on public.vehicles;
create policy "vehicles_admin_all" on public.vehicles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "vehicles_driver_select" on public.vehicles;
create policy "vehicles_driver_select" on public.vehicles
  for select to authenticated
  using (public.is_driver());

-- ---------------------------------------------------------------------------
-- trips:
--   * conductor: crea sus viajes, lee/mantiene actualizados los propios,
--     pero NO puede modificar (ni eliminar) viajes finalizados.
--   * admin: lectura completa + lo necesario para reportes.
-- ---------------------------------------------------------------------------
drop policy if exists "trips_driver_select" on public.trips;
create policy "trips_driver_select" on public.trips
  for select to authenticated
  using (public.is_driver() and driver_id = auth.uid());

drop policy if exists "trips_driver_insert" on public.trips;
create policy "trips_driver_insert" on public.trips
  for insert to authenticated
  with check (public.is_driver() and driver_id = auth.uid());

drop policy if exists "trips_driver_update_open" on public.trips;
create policy "trips_driver_update_open" on public.trips
  for update to authenticated
  using (public.is_driver() and driver_id = auth.uid() and status <> 'finalizado')
  with check (public.is_driver() and driver_id = auth.uid() and status <> 'finalizado');

drop policy if exists "trips_driver_delete_open" on public.trips;
create policy "trips_driver_delete_open" on public.trips
  for delete to authenticated
  using (public.is_driver() and driver_id = auth.uid() and status <> 'finalizado');

drop policy if exists "trips_admin_all" on public.trips;
create policy "trips_admin_all" on public.trips
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Guarda a nivel de base de datos: un viaje finalizado es inmutable.
create or replace function public.prevent_edit_finalized_trip()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'finalizado' then
    raise exception 'Trip 40001: el viaje ya está finalizado y no puede modificarse';
  end if;
  return new;
end;
$$;

drop trigger if exists trips_prevent_edit_finalized on public.trips;
create trigger trips_prevent_edit_finalized
  before update or delete on public.trips
  for each row execute function public.prevent_edit_finalized_trip();

-- ---------------------------------------------------------------------------
-- audit_log: nadie inserta/lee directamente desde el navegador;
-- solo las functions RPC (security definer) escriben. Lectura solo admin.
-- ---------------------------------------------------------------------------
drop policy if exists "audit_log_admin_select" on public.audit_log;
create policy "audit_log_admin_select" on public.audit_log
  for select to authenticated
  using (public.is_admin());

drop policy if exists "audit_log_no_client_write" on public.audit_log;
create policy "audit_log_no_client_write" on public.audit_log
  for insert to authenticated
  with check (false);