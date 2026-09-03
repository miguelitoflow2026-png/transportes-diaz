// Backoffice de administración. Todo CRUD vía supabase-js (RLS admin-only) y
// la creación de usuarios vía Edge Functions (nunca credenciales en el repo).
import { supabase } from './supabase.js';
import { state } from './state.js';
import { esc, showToast, showShell, fmtHMshort, fmtDate, fmtTime, formatCLP, toISODate } from './lib.js';
import * as api from './api.js';

export async function render() {
  const admin = await getAdminSide();
  showShell('admin', `Backoffice Admin — ${esc(admin?.name || '')}`);
  document.querySelectorAll('.admin-side button[data-s]').forEach((b) =>
    b.classList.toggle('active', b.dataset.s === state.adminScreen),
  );
  const userBox = document.getElementById('adminSideUser');
  userBox.innerHTML = `
    <div style="font-size:12px; font-weight:700;">${esc(admin?.name || '')}</div>
    <div style="font-size:11px; color:var(--text-dim); margin-bottom:10px;">${esc(admin?.cargo || '')}</div>
    <button class="btn btn-outline btn-sm btn-block" onclick="adminLogout()">Cerrar sesión</button>
  `;

  const main = document.getElementById('adminMain');
  main.innerHTML = '<div class="empty">Cargando…</div>';
  switch (state.adminScreen) {
    case 'clientes': return renderClientes(main);
    case 'contratos': return renderContratos(main);
    case 'conductores': return renderConductores(main);
    case 'vehiculos': return renderVehiculos(main);
    case 'viajes': return renderViajes(main);
    case 'reportes': return renderReportes(main);
  }
}

window.adminLogout = async () => {
  api.audit('logout').catch(() => {});
  await supabase.auth.signOut().catch(() => {});
};
window.setAdminScreen = (s) => {
  state.adminScreen = s;
  render();
};
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.admin-side button[data-s]');
  if (btn && !e.target.closest('.admin-side-user')) window.setAdminScreen(btn.dataset.s);
});

let adminSideCache = null;
async function getAdminSide() {
  if (adminSideCache) return adminSideCache;
  const { data } = await supabase
    .from('admin_users')
    .select('name, cargo')
    .eq('id', state.user.id)
    .maybeSingle();
  adminSideCache = data || {};
  return adminSideCache;
}

// ===========================================================================
// EMPRESAS CLIENTES
// ===========================================================================
async function renderClientes(main) {
  const [clients, contracts] = await Promise.all([api.adminListClients(), api.adminListContracts()]);
  main.innerHTML = `
    <div class="admin-header"><h1>Empresas clientes</h1><p>Empresas para las que Transportes Díaz presta servicio (RUT visible solo para admin)</p></div>
    ${state.result ? `<div class="card" style="border-color:var(--good); margin-bottom:14px;">${esc(state.result)} <button class="btn-outline btn btn-sm" style="float:right;" onclick="state.result=null; setAdminScreen('clientes')">OK</button></div>` : ''}
    <div class="grid-2" style="margin-bottom:24px;">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Empresa</th><th>RUT</th><th>Contratos</th><th></th></tr></thead>
          <tbody>
            ${clients.map((c) => `
              <tr>
                <td style="font-weight:600;">${esc(c.name)}</td>
                <td>${esc(c.rut)}</td>
                <td>${contracts.filter((x) => x.client_id === c.id).length}</td>
                <td><button class="btn btn-danger btn-sm" data-del="${c.id}">Eliminar</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:12px;">Nueva empresa cliente</div>
        <div class="field"><label class="label">Nombre</label><input id="newClientName" placeholder="Ej. Minera Sur S.A."></div>
        <div style="height:10px;"></div>
        <div class="field"><label class="label">RUT</label><input id="newClientRut" placeholder="76.xxx.xxx-x"></div>
        <div style="height:14px;"></div>
        <button class="btn btn-primary btn-block" data-add>Agregar empresa</button>
      </div>
    </div>`;
  main.querySelector('[data-add]').addEventListener('click', addClient);
  main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delClient(b.dataset.del)));
}

window.addClient = async () => {
  const name = document.getElementById('newClientName').value.trim();
  const rut = document.getElementById('newClientRut').value.trim();
  if (!name) { showToast('Ingresa el nombre de la empresa'); return; }
  try {
    const row = await api.adminAddClient(name, rut);
    api.audit('client_create', 'clients', row.id).catch(() => {});
    showToast('Empresa agregada');
    render();
  } catch (e) { showToast(e.message); }
};

window.delClient = async (id) => {
  try {
    const n = await api.adminCountContractsForClient(id);
    if (n > 0) { showToast('No se puede eliminar: tiene contratos asociados'); return; }
    await api.adminDeleteClient(id);
    api.audit('client_delete', 'clients', id).catch(() => {});
    showToast('Empresa eliminada');
    render();
  } catch (e) { showToast(e.message); }
};

// ===========================================================================
// CONTRATOS & CECOS & TARIFAS
// ===========================================================================
async function renderContratos(main) {
  const [contracts, clients] = await Promise.all([api.adminListContracts(), api.adminListClients()]);
  const editing = state.editingContractId ? contracts.find((c) => c.id === state.editingContractId) : null;

  const latestTarifa = (contract, tipo) => {
    const ts = (contract.tarifas || []).filter((t) => t.tipo_viaje === tipo);
    ts.sort((a, b) => (a.vigencia_desde < b.vigencia_desde ? 1 : -1));
    return ts[0] || {};
  };

  const rows = contracts.map((c) => {
    const u = latestTarifa(c, 'urbano');
    const i = latestTarifa(c, 'interurbano');
    return `
      <tr>
        <td style="font-weight:600;">${esc(c.name)}</td>
        <td>${esc(c.clients?.name || '')}</td>
        <td><span class="status-pill status-${c.status === 'activo' ? 'active' : 'inactive'}">${esc(c.status)}</span></td>
        <td>${esc((c.cecos || []).map((x) => x.name).join(', '))}</td>
        <td>${Number(u.valor_km || 0).toLocaleString('es-CL')} / ${Number(u.valor_min_espera || 0).toLocaleString('es-CL')}</td>
        <td>${Number(i.valor_km || 0).toLocaleString('es-CL')} / ${Number(i.valor_min_espera || 0).toLocaleString('es-CL')}</td>
        <td>${fmtDate(c.vigencia_desde)}</td>
        <td><button class="btn btn-outline btn-sm" data-edit="${c.id}">Editar</button></td>
      </tr>`;
  }).join('');

  const u = editing ? latestTarifa(editing, 'urbano') : {};
  const i = editing ? latestTarifa(editing, 'interurbano') : {};

  main.innerHTML = `
    <div class="admin-header"><h1>Contratos &amp; Centros de Costo</h1><p>Tarifas por km y minuto de espera, separadas por tipo de viaje</p></div>
    <div class="table-wrap" style="margin-bottom:24px;">
      <table>
        <thead><tr><th>Contrato</th><th>Empresa cliente</th><th>Estado</th><th>CECOs</th><th>Tarifa urbano (km/min)</th><th>Tarifa interurbano (km/min)</th><th>Vigente desde</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td class="empty">Sin contratos</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <div class="label" style="margin-bottom:14px;">${editing ? 'Editar contrato: ' + esc(editing.name) : 'Nuevo contrato'}</div>
      <div class="form-grid">
        <div class="field"><label class="label">Empresa cliente</span>
          <select id="ct_client">${clients.map((cl) => `<option value="${cl.id}" ${editing && editing.client_id === cl.id ? 'selected' : ''}>${esc(cl.name)}</option>`).join('')}</select>
        </div>
        <div class="field"><label class="label">Nombre del contrato</label><input id="ct_name" value="${editing ? esc(editing.name) : ''}" placeholder="Ej. Contrato Traslados 2026"></div>
        <div class="field"><label class="label">Vigente desde</label><input id="ct_vig" type="date" value="${editing ? esc(editing.vigencia_desde) : new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label class="label">Estado</span>
          <select id="ct_status">
            <option value="activo" ${editing && editing.status === 'activo' ? 'selected' : ''}>Activo</option>
            <option value="inactivo" ${editing && editing.status === 'inactivo' ? 'selected' : ''}>Inactivo</option>
          </select>
        </div>
        <div class="field full"><label class="label">Centros de costo (separados por coma)</span>
          <input id="ct_cecos" value="${editing ? esc((editing.cecos || []).map((x) => x.name).join(', ')) : ''}" placeholder="Ej. Gerencia Operaciones, Gerencia Finanzas">
        </div>
        <div class="field full"><label class="label">PDF del contrato ${editing && editing.pdf_path ? `(actual: ${esc(editing.pdf_path)})` : ''}</span>
          <input id="ct_pdf" type="file" accept="application/pdf">
        </div>
      </div>
      <div class="divider" style="margin:18px 0;"></div>
      <div class="grid-2">
        <div class="card gray">
          <div class="label" style="margin-bottom:10px;">Tarifa — Urbano</div>
          <div class="field"><label class="label">Valor por km (CLP)</label><input id="ctT_uKm" type="number" value="${Number(u.valor_km || 0)}" placeholder="500"></div>
          <div style="height:10px;"></div>
          <div class="field"><label class="label">Valor por minuto de espera (CLP)</label><input id="ctT_uMin" type="number" value="${Number(u.valor_min_espera || 0)}" placeholder="180"></div>
        </div>
        <div class="card gray">
          <div class="label" style="margin-bottom:10px;">Tarifa — Interurbano</div>
          <div class="field"><label class="label">Valor por km (CLP)</label><input id="ctT_iKm" type="number" value="${Number(i.valor_km || 0)}" placeholder="400"></div>
          <div style="height:10px;"></div>
          <div class="field"><label class="label">Valor por minuto de espera (CLP)</label><input id="ctT_iMin" type="number" value="${Number(i.valor_min_espera || 0)}" placeholder="150"></div>
        </div>
      </div>
      <div style="height:8px;"></div>
      <p style="font-size:11.5px; color:var(--text-dim);">💡 Al editar una tarifa se crea una nueva versión con vigencia desde hoy; los viajes antiguos conservan la tarifa vigente en su fecha.</p>
      <div style="height:14px; display:flex; gap:10px;">
        <button class="btn btn-primary btn-block" onclick="saveContract()">${editing ? 'Guardar cambios' : 'Crear contrato'}</button>
        ${editing ? '<button class="btn btn-outline" onclick="state.editingContractId=null; setAdminScreen(\'contratos\')">Cancelar</button>' : ''}
      </div>
    </div>`;
  main.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      state.editingContractId = b.dataset.edit;
      render();
    }),
  );
}

window.saveContract = async () => {
  const clientId = document.getElementById('ct_client').value;
  const name = document.getElementById('ct_name').value.trim();
  const vigenciaDesde = document.getElementById('ct_vig').value;
  const status = document.getElementById('ct_status').value;
  const cecosNames = document.getElementById('ct_cecos').value.split(',').map((s) => s.trim()).filter(Boolean);
  const file = document.getElementById('ct_pdf').files[0];
  const uKm = Number(document.getElementById('ctT_uKm').value) || 0;
  const uMin = Number(document.getElementById('ctT_uMin').value) || 0;
  const iKm = Number(document.getElementById('ctT_iKm').value) || 0;
  const iMin = Number(document.getElementById('ctT_iMin').value) || 0;
  if (!name || !clientId || !cecosNames.length) { showToast('Completa nombre, empresa cliente y al menos un CECO'); return; }

  try {
    let contractId, auditAction;
    if (state.editingContractId) {
      contractId = state.editingContractId;
      await api.adminUpdateContract(contractId, { name, client_id: clientId, status, vigencia_desde: vigenciaDesde });
      await api.adminReplaceCecos(contractId, cecosNames);
      auditAction = 'contract_update';
    } else {
      const row = await api.adminInsertContract({ name, client_id: clientId, status, vigencia_desde: vigenciaDesde });
      contractId = row.id;
      await api.adminReplaceCecos(contractId, cecosNames);
      auditAction = 'contract_create';
    }

    // Tarifas versionadas. Al crear se usa la vigencia del contrato; al editar,
    // hoy (para no alterar viajes pasados).
    const tarifaVig = state.editingContractId ? toISODate(new Date()) : vigenciaDesde;
    await api.adminUpsertTarifa(contractId, 'urbano', { valor_km: uKm, valor_min_espera: uMin, vigencia_desde: tarifaVig });
    await api.adminUpsertTarifa(contractId, 'interurbano', { valor_km: iKm, valor_min_espera: iMin, vigencia_desde: tarifaVig });

    // Storage privado: únicamente URLs firmadas después.
    if (file) {
      const path = `${contractId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await api.adminUploadPdf(path, file);
      await api.adminUpdateContract(contractId, { pdf_path: path });
    }

    api.audit(auditAction, 'contracts', contractId).catch(() => {});
    state.editingContractId = null;
    showToast(auditAction === 'contract_create' ? 'Contrato creado' : 'Contrato actualizado');
    render();
  } catch (e) { showToast(e.message); }
};

// ===========================================================================
// CONDUCTORES
// ===========================================================================
async function renderConductores(main) {
  const drivers = await api.adminListDrivers();
  main.innerHTML = `
    <div class="admin-header"><h1>Conductores</h1><p>Cuentas individuales con clave personal (creadas aquí, sin contraseñas en el código)</p></div>
    ${state.result ? `<div class="card" style="border-color:var(--good); margin-bottom:14px;">${esc(state.result)} <button class="btn-outline btn btn-sm" style="float:right;" onclick="state.result=null; setAdminScreen('conductores')">OK</button></div>` : ''}
    <div class="grid-2">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Nombre</th><th>RUT</th><th>Email</th><th>Viajes</th><th></th></tr></thead>
          <tbody>
            ${drivers.map((d) => `
              <tr>
                <td style="font-weight:600;">${esc(d.name)}</td>
                <td>${esc(d.rut)}</td>
                <td>${esc(d.email)}</td>
                <td>${Number(d.trips?.[0]?.count || 0)}</td>
                <td><button class="btn btn-danger btn-sm" data-del="${d.id}">Eliminar</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:12px;">Nuevo conductor</div>
        <div class="field"><label class="label">Nombre completo</label><input id="newDrvName" placeholder="Nombre y apellido"></div>
        <div style="height:10px;"></div>
        <div class="field"><label class="label">RUT</label><input id="newDrvRut" placeholder="12.345.678-9"></div>
        <div style="height:10px;"></div>
        <div class="field"><label class="label">Email</label><input id="newDrvEmail" type="email" placeholder="correo@transportesdiaz.cl"></div>
        <div style="height:10px;"></div>
        <div class="field"><label class="label">Clave temporal (mín. 8 caracteres)</label><input id="newDrvPass" type="password" placeholder="Se entrega una vez al conductor"></div>
        <div style="height:14px;"></div>
        <button class="btn btn-primary btn-block" onclick="addDriver()">Agregar conductor</button>
      </div>
    </div>`;
  main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delDriver(b.dataset.del)));
}

window.addDriver = async () => {
  const name = document.getElementById('newDrvName').value.trim();
  const rut = document.getElementById('newDrvRut').value.trim();
  const email = document.getElementById('newDrvEmail').value.trim();
  const password = document.getElementById('newDrvPass').value;
  if (!name || !email || !password) { showToast('Completa nombre, email y clave'); return; }
  try {
    const res = await api.invokeCreateUser({ email, password, name, rut, role: 'conductor' });
    api.audit('user_create', 'auth.users', res.id).catch(() => {});
    state.result = `Conductor creado (${name}). Clave temporal: ${password} — entrégasela en persona y pide cambiarla.`;
    showToast('Conductor creado');
    render();
  } catch (e) { showToast(e.message); }
};

window.delDriver = async (id) => {
  try {
    const n = await api.adminCountTripsByDriver(id);
    if (n > 0) { showToast(`No se puede eliminar: tiene ${n} viaje(s). Mejor desactiva su usuario en lugar de borrarlo.`); return; }
    await api.invokeDeleteUser(id);
    api.audit('user_delete', 'auth.users', id).catch(() => {});
    showToast('Conductor eliminado');
    render();
  } catch (e) { showToast(e.message); }
};

// ===========================================================================
// VEHÍCULOS
// ===========================================================================
async function renderVehiculos(main) {
  const vehicles = await api.adminListVehicles();
  main.innerHTML = `
    <div class="admin-header"><h1>Vehículos</h1><p>Flota seleccionable libremente en cada viaje</p></div>
    <div class="grid-2">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Patente</th><th>Modelo</th><th></th></tr></thead>
          <tbody>
            ${vehicles.map((v) => `
              <tr><td style="font-weight:600;">${esc(v.plate)}</td><td>${esc(v.model)}</td>
              <td><button class="btn btn-danger btn-sm" data-del="${v.id}">Eliminar</button></td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:12px;">Nuevo vehículo</div>
        <div class="field"><label class="label">Patente</label><input id="newVehPlate" placeholder="ABCD-12"></div>
        <div style="height:10px;"></div>
        <div class="field"><label class="label">Modelo</label><input id="newVehModel" placeholder="Hyundai H1 2024"></div>
        <div style="height:14px;"></div>
        <button class="btn btn-primary btn-block" onclick="addVehicle()">Agregar vehículo</button>
      </div>
    </div>`;
  main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delVehicle(b.dataset.del)));
}

window.addVehicle = async () => {
  const plate = document.getElementById('newVehPlate').value.trim();
  const model = document.getElementById('newVehModel').value.trim();
  if (!plate) { showToast('Ingresa la patente'); return; }
  try {
    await api.adminAddVehicle(plate, model);
    api.audit('vehicle_create', 'vehicles').catch(() => {});
    showToast('Vehículo agregado');
    render();
  } catch (e) { showToast(e.message); }
};

window.delVehicle = async (id) => {
  try {
    const n = await api.adminCountTripsByVehicle(id);
    if (n > 0) { showToast(`No se puede eliminar: tiene ${n} viaje(s).`); return; }
    await api.adminDeleteVehicle(id);
    api.audit('vehicle_delete', 'vehicles', id).catch(() => {});
    showToast('Vehículo eliminado');
    render();
  } catch (e) { showToast(e.message); }
};

// ===========================================================================
// VIAJES (listado + filtros)
// ===========================================================================
async function renderViajes(main) {
  const [trips, clients, contracts, drivers] = await Promise.all([
    api.adminFetchTrips({}),
    api.adminListClients(),
    api.adminListContracts(),
    api.adminListDrivers(),
  ]);
  state.filters.trips = trips;
  state.filters.meta = { clients, contracts, drivers };
  main.innerHTML = `
    <div class="admin-header"><h1>Viajes</h1><p>Listado completo con filtros por empresa, contrato, conductor y fecha</p></div>
    ${filterCardHTML()}
    <div id="tripsTableWrap">${renderTripsTable(trips, state.filters.meta)}</div>`;
  wireFilters(main);
}

// ===========================================================================
// REPORTES
// ===========================================================================
async function renderReportes(main) {
  const [trips, clients, contracts, drivers] = await Promise.all([
    api.adminFetchTrips({}),
    api.adminListClients(),
    api.adminListContracts(),
    api.adminListDrivers(),
  ]);
  state.filters.trips = trips;
  state.filters.meta = { clients, contracts, drivers };
  main.innerHTML = `
    <div class="admin-header"><h1>Reportes</h1><p>Diario, semanal (viernes) y mensual — exportables a Excel y PDF</p></div>
    ${filterCardHTML()}
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px;">
      <button class="btn btn-primary" onclick="downloadCSV()">⬇ Exportar Excel (.xlsx)</button>
      <button class="btn btn-outline" onclick="window.print()">🖨 Exportar / Imprimir PDF</button>
      <button class="btn btn-outline" onclick="quickRange('day')">Reporte de hoy</button>
      <button class="btn btn-outline" onclick="quickRange('week')">Semana (hasta el viernes)</button>
      <button class="btn btn-outline" onclick="quickRange('month')">Reporte mensual</button>
    </div>
    <div id="tripsTableWrap">${renderTripsTable(trips, state.filters.meta)}</div>`;
  wireFilters(main);
}

function filterCardHTML() {
  const { clients = [], contracts = [], drivers = [] } = state.filters.meta || {};
  const f = state.filters.values || {};
  return `
    <div class="card no-print" style="margin-bottom:18px;">
      <div class="form-grid">
        <div class="field"><label class="label">Empresa</label><select id="fClient">${clientOptions(clients, f)}</select></div>
        <div class="field"><label class="label">Contrato</label><select id="fContract">${contractOptions(contracts, f)}</select></div>
        <div class="field"><label class="label">Conductor</label><select id="fDriver">${driverOptions(drivers, f)}</select></div>
        <div class="field"><label class="label">Desde</label><input type="date" id="fFrom" value="${esc(f.from || '')}"></div>
        <div class="field"><label class="label">Hasta</label><input type="date" id="fTo" value="${esc(f.to || '')}"></div>
      </div>
    </div>`;
}

function clientOptions(clients, f) {
  return `<option value="">Todas</option>` +
    clients.map((c) => `<option value="${c.id}" ${f.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}
function contractOptions(contracts, f) {
  return `<option value="">Todos</option>` +
    contracts.map((c) => `<option value="${c.id}" ${f.contractId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}
function driverOptions(drivers, f) {
  return `<option value="">Todos</option>` +
    drivers.map((d) => `<option value="${d.id}" ${f.driverId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
}

function wireFilters(main) {
  ['fClient', 'fContract', 'fDriver', 'fFrom', 'fTo'].forEach((id) => {
    main.querySelector(`#${id}`)?.addEventListener('change', applyFilters);
  });
}

function applyFilters() {
  const f = state.filters.values = {
    clientId: document.getElementById('fClient').value,
    contractId: document.getElementById('fContract').value,
    driverId: document.getElementById('fDriver').value,
    from: document.getElementById('fFrom').value,
    to: document.getElementById('fTo').value,
  };
  const all = state.filters.trips || [];
  const filtered = all.filter((t) => {
    const clientId = t.contracts?.client_id;
    if (f.clientId && clientId !== f.clientId) return false;
    if (f.contractId && t.contract_id !== f.contractId) return false;
    if (f.driverId && t.driver_id !== f.driverId) return false;
    if (f.from && new Date(t.start_time) < new Date(f.from)) return false;
    if (f.to && new Date(t.start_time) > new Date(f.to + 'T23:59:59')) return false;
    return true;
  });
  const wrap = document.getElementById('tripsTableWrap');
  if (wrap) wrap.innerHTML = renderTripsTable(filtered, state.filters.meta);
}

window.quickRange = (type) => {
  const today = new Date();
  let from, to;
  if (type === 'day') { from = today; to = today; }
  else if (type === 'week') {
    const friday = new Date(today);
    const diff = (friday.getDay() + 7 - 5) % 7;
    friday.setDate(friday.getDate() - diff);
    from = new Date(friday); from.setDate(from.getDate() - 6);
    to = friday;
  } else {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
    to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  }
  document.getElementById('fFrom').value = toISODate(from);
  document.getElementById('fTo').value = toISODate(to);
  applyFilters();
};

function renderTripsTable(trips, meta) {
  if (!trips.length) return '<div class="empty">No hay viajes que coincidan con el filtro seleccionado.</div>';
  const driversById = new Map((meta?.drivers || []).map((d) => [d.id, d]));
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Fecha</th><th>Conductor</th><th>Contrato</th><th>CECO</th><th>Tipo</th><th>Inicio</th><th>Término</th>
          <th>Km</th><th>Espera</th><th>Monto km</th><th>Monto espera</th><th>Monto total</th>
        </tr></thead>
        <tbody>
          ${trips.map((t) => `
            <tr>
              <td>${fmtDate(t.start_time)}</td>
              <td>${esc(driversById.get(t.driver_id)?.name || '—')}</td>
              <td>${esc(t.contracts?.name || '—')}</td>
              <td>${esc(t.cecos?.name || '—')}</td>
              <td style="text-transform:capitalize;">${esc(t.trip_type)}</td>
              <td>${fmtTime(t.start_time)}</td><td>${fmtTime(t.end_time)}</td>
              <td>${Number(t.total_km).toFixed(2)}</td>
              <td>${fmtHMshort(t.total_wait_seconds || 0)}</td>
              <td>${formatCLP(t.monto_km)}</td><td>${formatCLP(t.monto_espera)}</td>
              <td style="font-weight:700;">${formatCLP(t.monto_total)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

window.downloadCSV = async () => {
  applyFilters();
  const trips = (state.filters.trips || []).filter((t) => matchesCurrentFilters(t));
  if (!trips.length) { showToast('No hay viajes para exportar con este filtro'); return; }
  const meta = state.filters.meta || {};
  const driversById = new Map(meta.drivers.map((d) => [d.id, d.name]));
  const headers = ['Fecha', 'Conductor', 'Contrato', 'Centro de Costo', 'Tipo de viaje', 'Hora inicio', 'Hora término', 'Km recorridos', 'Tiempo espera (hh:mm)', 'Monto km (CLP)', 'Monto espera (CLP)', 'Monto total (CLP)'];
  const rows = trips.map((t) => [
    fmtDate(t.start_time),
    driversById.get(t.driver_id) || '',
    t.contracts?.name || '',
    t.cecos?.name || '',
    t.trip_type === 'urbano' ? 'Urbano' : 'Interurbano',
    fmtTime(t.start_time),
    fmtTime(t.end_time),
    Number(t.total_km),
    fmtHMshort(t.total_wait_seconds || 0),
    Number(t.monto_km), Number(t.monto_espera), Number(t.monto_total),
  ]);

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Reporte de viajes');
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  ws.columns.forEach((c, i) => {
    c.width = [11, 20, 28, 20, 13, 10, 10, 12, 15, 13, 15, 13][i] || 12;
  });
  ws.getRow(1).font = { bold: true, name: 'Arial', size: 10 };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reporte_transportes_diaz_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  api.audit('report_export', 'trips', null, { count: trips.length }).catch(() => {});
  showToast('Reporte Excel (.xlsx) descargado');
};

function matchesCurrentFilters(t) {
  const f = state.filters.values || {};
  if (f.clientId && t.contracts?.client_id !== f.clientId) return false;
  if (f.contractId && t.contract_id !== f.contractId) return false;
  if (f.driverId && t.driver_id !== f.driverId) return false;
  if (f.from && new Date(t.start_time) < new Date(f.from)) return false;
  if (f.to && new Date(t.start_time) > new Date(f.to + 'T23:59:59')) return false;
  return true;
}