// Capa de acceso a datos vía supabase-js.
// Reemplaza el localStorage del prototipo: toda persistencia pasa por Supabase
// (RLS 100% del lado del servidor). Los montos nunca se calculan aquí.
import { supabase } from './supabase.js';
import { state } from './state.js';

export function uid() {
  return crypto.randomUUID();
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// ---------------------------------------------------------------------------
// Conductor
// ---------------------------------------------------------------------------
export async function loadDriverContext() {
  const data = unwrap(await supabase.rpc('get_driver_context'));
  state.driverContext = data;
  return data;
}

export async function fetchActiveTrip() {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .eq('driver_id', state.user.id)
    .neq('status', 'finalizado')
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  state.activeTrip = data || null;
  return data || null;
}

export async function createTrip(row) {
  const data = unwrap(
    await supabase
      .from('trips')
      .insert({ ...row, driver_id: state.user.id })
      .select()
      .single(),
  );
  state.activeTrip = data;
  return data;
}

export async function updateTrip(id, patch) {
  const data = unwrap(
    await supabase
      .from('trips')
      .update(patch)
      .eq('id', id)
      .eq('driver_id', state.user.id)
      .select()
      .single(),
  );
  state.activeTrip = data;
  return data;
}

export async function finalizeTrip(id) {
  return unwrap(await supabase.rpc('finalize_trip', { p_trip_id: id }));
}

export async function previewAmounts(contractId, tripType, km, waitSecs, asOf) {
  return unwrap(
    await supabase.rpc('calculate_trip_amounts', {
      p_contract_id: contractId,
      p_trip_type: tripType,
      p_total_km: km,
      p_wait_secs: waitSecs,
      p_as_of: asOf,
    }),
  );
}

export async function getMyTrips() {
  // Vía RPC SECURITY DEFINER: el conductor no tiene SELECT sobre contracts/cecos.
  return unwrap(await supabase.rpc('get_my_trips'));
}

export async function getContractPdfUrl(pdfPath, seconds = 300) {
  if (!pdfPath) return null;
  const { data } = await supabase.storage.from('contracts-pdf').createSignedUrl(pdfPath, seconds);
  return data?.signedUrl || null;
}

// ---------------------------------------------------------------------------
// Auditoría (login/logout/exportaciones)
// ---------------------------------------------------------------------------
export async function audit(action, targetTable = null, targetId = null, metadata = null) {
  await supabase.rpc('audit_event', {
    p_action: action,
    p_target_table: targetTable,
    p_target_id: targetId,
    p_metadata: metadata,
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
export async function adminListClients() {
  return unwrap(await supabase.from('clients').select('*').order('name'));
}
export async function adminAddClient(name, rut) {
  return unwrap(await supabase.from('clients').insert({ name, rut }).select().single());
}
export async function adminDeleteClient(id) {
  return unwrap(await supabase.from('clients').delete().eq('id', id));
}
export async function adminCountContractsForClient(clientId) {
  const { count, error } = await supabase
    .from('contracts')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);
  if (error) throw new Error(error.message);
  return count || 0;
}

export async function adminListContracts() {
  return unwrap(
    await supabase
      .from('contracts')
      .select('*, clients(name), cecos(id, name), tarifas(tipo_viaje, valor_km, valor_min_espera, vigencia_desde)')
      .order('name'),
  );
}
export async function adminInsertContract(row) {
  return unwrap(await supabase.from('contracts').insert(row).select().single());
}
export async function adminUpdateContract(id, patch) {
  return unwrap(await supabase.from('contracts').update(patch).eq('id', id).select().single());
}
export async function adminReplaceCecos(contractId, names) {
  const existing = unwrap(await supabase.from('cecos').select('id, name').eq('contract_id', contractId));
  const keep = [];
  const add = [];
  for (const n of names) {
    const hit = existing.find((e) => e.name === n);
    if (hit) keep.push(hit.id);
    else add.push({ contract_id: contractId, name: n });
  }
  if (add.length) await unwrap(supabase.from('cecos').insert(add));
  // Los CECOs removidos se conservan (histórico de viajes los sigue referenciando).
  return keep.concat(add.map(() => null)).filter(Boolean);
}
export async function adminUpsertTarifa(contractId, tipoViaje, values) {
  return unwrap(
    await supabase
      .from('tarifas')
      .upsert(
        {
          contract_id: contractId,
          tipo_viaje: tipoViaje,
          vigencia_desde: values.vigencia_desde,
          valor_km: values.valor_km,
          valor_min_espera: values.valor_min_espera,
        },
        { onConflict: 'contract_id,tipo_viaje,vigencia_desde' },
      )
      .select()
      .single(),
  );
}
export async function adminUploadPdf(path, file) {
  const { error } = await supabase.storage.from('contracts-pdf').upload(path, file, { upsert: true });
  if (error) throw new Error(error.message);
}

export async function adminListDrivers() {
  return unwrap(await supabase.from('drivers').select('*, trips(count)').order('name'));
}
export async function adminListVehicles() {
  return unwrap(await supabase.from('vehicles').select('*').order('plate'));
}
export async function adminAddVehicle(plate, model) {
  return unwrap(await supabase.from('vehicles').insert({ plate: plate.toUpperCase(), model }).select().single());
}
export async function adminDeleteVehicle(id) {
  return unwrap(await supabase.from('vehicles').delete().eq('id', id));
}

export async function adminCountTripsByDriver(driverId) {
  const { count, error } = await supabase
    .from('trips')
    .select('id', { count: 'exact', head: true })
    .eq('driver_id', driverId);
  if (error) throw new Error(error.message);
  return count || 0;
}

export async function adminCountTripsByVehicle(vehicleId) {
  const { count, error } = await supabase
    .from('trips')
    .select('id', { count: 'exact', head: true })
    .eq('vehicle_id', vehicleId);
  if (error) throw new Error(error.message);
  return count || 0;
}

export async function adminFetchTrips(filters) {
  let q = supabase
    .from('trips')
    .select('*, contracts(id, client_id, name, clients(name)), cecos(name), drivers(name), vehicles(plate)')
    .order('start_time', { ascending: false });
  if (filters.contractId) q = q.eq('contract_id', filters.contractId);
  if (filters.driverId) q = q.eq('driver_id', filters.driverId);
  if (filters.from) q = q.gte('start_time', filters.from);
  if (filters.to) q = q.lte('start_time', filters.to + 'T23:59:59');
  const { data, error } = await q.limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function invokeCreateUser(payload) {
  const { data, error } = await supabase.functions.invoke('create-user', { body: payload });
  if (error) throw new Error(error.message || 'No se pudo crear el usuario');
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function invokeDeleteUser(userId) {
  const { data, error } = await supabase.functions.invoke('delete-user', { body: { user_id: userId } });
  if (error) throw new Error(error.message || 'No se pudo eliminar el usuario');
  if (data?.error) throw new Error(data.error);
  return data;
}