-- ===========================================================================
-- Migración 0005 - Historial del conductor vía RPC
--
-- El conductor NO tiene SELECT sobre contracts/cecos (RLS, migración 0002).
-- Un embed del tipo select('*, contracts(name), cecos(name)') devolvería
-- nombres NULL para el conductor. Por eso el historial se sirve con una
-- función SECURITY DEFINER que devuelve SOLO sus propios viajes finalizados,
-- con el nombre del contrato (sin RUT ni tarifas ni datos de otras tablas).
-- ===========================================================================

create or replace function public.get_my_trips()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',                 t.id,
      'contract_name',      c.name,
      'trip_type',          t.trip_type,
      'start_time',         t.start_time,
      'end_time',           t.end_time,
      'total_km',           t.total_km,
      'total_wait_seconds', t.total_wait_seconds,
      'monto_total',        t.monto_total
    ) order by t.start_time desc), '[]'::jsonb)
    into v
    from public.trips t
    left join public.contracts c on c.id = t.contract_id
   where t.driver_id = auth.uid()
     and t.status = 'finalizado';
  return v;
end;
$$;

revoke all on function public.get_my_trips() from public;
grant execute on function public.get_my_trips() to authenticated;