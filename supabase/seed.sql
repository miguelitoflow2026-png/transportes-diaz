-- =============================================================================
-- Transportes Díaz SpA — SEED DE DESARROLLO / PRUEBAS
-- =============================================================================
-- ADVERTENCIA: este archivo es SOLO para desarrollo y pruebas. NO lo uses en
-- producción ni lo ejecutes en un proyecto con datos reales.
--
-- Contiene exclusivamente DATOS MAESTROS (clientes, contratos, CECOs, tarifas y
-- vehículos). NO crea usuarios ni contraseñas: los usuarios se crean con el
-- Backoffice (Edge Function create-user) o en Authentication → Users del
-- dashboard, y eso también conecta la fila en drivers/admin_users.
--
-- Es idempotente: puedes ejecutarlo cuantas veces quieras.
--
-- Cómo ejecutarlo: en el SQL Editor del dashboard (después de aplicar 0001-0004),
-- o con la CLI:  supabase db push   (solo si usas supabase link/local).
-- =============================================================================

do $$
declare
  v_client_minera   uuid;
  v_client_imports  uuid;
  v_contract_planta uuid;
  v_contract_movil  uuid;
begin

  -- 1) Clientes ---------------------------------------------------------------
  insert into public.clients (name, rut)
  values ('Minera Andina SpA', '76.123.456-7')
  on conflict (rut) do nothing;

  insert into public.clients (name, rut)
  values ('Imports del Pacífico SpA', '97.654.321-8')
  on conflict (rut) do nothing;

  select id into v_client_minera   from public.clients where rut = '76.123.456-7';
  select id into v_client_imports  from public.clients where rut = '97.654.321-8';

  -- 2) Contratos + CECOs + tarifas versionadas ---------------------------------
  -- Para "Contrato Personal Planta" hay dos versiones de tarifa:
  --   v1 vigente desde 2026-06-01 y v2 (actual) desde 2026-08-01.
  -- Un viaje iniciado hoy usará automáticamente la v2 (tarifa vigente a la
  -- fecha de inicio del viaje), lo que permite probar el versionado.

  if not exists (
    select 1 from public.contracts
    where client_id = v_client_minera and name = 'Contrato Personal Planta'
  ) then
    insert into public.contracts (client_id, name, vigencia_desde)
    values (v_client_minera, 'Contrato Personal Planta', '2026-06-01')
    returning id into v_contract_planta;

    insert into public.cecos (contract_id, name) values
      (v_contract_planta, 'Operaciones Norte'),
      (v_contract_planta, 'Operaciones Sur');

    insert into public.tarifas (contract_id, tipo_viaje, valor_km, valor_min_espera, vigencia_desde) values
      (v_contract_planta, 'urbano',       900.00, 250.00, '2026-06-01'),
      (v_contract_planta, 'interurbano', 1100.00, 280.00, '2026-06-01'),
      (v_contract_planta, 'urbano',      1000.00, 300.00, '2026-08-01'),
      (v_contract_planta, 'interurbano', 1200.00, 320.00, '2026-08-01');
  end if;

  if not exists (
    select 1 from public.contracts
    where client_id = v_client_imports and name = 'Contrato Movilización Centro'
  ) then
    insert into public.contracts (client_id, name, vigencia_desde)
    values (v_client_imports, 'Contrato Movilización Centro', '2026-07-01')
    returning id into v_contract_movil;

    insert into public.cecos (contract_id, name) values
      (v_contract_movil, 'Santiago Centro');

    insert into public.tarifas (contract_id, tipo_viaje, valor_km, valor_min_espera, vigencia_desde) values
      (v_contract_movil, 'urbano',       950.00, 270.00, '2026-07-01'),
      (v_contract_movil, 'interurbano', 1150.00, 300.00, '2026-07-01');
  end if;

  -- 3) Vehículos ----------------------------------------------------------------
  insert into public.vehicles (plate, model) values ('TD-1015', 'Chery Tiggo 2')
  on conflict (plate) do nothing;
  insert into public.vehicles (plate, model) values ('TD-2187', 'Chery Tiggo 7')
  on conflict (plate) do nothing;

end $$;