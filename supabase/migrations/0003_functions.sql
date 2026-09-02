-- ===========================================================================
-- Migración 0003 - Funciones RPC (cálculo de montos, finalización, auditoría)
--
-- * calculate_trip_amounts: cálculo 100% del lado del servidor (SECURITY
--   DEFINER). Valida la tarifa vigente para el contrato A LA FECHA del inicio
--   del viaje. Los conductores no tienen acceso a la tabla tarifas.
-- * finalize_trip: cierra el viaje (status 'finalizado'), fija montos y hace
--   inmutable el registro vía RLS + trigger.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Cálculo de montos (no expone tarifas: devuelve solo montos derivados)
-- ---------------------------------------------------------------------------
create or replace function public.calculate_trip_amounts(
  p_contract_id uuid,
  p_trip_type   public.trip_type,
  p_total_km    numeric,
  p_wait_secs   integer,
  p_as_of       date
) returns public.trip_amounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tarifa record;
  v_wait_min integer;
  r public.trip_amounts;
begin
  select t.valor_km, t.valor_min_espera, t.vigencia_desde
    into v_tarifa
    from public.tarifas t
   where t.contract_id = p_contract_id
     and t.tipo_viaje = p_trip_type
     and t.vigencia_desde <= p_as_of
   order by t.vigencia_desde desc
   limit 1;

  if not found then
    raise exception 'Trip 40002: no existe tarifa vigente para el contrato % en la fecha %',
      p_contract_id, p_as_of;
  end if;

  v_wait_min := ceil(p_wait_secs / 60.0)::int;
  r.tarifa_valor_km          := v_tarifa.valor_km;
  r.tarifa_valor_min_espera  := v_tarifa.valor_min_espera;
  r.tarifa_vigencia_desde    := v_tarifa.vigencia_desde;
  r.monto_km                 := round(p_total_km * v_tarifa.valor_km, 0);
  r.monto_espera             := round(v_wait_min * v_tarifa.valor_min_espera, 0);
  r.monto_total              := r.monto_km + r.monto_espera;
  return r;
end;
$$;

revoke all on function public.calculate_trip_amounts(uuid, public.trip_type, numeric, integer, date) from public;
grant execute on function public.calculate_trip_amounts(uuid, public.trip_type, numeric, integer, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Finalizar viaje (solo el conductor dueño; viajes finalizados immutables)
-- ---------------------------------------------------------------------------
create or replace function public.finalize_trip(p_trip_id uuid)
returns public.trip_amounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.trips%rowtype;
  r public.trip_amounts;
begin
  select * into v
    from public.trips
   where id = p_trip_id and driver_id = auth.uid()
   for update;

  if not found then
    raise exception 'Trip 40301: viaje no encontrado o no pertenece al conductor actual';
  end if;
  if v.status = 'finalizado' then
    raise exception 'Trip 40003: el viaje ya está finalizado';
  end if;

  r := public.calculate_trip_amounts(
         v.contract_id, v.trip_type, v.total_km, v.total_wait_seconds, v.start_time::date);

  update public.trips
     set end_time = now(),
         status = 'finalizado',
         tarifa_valor_km          = r.tarifa_valor_km,
         tarifa_valor_min_espera  = r.tarifa_valor_min_espera,
         tarifa_vigencia_desde    = r.tarifa_vigencia_desde,
         monto_km                 = r.monto_km,
         monto_espera             = r.monto_espera,
         monto_total              = r.monto_total
   where id = p_trip_id and driver_id = auth.uid();

  perform public.audit_event(
    'trip_finalizado', 'trips', p_trip_id,
    jsonb_build_object('monto_total', r.monto_total, 'total_km', v.total_km));
  return r;
end;
$$;

revoke all on function public.finalize_trip(uuid) from public;
grant execute on function public.finalize_trip(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Perfil propio del conductor (SOLO su propia fila; nunca datos de terceros)
-- ---------------------------------------------------------------------------
create or replace function public.my_profile()
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', d.id,
    'name', d.name,
    'rut', d.rut,
    'email', d.email,
    'active', d.active,
    'role', 'conductor'
  )
  from public.drivers d
  where d.id = auth.uid();
$$;

revoke all on function public.my_profile() from public;
grant execute on function public.my_profile() to authenticated;

-- ---------------------------------------------------------------------------
-- Contexto del conductor para el flujo de viaje:
-- contratos activos (datos mínimos, SIN tarifas ni RUT de clientes),
-- vehículos activos y su perfil.
-- ---------------------------------------------------------------------------
create or replace function public.get_driver_context()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  jsonb;
  v_vehicles jsonb;
  v_contracts jsonb;
begin
  select jsonb_build_object(
           'id', d.id, 'name', d.name, 'rut', d.rut,
           'email', d.email, 'active', d.active)
    into v_profile
    from public.drivers d
   where d.id = auth.uid();
  if v_profile is null then
    raise exception 'Trip 40302: perfil de conductor no encontrado';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'plate', v.plate, 'model', v.model) order by v.plate), '[]'::jsonb)
    into v_vehicles
    from public.vehicles v
   where v.active;

  select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', c.id,
              'name', c.name,
              'vigencia_desde', c.vigencia_desde,
              'pdf_path', c.pdf_path,
              'client_name', cl.name,
              'cecos', coalesce((
                 select jsonb_agg(jsonb_build_object('id', ce.id, 'name', ce.name) order by ce.name)
                   from public.cecos ce where ce.contract_id = c.id), '[]'::jsonb)
            ) order by c.name), '[]'::jsonb)
    into v_contracts
    from public.contracts c
    join public.clients cl on cl.id = c.client_id
   where c.status = 'activo';

  return jsonb_build_object('profile', v_profile, 'vehicles', v_vehicles, 'contracts', v_contracts);
end;
$$;

revoke all on function public.get_driver_context() from public;
grant execute on function public.get_driver_context() to authenticated;

-- ---------------------------------------------------------------------------
-- Auditoría manual (login/logout/exportaciones) con lista blanca de acciones.
-- ---------------------------------------------------------------------------
create or replace function public.audit_event(
  p_action       text,
  p_target_table text default null,
  p_target_id    uuid default null,
  p_metadata     jsonb default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_action not in (
     'login', 'logout', 'trip_finalizado',
     'client_create', 'client_delete', 'contract_create', 'contract_update',
     'tarifa_create', 'tarifa_update', 'driver_create', 'driver_update',
     'vehicle_create', 'vehicle_delete', 'user_create', 'user_delete',
     'report_export'
  ) then
    raise exception 'Audit 40005: acción no permitida (%)', p_action;
  end if;
  insert into public.audit_log (user_id, action, target_table, target_id, metadata)
  values (auth.uid(), p_action, p_target_table, p_target_id, p_metadata);
end;
$$;

revoke all on function public.audit_event(text, text, uuid, jsonb) from public;
grant execute on function public.audit_event(text, text, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Auditoría automática: cambios en tarifas y contratos (incluso si se hacen
-- fuera del panel). Las funciones son SECURITY DEFINER para poder escribir en
-- audit_log pese a que el cliente no tiene permiso directo sobre la tabla.
-- ---------------------------------------------------------------------------
create or replace function public.audit_tarifas_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_meta jsonb;
begin
  v_meta := jsonb_build_object(
     'contract_id',     coalesce(new.contract_id,     old.contract_id),
     'tipo_viaje',      coalesce(new.tipo_viaje,      old.tipo_viaje),
     'valor_km',        coalesce(new.valor_km,        old.valor_km),
     'valor_min_espera',coalesce(new.valor_min_espera, old.valor_min_espera),
     'vigencia_desde',  coalesce(new.vigencia_desde,  old.vigencia_desde));
  insert into public.audit_log (user_id, action, target_table, target_id, metadata)
  values (auth.uid(), lower(tg_op) || '_tarifa', 'tarifas', coalesce(new.id, old.id), v_meta);
  return coalesce(new, old);
end;
$$;

drop trigger if exists tarifas_audit on public.tarifas;
create trigger tarifas_audit
  after insert or update or delete on public.tarifas
  for each row execute function public.audit_tarifas_change();

create or replace function public.audit_contracts_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_meta jsonb;
begin
  v_meta := jsonb_build_object(
     'name',          coalesce(new.name,          old.name),
     'client_id',     coalesce(new.client_id,     old.client_id),
     'status',        coalesce(new.status::text,  old.status::text),
     'vigencia_desde',coalesce(new.vigencia_desde, old.vigencia_desde));
  insert into public.audit_log (user_id, action, target_table, target_id, metadata)
  values (auth.uid(), lower(tg_op) || '_contract', 'contracts', coalesce(new.id, old.id), v_meta);
  return coalesce(new, old);
end;
$$;

drop trigger if exists contracts_audit on public.contracts;
create trigger contracts_audit
  after insert or update or delete on public.contracts
  for each row execute function public.audit_contracts_change();