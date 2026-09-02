// App de conductor (vista móvil). Conserva el diseño y flujo del prototipo,
// pero los datos vienen de Supabase y los montos se calculan en el servidor.
import { supabase } from './supabase.js';
import { state } from './state.js';
import { esc, icon, showToast, showShell, fmtHM, fmtHMshort, fmtDate, fmtTime, formatCLP } from './lib.js';
import { loadDriverContext, fetchActiveTrip, createTrip, updateTrip, finalizeTrip, previewAmounts, getMyTrips, getContractPdfUrl, audit } from './api.js';

let ticker = null;
let tickCount = 0;
const tripVisual = { routePoints: [[10, 90]] };

export async function enter() {
  try {
    if (!state.driverContext) await loadDriverContext();
    const trips = await getMyTrips().catch(() => []);
    state.driverStats = { count: trips.length };
    await fetchActiveTrip();
    if (state.activeTrip) {
      tripVisual.routePoints = [[10, 90]];
    }
    state.driverScreen = 'dashboard';
    render();
  } catch (e) {
    showToast(e.message);
    await supabase.auth.signOut().catch(() => {});
  }
}

export function render() {
  const profile = state.driverContext?.profile || {};
  showShell('driver', `App Conductor — ${esc(profile.name || '')}`);
  buildNav();
  const scr = document.getElementById('driverScreen');
  let html = '';
  switch (state.driverScreen) {
    case 'dashboard': html = screenDashboard(); break;
    case 'seleccion': html = screenSeleccion(); break;
    case 'tipoViaje': html = screenTipoViaje(); break;
    case 'activo': html = screenActivo(); break;
    case 'resumen': html = screenResumen(); break;
    case 'historial': html = screenHistorial(); break;
    case 'perfil': html = screenPerfil(); break;
    case 'contratos': html = screenContratos(); break;
    default: html = screenDashboard();
  }
  scr.innerHTML = html;
  if (state.driverScreen === 'historial') loadHistorial();
  if (state.driverScreen === 'resumen') loadResumenPreview();
  ensureTicker();
}

function buildNav() {
  const nav = document.getElementById('driverNav');
  const labels = [
    ['dashboard', 'Inicio', 'home'],
    ['contratos', 'Contratos', 'receipt'],
    ['historial', 'Historial', 'history'],
    ['perfil', 'Perfil', 'user'],
  ];
  nav.innerHTML = labels
    .map(([s, label, ic]) => `<button class="${state.driverScreen === s ? 'active' : ''}" onclick="goDriverScreen('${s}')">${icon(ic)}${label}</button>`)
    .join('');
}

export function goDriverScreen(s) {
  state.driverScreen = s;
  render();
}
window.goDriverScreen = goDriverScreen;

function contractById(id) {
  return (state.driverContext?.contracts || []).find((c) => c.id === id);
}
function vehicleById(id) {
  return (state.driverContext?.vehicles || []).find((v) => v.id === id);
}
function cecoOf(contract, id) {
  return (contract?.cecos || []).find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
function screenDashboard() {
  const d = state.driverContext?.profile || {};
  const active = state.activeTrip;
  const first = (d.name || '').split(' ')[0];
  const dateLine = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });

  const activeCard = active
    ? `
      <div class="card" style="border-color:var(--primary);">
        <div class="row">
          <span class="chip chip-${esc(active.status)}">${active.status === 'conduccion' ? '● En conducción' : '● En espera'}</span>
          <span class="mini-label">${esc(contractById(active.contract_id)?.name || '')}</span>
        </div>
        <div class="divider"></div>
        <div class="row">
          <div><div class="mini-label">KM RECORRIDOS</div><div class="big-stat">${Number(active.total_km || 0).toFixed(1)}</div></div>
          <div><div class="mini-label">TIEMPO ESPERA</div><div class="big-stat">${fmtHM(active.total_wait_seconds || 0)}</div></div>
        </div>
        <div style="height:14px;"></div>
        <button class="btn btn-primary btn-block" onclick="goDriverScreen('activo')">Continuar viaje</button>
      </div>`
    : `
      <div class="card gray" style="text-align:center; padding:28px 18px;">
        <div style="color:var(--text-dim); font-size:13px; margin-bottom:14px;">No tienes ningún viaje en curso</div>
        <button class="btn btn-primary btn-block" onclick="startNewTripFlow()">${icon('car')} Iniciar viaje</button>
      </div>`;

  const tripsCount = (state.driverStats?.count) ?? '—';
  return `
    <div class="screen-title">Hola, ${esc(first)}</div>
    <div class="screen-sub">${esc(dateLine)}</div>
    ${activeCard}
    <div class="card" onclick="goDriverScreen('contratos')" style="cursor:pointer;">
      <div class="row">
        <div style="display:flex; align-items:center; gap:10px;">${icon('receipt')}<div>
          <div style="font-weight:600; font-size:14px;">Mis contratos vigentes</div>
          <div class="mini-label" style="font-weight:500;">Empresas y datos del contrato</div>
        </div></div>
        <span style="color:var(--text-dim);">›</span>
      </div>
    </div>
    <div class="card" onclick="goDriverScreen('historial')" style="cursor:pointer;">
      <div class="row">
        <div style="display:flex; align-items:center; gap:10px;">${icon('history')}<div>
          <div style="font-weight:600; font-size:14px;">Mi historial de viajes</div>
          <div class="mini-label" style="font-weight:500;">${esc(String(tripsCount))} viajes registrados</div>
        </div></div>
        <span style="color:var(--text-dim);">›</span>
      </div>
    </div>
  `;
}

export function startNewTripFlow() {
  if (state.activeTrip) {
    showToast('Ya tienes un viaje en curso');
    goDriverScreen('activo');
    return;
  }
  state.newTrip = { contractId: null, cecoId: null, vehicleId: null, tripType: 'urbano' };
  goDriverScreen('seleccion');
}
window.startNewTripFlow = startNewTripFlow;

function screenSeleccion() {
  const nt = state.newTrip;
  const contracts = state.driverContext?.contracts || [];
  const contract = contractById(nt.contractId) || null;
  const contractOptions = contracts
    .map((c) => `<option value="${c.id}" ${nt.contractId === c.id ? 'selected' : ''}>${esc(c.client_name)} — ${esc(c.name)}</option>`)
    .join('');
  const cecoOptions = (contract?.cecos || [])
    .map((ce) => `<option value="${ce.id}" ${nt.cecoId === ce.id ? 'selected' : ''}>${esc(ce.name)}</option>`)
    .join('');
  const vehicleOptions = (state.driverContext?.vehicles || [])
    .map((v) => `<option value="${v.id}" ${nt.vehicleId === v.id ? 'selected' : ''}>${esc(v.plate)} — ${esc(v.model)}</option>`)
    .join('');
  return `
    <div class="row"><button class="btn-outline btn btn-sm" onclick="goDriverScreen('dashboard')">← Volver</button></div>
    <div class="screen-title">Nuevo viaje</div>
    <div class="screen-sub">Selecciona contrato, centro de costo y vehículo</div>
    <div class="card">
      <div class="field">
        <span class="label">Contrato / Empresa cliente</span>
        <select id="selContrato" onchange="onContractChange(this.value)">
          <option value="">Selecciona un contrato…</option>
          ${contractOptions}
        </select>
      </div>
      <div style="height:12px;"></div>
      <div class="field">
        <span class="label">Centro de costo (CECO)</span>
        <select id="selCeco" ${!contract ? 'disabled' : ''} onchange="state.newTrip.cecoId=this.value">
          <option value="">${contract ? 'Selecciona un CECO…' : 'Primero elige un contrato'}</option>
          ${cecoOptions}
        </select>
      </div>
      <div style="height:12px;"></div>
      <div class="field">
        <span class="label">Vehículo a usar</span>
        <select id="selVehiculo" onchange="state.newTrip.vehicleId=this.value">
          <option value="">Selecciona un vehículo…</option>
          ${vehicleOptions}
        </select>
      </div>
    </div>
    <button class="btn btn-primary btn-block" onclick="confirmSeleccion()">Continuar</button>
  `;
}
window.onContractChange = (val) => {
  state.newTrip.contractId = val || null;
  state.newTrip.cecoId = null;
  goDriverScreen('seleccion');
};
window.confirmSeleccion = async () => {
  state.newTrip.contractId = document.getElementById('selContrato').value;
  state.newTrip.cecoId = document.getElementById('selCeco').value;
  state.newTrip.vehicleId = document.getElementById('selVehiculo').value;
  if (!state.newTrip.contractId || !state.newTrip.cecoId || !state.newTrip.vehicleId) {
    showToast('Completa contrato, CECO y vehículo');
    return;
  }
  goDriverScreen('tipoViaje');
};

function screenTipoViaje() {
  const nt = state.newTrip;
  const contract = contractById(nt.contractId) || {};
  const ceco = cecoOf(contract, nt.cecoId);
  const veh = vehicleById(nt.vehicleId);
  return `
    <div class="row"><button class="btn-outline btn btn-sm" onclick="goDriverScreen('seleccion')">← Volver</button></div>
    <div class="screen-title">Tipo de viaje</div>
    <div class="screen-sub">${esc(contract.name || '')}</div>
    <div class="card">
      <div class="row"><span class="mini-label">CECO</span><span style="font-size:12px;">${esc(ceco?.name || '')}</span></div>
      <div class="row"><span class="mini-label">VEHÍCULO</span><span style="font-size:12px;">${esc(veh?.plate || '')} · ${esc(veh?.model || '')}</span></div>
    </div>
    <div class="toggle-group">
      <button class="${nt.tripType === 'urbano' ? 'selected' : ''}" onclick="setTripType('urbano')">Urbano</button>
      <button class="${nt.tripType === 'interurbano' ? 'selected' : ''}" onclick="setTripType('interurbano')">Interurbano</button>
    </div>
    <button class="btn btn-primary btn-block" onclick="beginTrip()">${icon('car')} Iniciar viaje — En conducción</button>
  `;
}
window.setTripType = (t) => {
  state.newTrip.tripType = t;
  goDriverScreen('tipoViaje');
};

window.beginTrip = async () => {
  const nt = state.newTrip;
  try {
    const trip = await createTrip({
      contract_id: nt.contractId,
      ceco_id: nt.cecoId,
      vehicle_id: nt.vehicleId,
      trip_type: nt.tripType,
      status: 'conduccion',
      total_km: 0,
      total_wait_seconds: 0,
    });
    tripVisual.routePoints = [[10, 90]];
    state.activeTrip = trip;
    goDriverScreen('activo');
  } catch (e) {
    showToast(e.message);
  }
};

window.toggleEspera = async () => {
  const trip = state.activeTrip;
  if (!trip) return;
  const status = trip.status === 'conduccion' ? 'espera' : 'conduccion';
  try {
    const updated = await updateTrip(trip.id, { status });
    state.activeTrip = updated;
    render();
  } catch (e) {
    showToast(e.message);
  }
};

window.openNavegar = () => {
  window.open('https://www.google.com/maps/dir/?api=1&destination=&travelmode=driving', '_blank');
  showToast('Abriendo navegación externa (Google Maps)…');
};

window.goResumen = () => {
  stopTicker();
  goDriverScreen('resumen');
};

function screenActivo() {
  const trip = state.activeTrip;
  if (!trip) return screenDashboard();
  const contract = contractById(trip.contract_id) || {};
  const ceco = cecoOf(contract, trip.ceco_id);
  const veh = vehicleById(trip.vehicle_id);
  const elapsedTotal = (Date.now() - new Date(trip.start_time).getTime()) / 1000;
  const points = tripVisual.routePoints.map((p) => p.join(',')).join(' ');
  return `
    <div class="row">
      <span class="chip chip-${esc(trip.status)}">${trip.status === 'conduccion' ? '● En conducción' : '● En espera'}</span>
      <span class="mini-label">${fmtHM(elapsedTotal)}</span>
    </div>
    <div class="map-box">
      <svg viewBox="0 0 220 190" preserveAspectRatio="none">
        <rect width="220" height="190" fill="#e9edf5"/>
        <g stroke="#d3d9e8" stroke-width="1">
          ${[0, 1, 2, 3, 4, 5].map((i) => `<line x1="0" y1="${i * 38}" x2="220" y2="${i * 38}"/>`).join('')}
          ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<line x1="${i * 36}" y1="0" x2="${i * 36}" y2="190"/>`).join('')}
        </g>
        <polyline points="${points}" fill="none" stroke="#1a237e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${tripVisual.routePoints[tripVisual.routePoints.length - 1][0]}" cy="${tripVisual.routePoints[tripVisual.routePoints.length - 1][1]}" r="5" fill="#1a237e"/>
      </svg>
    </div>
    <div class="card">
      <div class="row"><span class="mini-label">CONTRATO</span><span style="font-size:12px; font-weight:600;">${esc(contract.name || '')}</span></div>
      <div class="row"><span class="mini-label">CECO</span><span style="font-size:12px;">${esc(ceco?.name || '')}</span></div>
      <div class="row"><span class="mini-label">VEHÍCULO</span><span style="font-size:12px;">${esc(veh?.plate || '')}</span></div>
      <div class="row"><span class="mini-label">TIPO DE VIAJE</span><span style="font-size:12px; text-transform:capitalize;">${esc(trip.trip_type)}</span></div>
    </div>
    <div class="grid-2" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div class="card gray" style="text-align:center;">
        <div class="mini-label">KM RECORRIDOS</div>
        <div class="big-stat">${Number(trip.total_km || 0).toFixed(2)}</div>
      </div>
      <div class="card gray" style="text-align:center;">
        <div class="mini-label">TIEMPO ESPERA</div>
        <div class="big-stat" style="color:var(--wait);">${fmtHM(trip.total_wait_seconds || 0)}</div>
      </div>
    </div>
    <button class="btn btn-outline btn-block" onclick="openNavegar()">${icon('nav')} Navegar (Google Maps / Waze)</button>
    <div style="display:flex; gap:10px;">
      ${trip.status === 'conduccion'
        ? `<button class="btn btn-wait btn-block" onclick="toggleEspera()">${icon('pause')} Iniciar espera</button>`
        : `<button class="btn btn-primary btn-block" onclick="toggleEspera()">${icon('car')} Reanudar viaje</button>`}
    </div>
    <button class="btn btn-danger btn-block" onclick="goResumen()">Finalizar viaje</button>
  `;
}

// Resumen pre-finalización: valores en vivo calculados por el SERVIDOR (preview).
function screenResumen() {
  const trip = state.activeTrip;
  if (!trip) return screenDashboard();
  const contract = contractById(trip.contract_id) || {};
  const ceco = cecoOf(contract, trip.ceco_id);
  const veh = vehicleById(trip.vehicle_id);
  const waitMin = Math.ceil((trip.total_wait_seconds || 0) / 60);
  return `
    <div class="screen-title">Resumen del viaje</div>
    <div class="screen-sub">Revisa y confirma — el cobro final se calcula en el servidor</div>
    <div class="card">
      <div class="row"><span class="mini-label">CONTRATO</span><span style="font-size:12px; font-weight:600; text-align:right;">${esc(contract.name || '')}</span></div>
      <div class="row"><span class="mini-label">CECO</span><span style="font-size:12px;">${esc(ceco?.name || '')}</span></div>
      <div class="row"><span class="mini-label">VEHÍCULO</span><span style="font-size:12px;">${esc(veh?.plate || '')}</span></div>
      <div class="row"><span class="mini-label">HORA INICIO — TÉRMINO</span><span style="font-size:12px;">${fmtTime(trip.start_time)} – ${fmtTime(new Date().toISOString())}</span></div>
    </div>
    <div class="field">
      <span class="label">Tipo de viaje aplicado</span>
      <div class="toggle-group">
        <button class="${trip.trip_type === 'urbano' ? 'selected' : ''}" onclick="changeTripTypeAtSummary('urbano')">Urbano</button>
        <button class="${trip.trip_type === 'interurbano' ? 'selected' : ''}" onclick="changeTripTypeAtSummary('interurbano')">Interurbano</button>
      </div>
    </div>
    <div class="grid-2" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div class="card gray"><div class="mini-label">KM TOTALES</div><div class="big-stat" style="font-size:22px;">${Number(trip.total_km || 0).toFixed(2)}</div></div>
      <div class="card gray"><div class="mini-label">TIEMPO ESPERA</div><div class="big-stat" style="font-size:22px;">${fmtHM(trip.total_wait_seconds || 0)}</div></div>
    </div>
    <div class="card gray">
      <div class="row"><span class="mini-label">MINUTOS DE ESPERA COBRADOS</span><span style="font-weight:700;">${waitMin}</span></div>
    </div>
    <div id="amountsBox" class="card"><div class="mini-label" style="text-align:center;">Calculando montos en el servidor…</div></div>
    <div class="field">
      <span class="label">Observaciones (opcional)</span>
      <textarea id="tripNotes" placeholder="Nombre del pasajero, motivo del viaje, notas…" maxlength="2000">${esc(trip.notes || '')}</textarea>
    </div>
    <button class="btn btn-primary btn-block" onclick="confirmarViaje()">${icon('check')} Confirmar y guardar viaje</button>
  `;
}

// Vista previa de montos: calculada por la función del servidor, solo informativa.
// El valor definitivo lo fija finalize_trip() (autoritativo).
async function loadResumenPreview() {
  const box = document.getElementById('amountsBox');
  const trip = state.activeTrip;
  if (!box || !trip) return;
  try {
    const a = await previewAmounts(
      trip.contract_id,
      trip.trip_type,
      trip.total_km,
      trip.total_wait_seconds,
      trip.start_time.slice(0, 10),
    );
    box.innerHTML = `
      <div class="label" style="margin-bottom:8px;">MONTO ESTIMADO (CLP) — calculado en servidor</div>
      <div class="row"><span style="font-size:13px;">Km recorridos (${Number(trip.total_km).toFixed(2)} km × $/km vigente)</span><span style="font-weight:600;">${formatCLP(a.monto_km)}</span></div>
      <div class="row"><span style="font-size:13px;">Tiempo de espera (${Math.ceil(trip.total_wait_seconds / 60)} min × $/min vigente)</span><span style="font-weight:600;">${formatCLP(a.monto_espera)}</span></div>
      <div class="divider"></div>
      <div class="row"><span style="font-weight:700;">Total estimado</span><span style="font-weight:800; font-size:18px; color:var(--primary);">${formatCLP(a.monto_total)}</span></div>`;
  } catch (e) {
    box.innerHTML = `<div class="mini-label" style="text-align:center;">${esc(e.message)}</div>`;
  }
}

window.changeTripTypeAtSummary = async (t) => {
  const trip = state.activeTrip;
  try {
    const updated = await updateTrip(trip.id, { trip_type: t });
    state.activeTrip = updated;
    render();
  } catch (e) {
    showToast(e.message);
  }
};

window.confirmarViaje = async () => {
  const trip = state.activeTrip;
  if (!trip) return;
  try {
    const notes = (document.getElementById('tripNotes').value || '').trim();
    if (notes !== (trip.notes || '')) await updateTrip(trip.id, { notes });
    // El servidor calcula montos (tarifa vigente al inicio del viaje) y cierra el viaje.
    await finalizeTrip(trip.id);
    stopTicker();
    state.activeTrip = null;
    showToast('Viaje guardado correctamente');
    state.driverScreen = 'dashboard';
    await fetchActiveTrip(); // confirma que no queda viaje abierto
    render();
  } catch (e) {
    showToast('No se pudo finalizar: ' + e.message);
  }
};

window.openPDF = async (e, pdfPath) => {
  e?.stopPropagation();
  try {
    const url = await getContractPdfUrl(pdfPath);
    if (!url) { showToast('El contrato no tiene PDF adjunto'); return; }
    window.open(url, '_blank');
  } catch (err) {
    showToast('No se pudo abrir el PDF');
  }
};

// ---------------------------------------------------------------------------
function screenHistorial() {
  return `
    <div class="screen-title">Historial de viajes</div>
    <div id="histList" class="empty">Cargando…</div>
  `;
}
async function loadHistorial() {
  const el = document.getElementById('histList');
  if (!el) return;
  let trips;
  try {
    trips = await getMyTrips();
  } catch (e) {
    el.className = '';
    el.innerHTML = `<div class="empty">Error cargando historial</div>`;
    return;
  }
  if (trips.length === 0) {
    el.className = '';
    el.innerHTML = `<div class="empty">${icon('history')}<br><br>Aún no tienes viajes registrados</div>`;
    return;
  }
  el.className = '';
  el.innerHTML = trips.map((t) => `
      <div class="card">
        <div class="row"><span style="font-weight:600; font-size:13px;">${esc(t.contract_name || '')}</span><span class="mini-label">${fmtDate(t.start_time)}</span></div>
        <div class="row"><span class="mini-label">${t.trip_type === 'urbano' ? 'Urbano' : 'Interurbano'} · ${fmtTime(t.start_time)}–${fmtTime(t.end_time)}</span></div>
        <div class="divider"></div>
        <div class="row">
          <span style="font-size:12px;">${Number(t.total_km).toFixed(1)} km · espera ${fmtHMshort(t.total_wait_seconds || 0)}</span>
          <span style="font-weight:700; color:var(--primary);">${formatCLP(t.monto_total)}</span>
        </div>
      </div>`).join('');
}

// ---------------------------------------------------------------------------
function screenContratos() {
  const contracts = state.driverContext?.contracts || [];
  if (!contracts.length) return `<div class="screen-title">Contratos</div><div class="empty">No hay contratos vigentes</div>`;
  return `
    <div class="screen-title">Mis contratos</div>
    <div class="screen-sub">Información vigente (sin valores de tarifas)</div>
    ${contracts.map((c) => `
      <div class="card">
        <div class="row"><span style="font-weight:600; font-size:13px;">${esc(c.name)}</span><span class="mini-label">${esc(c.client_name)}</span></div>
        <div class="row"><span class="mini-label">VIGENTE DESDE</span><span style="font-size:12px;">${fmtDate(c.vigencia_desde)}</span></div>
        <div class="divider"></div>
        <div class="row">
          <span style="font-size:12px;">Centros de costo: ${esc((c.cecos || []).map((x) => x.name).join(', '))}</span>
          ${c.pdf_path ? `<button class="btn-outline btn btn-sm" onclick="openPDF(event,'${c.pdf_path}')">Ver PDF</button>` : ''}
        </div>
      </div>`).join('')}
  `;
}

function screenPerfil() {
  const d = state.driverContext?.profile || {};
  const initials = (d.name || '').split(' ').map((n) => n[0]).slice(0, 2).join('');
  return `
    <div class="screen-title">Perfil</div>
    <div class="card" style="text-align:center; padding:28px 18px;">
      <div style="width:64px;height:64px;border-radius:50%;background:var(--primary-light);color:var(--primary);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-weight:800;font-size:22px;">${esc(initials)}</div>
      <div style="font-weight:700; font-size:16px;">${esc(d.name || '')}</div>
      <div style="color:var(--text-dim); font-size:13px;">${esc(d.email || '')}</div>
      <div style="color:var(--text-dim); font-size:13px;">${esc(d.rut || '')}</div>
    </div>
    <button class="btn btn-outline btn-block" onclick="driverLogout()">Cerrar sesión</button>
  `;
}
window.driverLogout = async () => {
  stopTicker();
  audit('logout').catch(() => {});
  await supabase.auth.signOut().catch(() => {});
};

export function stopDriverTicker() {
  stopTicker();
}

// ---------------------------------------------------------------------------
// Ticker: simula GPS/km y cronómetro. Persistencia cada 3 ticks.
function ensureTicker() {
  stopTicker();
  if (state.mode === 'driver' && state.driverScreen === 'activo' && state.activeTrip && state.activeTrip.status !== 'finalizado') {
    ticker = setInterval(async () => {
      const trip = state.activeTrip;
      if (!trip) return;
      tickCount++;
      if (trip.status === 'conduccion') {
        trip.total_km = Math.round((Number(trip.total_km) + 0.006 + Math.random() * 0.02) * 100) / 100;
        const last = tripVisual.routePoints[tripVisual.routePoints.length - 1];
        let nx = last[0] + (Math.random() * 16 - 6);
        let ny = last[1] + (Math.random() * 16 - 8);
        nx = Math.max(10, Math.min(210, nx));
        ny = Math.max(10, Math.min(180, ny));
        tripVisual.routePoints.push([nx, ny]);
        if (tripVisual.routePoints.length > 60) tripVisual.routePoints.shift();
      } else if (trip.status === 'espera') {
        trip.total_wait_seconds += 1;
      }
      if (tickCount % 3 === 0 && trip.status !== 'finalizado') {
        updateTrip(trip.id, {
          total_km: trip.total_km,
          total_wait_seconds: trip.total_wait_seconds,
        }).catch(() => {});
      }
      render();
    }, 1000);
  }
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  tickCount = 0;
}