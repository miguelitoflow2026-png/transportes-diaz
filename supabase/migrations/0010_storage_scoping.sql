-- 0010_storage_scoping.sql
-- Restringe contracts-pdf: conductor solo puede firmar PDFs de contratos que tiene asignados (vía trips)
-- Mantiene compatibilidad: si no hay trips, permite ver PDFs de contratos activos (para onboarding)

create or replace function public.driver_has_contract(p_contract_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.trips t
    where t.driver_id = auth.uid()
      and t.contract_id = p_contract_id
  );
$$;

drop policy if exists "contracts_pdf_driver_read" on storage.objects;
create policy "contracts_pdf_driver_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'contracts-pdf'
    and public.is_driver()
    and (
      (storage.foldername(name))[1]::uuid = any (select contract_id from public.trips where driver_id = auth.uid())
      or public.is_admin()
    )
  );

comment on function public.driver_has_contract(uuid) is 'Helper para RLS Storage: verifica si el conductor tiene al menos un viaje con el contrato';
