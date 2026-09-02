-- ===========================================================================
-- Migración 0004 - Storage privado de PDF de contratos
--
-- Bucket privado (no público). Los archivos SOLO se descargan mediante URLs
-- firmadas de corta duración (supabase.storage.createSignedUrl).
--  * admin: subir/leer/borrar.
--  * conductor: puede firmar URL (leer) de un PDF — como en el prototipo,
--    en que el conductor consulta el contrato. No puede listar ni subir.
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('contracts-pdf', 'contracts-pdf', false)
on conflict (id) do nothing;

drop policy if exists "contracts_pdf_admin_all" on storage.objects;
create policy "contracts_pdf_admin_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'contracts-pdf' and public.is_admin())
  with check (bucket_id = 'contracts-pdf' and public.is_admin());

drop policy if exists "contracts_pdf_driver_read" on storage.objects;
create policy "contracts_pdf_driver_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'contracts-pdf' and public.is_driver());

-- Convención de rutas: <contract_id>/<slug>.pdf
-- Ejemplo: 11111111-2222-3333-4444-555555555555/contrato_2026.pdf
comment on table public.contracts is
  'pdf_path apunta a un objeto del bucket contracts-pdf (ruta <contract_id>/<slug>.pdf)';