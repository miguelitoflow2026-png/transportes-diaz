// App de conductor (vista móvil). Conserva el diseño y flujo del prototipo,
// pero los datos vienen de Supabase y los montos se calculan en el servidor.
import { supabase } from './supabase.js';
import { state } from './state.js';
import { esc, icon, showToast, showShell, fmtHM, fmtHMshort, fmtDate, fmtTime, formatCLP } from './lib.js';
import { loadDriverContext, fetchActiveTrip, createTrip, updateTrip, finalizeTrip, previewAmounts, getMyTrips, getContractPdfUrl, audit } from './api.js';
import { startTracking, stopTracking, pauseTracking, resumeTracking, getLastPosition, clearTrackingState, setWaitSeconds, haversineMeters, loadTrackingState } from './tracing.js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

let ticker = null;
let tickCount = 0;


// Estado de tracking GPS
let currentWatchState = null; // 'conduccion' | 'espera' | null

// Máquina de estados explícita — simplificada: solo conduccion ↔ espera → finalizado
// Nota: 'pausa' queda en el enum de DB (migración 0007) pero sin uso en frontend por simplicidad
const ESTADOS = {
  conduccion: { label: 'En conducción', chip: 'chip-conduccion', icon: '●' },
  espera: { label: 'En espera', chip: 'chip-espera', icon: '●' },
  finalizado: { label: 'Finalizado', chip: 'chip-finalizado', icon: '✓' },
};

const TRANSICIONES_VALIDAS = {
  conduccion: ['espera', 'finalizado'],
  espera: ['conduccion', 'finalizado'],
  finalizado: [],
};

function canTransition(from, to) {
  if (!from) return to === 'conduccion';
  return (TRANSICIONES_VALIDAS[from] || []).includes(to);
}

// Nominatim (OSM) — búsqueda de direcciones sin API key
let nominatimTimer = null;
async function searchNominatim(query) {
  if (!query || query.trim().length < 3) return [];
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=cl&q=${encodeURIComponent(query.trim())}`;
  try {
    const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(d => ({
      lat: parseFloat(d.lat),
      lon: parseFloat(d.lon),
      display_name: d.display_name,
      address: d.display_name.split(',').slice(0, 3).join(','),
    }));
  } catch (e) {
    console.warn('Nominatim error:', e);
    return [];
  }
}

export async function enter() {
  try {
    if (!state.driverContext) await loadDriverContext();
    const trips = await getMyTrips().catch(() => []);
    state.driverStats = { count: trips.length };
    await fetchActiveTrip();
    if (state.activeTrip) {
      if (state.activeTrip.status === 'conduccion') {
        await startGpsTracking();
      } else if (state.activeTrip.status === 'espera') {
        loadPersistedTracking();
      }
    }
    state.driverScreen = 'dashboard';
    render();
  } catch (e) {
    showToast(e.message);
    await supabase.auth.signOut().catch(() => {});
  }
}

async function startGpsTracking() {
  if (!state.activeTrip) return;
  currentWatchState = 'conduccion';
  startTracking(state.activeTrip.id, handleGpsUpdate);
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
    case 'puntos': html = screenPuntosViaje(); break;
    case 'activo': html = screenActivo(); break;
    case 'resumen': html = screenResumen(); break;
    case 'historial': html = screenHistorial(); break;
    case 'perfil': html = screenPerfil(); break;
    case 'contratos': html = screenContratos(); break;
    default: html = screenDashboard();
  }
  scr.innerHTML = html;
  if (state.driverScreen === 'activo') {
    // Inicializar mapa Leaflet tras renderizar — doble invalidate para evitar recorte
    setTimeout(() => {
      initLeafletMap();
      // Si el mapa ya existía, forzar invalidate igual (contenedor estaba oculto)
      if (leafletMap) {
        setTimeout(() => leafletMap.invalidateSize(), 80);
        setTimeout(() => leafletMap.invalidateSize(), 300);
      }
    }, 0);
    // Cargar estado persistido y actualizar mapa
    loadPersistedTracking();
  }
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
    .map(([s, label, ic]) => `<button class="${state.driverScreen === s ? 'active' : ''}" onclick="goDriverScreen('${s}')" aria-label="${label}" aria-current="${state.driverScreen === s ? 'page' : 'false'}">${icon(ic)}${label}</button>`)
    .join('');
}

export function goDriverScreen(s) {
  const prevScreen = state.driverScreen;
  state.driverScreen = s;

  if (state.activeTrip) {
    if (s === 'activo') {
      if (state.activeTrip.status === 'conduccion' && currentWatchState !== 'conduccion') {
        startGpsTracking();
      } else if (state.activeTrip.status === 'espera' && currentWatchState !== 'espera') {
        pauseGpsTracking();
        currentWatchState = 'espera';
      }
    } else {
      if (prevScreen === 'activo') {
        if (state.activeTrip.status === 'conduccion') currentWatchState = 'conduccion';
        else if (state.activeTrip.status === 'espera') currentWatchState = 'espera';
      }
    }
  }
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

  const estadoInfo = ESTADOS[active?.status] || ESTADOS.conduccion;
  const activeCard = active
    ? `
      <div class="card" style="border-color:var(--primary);">
        <div class="row">
          <span class="chip ${estadoInfo.chip}">${estadoInfo.icon} ${estadoInfo.label}</span>
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
  state.newTrip = { contractId: null, cecoId: null, vehicleId: null, tripType: 'urbano', puntoInicio: null, puntoFin: null };
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
        <label for="selContrato" class="label">Contrato / Empresa cliente</label>
        <select id="selContrato" aria-label="Contrato / Empresa cliente" onchange="onContractChange(this.value)">
          <option value="">Selecciona un contrato…</option>
          ${contractOptions}
        </select>
      </div>
      <div style="height:12px;"></div>
      <div class="field">
        <label for="selCeco" class="label">Centro de costo (CECO)</label>
        <select id="selCeco" aria-label="Centro de costo" ${!contract ? 'disabled' : ''} onchange="state.newTrip.cecoId=this.value">
          <option value="">${contract ? 'Selecciona un CECO…' : 'Primero elige un contrato'}</option>
          ${cecoOptions}
        </select>
      </div>
      <div style="height:12px;"></div>
      <div class="field">
        <label for="selVehiculo" class="label">Vehículo a usar</label>
        <select id="selVehiculo" aria-label="Vehículo a usar" onchange="state.newTrip.vehicleId=this.value">
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
    <button class="btn btn-primary btn-block" onclick="goToPuntos()">${icon('car')} Continuar — Puntos del viaje</button>
  `;
}
window.setTripType = (t) => {
  state.newTrip.tripType = t;
  goDriverScreen('tipoViaje');
};

window.goToPuntos = () => {
  if (!state.newTrip.contractId || !state.newTrip.cecoId || !state.newTrip.vehicleId) {
    showToast('Completa contrato, CECO y vehículo');
    return;
  }
  goDriverScreen('puntos');
};

function screenPuntosViaje() {
  const nt = state.newTrip;
  const tieneInicio = !!nt.puntoInicio;
  const tieneFin = !!nt.puntoFin;
  return `
    <div class="row"><button class="btn-outline btn btn-sm" onclick="goDriverScreen('tipoViaje')">← Volver</button></div>
    <div class="screen-title">Puntos del viaje</div>
    <div class="screen-sub">Indica inicio y destino (opcional, ayuda al seguimiento)</div>
    <div class="card">
      <div class="field">
        <label for="inputInicio" class="label">Punto de inicio</label>
        <input id="inputInicio" aria-label="Punto de inicio" type="text" placeholder="Ej: Av. Providencia 1200, Santiago" value="${esc(nt.puntoInicio?.display_name || '')}" oninput="onPuntoSearch('inicio', this.value)" autocomplete="off" />
        <div id="suggestInicio" class="suggest-box"></div>
        ${tieneInicio ? `<div style="margin-top:8px; font-size:12px; color:var(--good);">✓ ${esc(nt.puntoInicio.display_name)}</div>` : ''}
      </div>
      <div style="height:14px;"></div>
      <div class="field">
        <label for="inputFin" class="label">Punto de destino</label>
        <input id="inputFin" aria-label="Punto de destino" type="text" placeholder="Ej: Aeropuerto SCL" value="${esc(nt.puntoFin?.display_name || '')}" oninput="onPuntoSearch('fin', this.value)" autocomplete="off" />
        <div id="suggestFin" class="suggest-box"></div>
        ${tieneFin ? `<div style="margin-top:8px; font-size:12px; color:var(--good);">✓ ${esc(nt.puntoFin.display_name)}</div>` : '<div class="mini-label" style="margin-top:6px;">Si no indicas destino, podrás conducir igual.</div>'}
      </div>
      <div style="height:10px;"></div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-outline btn-sm" style="flex:1;" onclick="useMyLocation('inicio')">${icon('nav')} Mi ubicación como inicio</button>
        <button class="btn btn-outline btn-sm" style="flex:1;" onclick="useMyLocation('fin')">${icon('nav')} Mi ubicación como destino</button>
      </div>
    </div>
    <button class="btn btn-primary btn-block" onclick="beginTrip()">${icon('car')} Iniciar viaje — En conducción</button>
    <button class="btn btn-outline btn-block" onclick="beginTripSinPuntos()">Iniciar sin puntos</button>
  `;
}

window.onPuntoSearch = (tipo, query) => {
  clearTimeout(nominatimTimer);
  const boxId = tipo === 'inicio' ? 'suggestInicio' : 'suggestFin';
  const box = document.getElementById(boxId);
  if (!query || query.trim().length < 3) { if (box) box.innerHTML = ''; return; }
  if (box) box.innerHTML = '<div class="mini-label" style="padding:8px;">Buscando…</div>';
  nominatimTimer = setTimeout(async () => {
    const results = await searchNominatim(query);
    if (!box) return;
    if (results.length === 0) { box.innerHTML = '<div class="mini-label" style="padding:8px;">Sin resultados</div>'; return; }
    box.innerHTML = results.map(r => `<div class="suggest-item" onclick="selectPunto('${tipo}', ${r.lat}, ${r.lon}, '${esc(r.display_name).replace(/'/g, "\\'")}')">${esc(r.display_name)}</div>`).join('');
  }, 400);
};

window.selectPunto = (tipo, lat, lon, display_name) => {
  const punto = { lat, lon, display_name };
  if (tipo === 'inicio') state.newTrip.puntoInicio = punto;
  else state.newTrip.puntoFin = punto;
  const boxId = tipo === 'inicio' ? 'suggestInicio' : 'suggestFin';
  const box = document.getElementById(boxId);
  if (box) box.innerHTML = '';
  goDriverScreen('puntos');
};

window.useMyLocation = (tipo) => {
  if (!navigator.geolocation) { showToast('Geolocalización no disponible'); return; }
  showToast('Obteniendo tu ubicación…');
  navigator.geolocation.getCurrentPosition(pos => {
    const punto = { lat: pos.coords.latitude, lon: pos.coords.longitude, display_name: `Mi ubicación (${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)})` };
    if (tipo === 'inicio') state.newTrip.puntoInicio = punto;
    else state.newTrip.puntoFin = punto;
    goDriverScreen('puntos');
  }, err => showToast('No se pudo obtener ubicación: ' + err.message), { enableHighAccuracy: true, timeout: 8000 });
};

window.beginTripSinPuntos = () => window.beginTrip();

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
      total_pause_seconds: 0,
      punto_inicio: nt.puntoInicio || null,
      punto_fin: nt.puntoFin || null,
    });
    // Limpiar persistencia anterior si existe
    clearTrackingState();
    state.activeTrip = trip;
    goDriverScreen('activo');
    // El goDriverScreen llamará a startGpsTracking automáticamente
  } catch (e) {
    showToast(e.message);
  }
};

window.toggleEspera = async () => {
  const trip = state.activeTrip;
  if (!trip) return;
  const newStatus = trip.status === 'conduccion' ? 'espera' : 'conduccion';
  if (!canTransition(trip.status, newStatus)) { showToast(`Transición no válida: ${trip.status} → ${newStatus}`); return; }
  const currentKm = trip.total_km ?? 0;
  const currentWait = trip.total_wait_seconds ?? 0;
  try {
    const updated = await updateTrip(trip.id, { status: newStatus, total_km: currentKm, total_wait_seconds: currentWait });
    const serverKm = Number(updated.total_km ?? 0);
    if (currentKm > serverKm) { updated.total_km = currentKm; updateTrip(trip.id, { total_km: currentKm }).catch(() => {}); }
    state.activeTrip = updated;
    if (newStatus === 'espera') { pauseGpsTracking(); currentWatchState = 'espera'; }
    else if (newStatus === 'conduccion') { await resumeGpsTracking(); currentWatchState = 'conduccion'; }
    render();
  } catch (e) { showToast(e.message); }
};

window.openNavegar = () => {
  if (state.activeTrip) {
    const lastPos = getLastPosition();
    if (lastPos && lastPos.lat && lastPos.lon) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${lastPos.lat},${lastPos.lon}&travelmode=driving`, '_blank');
    } else {
      window.open('https://www.google.com/maps/dir/?api=1&destination=&travelmode=driving', '_blank');
    }
  } else {
    window.open('https://www.google.com/maps/dir/?api=1&destination=&travelmode=driving', '_blank');
  }
  showToast('Abriendo navegación externa (Google Maps)…');
};

window.goResumen = () => {
  // No paramos el tracking GPS al ir a resumen (solo paramos el ticker UI)
  stopTicker();
  goDriverScreen('resumen');
};

// -----------------------------------------------------------
// Funciones de tracking GPS
// -----------------------------------------------------------
function handleGpsUpdate(data) {
  if (!state.activeTrip) return;
  if (data.error) { console.warn('GPS error:', data.error); return; }
  state.activeTrip.total_km = data.totalKm;
  state.activeTrip.total_wait_seconds = data.totalWaitSeconds ?? state.activeTrip.total_wait_seconds;
  state.activeTrip.total_pause_seconds = data.totalPauseSeconds ?? state.activeTrip.total_pause_seconds;
  if (state.driverScreen === 'activo') {
    updateMapRoute(data.routePoints);
    updateMapPosition(data.lat, data.lon, data.accuracy);
    updateKmDisplay(data.totalKm);
    // Detección de llegada: si hay punto_fin y estamos a <50m, mostrar banner (sin auto-finalizar)
    const pf = state.activeTrip.punto_fin;
    if (pf && Number.isFinite(pf.lat) && Number.isFinite(pf.lon)) {
      const distM = haversineMeters(data.lat, data.lon, pf.lat, pf.lon);
      const banner = document.getElementById('arrival-banner');
      if (distM < 50) {
        if (banner) banner.classList.remove('hidden');
        else {
          // Crear banner si no existe (fallback si screenActivo no lo renderizó)
          const box = document.querySelector('.map-box');
          if (box && !document.getElementById('arrival-banner')) {
            const b = document.createElement('div');
            b.id = 'arrival-banner';
            b.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:#e6f4ea;color:var(--good);border:1px solid #a3d9b1;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,0.15);';
            b.textContent = '✓ Has llegado al destino';
            box.appendChild(b);
          }
        }
      } else {
        if (banner) banner.classList.add('hidden');
      }
    }
  }
}

function pauseGpsTracking() {
  if (!state.activeTrip) return;
  pauseTracking(state.activeTrip.id);
}

async function resumeGpsTracking() {
  if (!state.activeTrip) return;
  resumeTracking(state.activeTrip.id, handleGpsUpdate);
}

// Cargar estado persistido al volver a la app
function loadPersistedTracking() {
  if (!state.activeTrip) return;
  const saved = loadTrackingState(state.activeTrip.id);
  if (saved) {
    state.activeTrip.total_km = saved.totalKm ?? 0;
    state.activeTrip.total_wait_seconds = saved.totalWaitSeconds ?? 0;
    state.activeTrip.total_pause_seconds = saved.totalPauseSeconds ?? 0;
    if (state.driverScreen === 'activo') {
      updateMapRoute(saved.routePoints ?? []);
      if (saved.lastLat != null && saved.lastLon != null) {
        updateMapPosition(saved.lastLat, saved.lastLon);
      }
      updateKmDisplay(saved.totalKm ?? 0);
    }
  }
}

// -----------------------------------------------------------
// Mapa Leaflet
// -----------------------------------------------------------
let leafletMap = null;
let routePolyline = null;
let positionMarker = null;
let followUser = true; // si true, el mapa sigue al usuario automáticamente

function initLeafletMap() {
  const container = document.getElementById('leaflet-map');
  if (!container) return;

  // Si el mapa ya existe pero el contenedor es nuevo (re-render por innerHTML), limpiar el anterior para evitar duplicado/sombra
  if (leafletMap) {
    const oldContainer = leafletMap.getContainer();
    if (oldContainer !== container) {
      try { leafletMap.remove(); } catch (e) {}
      leafletMap = null; routePolyline = null; positionMarker = null;
    } else {
      setTimeout(() => leafletMap.invalidateSize(), 80);
      setTimeout(() => leafletMap.invalidateSize(), 300);
      return;
    }
  }

  // Centro inicial: punto_inicio del viaje si existe, si no Santiago
  const tripForCenter = state.activeTrip;
  let initialCenter = [-33.4489, -70.6693];
  let initialZoom = 15;
  if (tripForCenter?.punto_inicio && Number.isFinite(tripForCenter.punto_inicio.lat) && Number.isFinite(tripForCenter.punto_inicio.lon)) {
    initialCenter = [tripForCenter.punto_inicio.lat, tripForCenter.punto_inicio.lon];
    initialZoom = 14;
  } else if (tripForCenter?.punto_fin && Number.isFinite(tripForCenter.punto_fin.lat) && Number.isFinite(tripForCenter.punto_fin.lon)) {
    initialCenter = [tripForCenter.punto_fin.lat, tripForCenter.punto_fin.lon];
    initialZoom = 14;
  }
  leafletMap = L.map('leaflet-map', {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  }).setView(initialCenter, initialZoom);

  // Tiles OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(leafletMap);

  // Ruta sugerida por calles (OSRM) + marcadores origen/destino
  const tp = state.activeTrip;
  let osrmLine = null;
  const addOsrmRoute = async () => {
    if (!tp?.punto_inicio || !tp?.punto_fin || !Number.isFinite(tp.punto_inicio.lat) || !Number.isFinite(tp.punto_fin.lat)) {
      if (tp?.punto_inicio) L.circleMarker([tp.punto_inicio.lat, tp.punto_inicio.lon], { radius: 7, fillColor: '#1b7a43', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(leafletMap).bindTooltip('Origen', { permanent: false });
      return;
    }
    // Marcadores
    L.circleMarker([tp.punto_inicio.lat, tp.punto_inicio.lon], { radius: 7, fillColor: '#1b7a43', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(leafletMap).bindTooltip('Origen', { permanent: false });
    L.marker([tp.punto_fin.lat, tp.punto_fin.lon], { icon: L.divIcon({ html: '<div style="background:#b3261e;width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3)"></div>', iconSize: [14,14], iconAnchor: [7,7] }) }).addTo(leafletMap).bindTooltip('Destino', { permanent: false });
    // OSRM - ruta real por calles
    const url = `https://router.project-osrm.org/route/v1/driving/${tp.punto_inicio.lon},${tp.punto_inicio.lat};${tp.punto_fin.lon},${tp.punto_fin.lat}?overview=full&geometries=geojson&steps=true`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('OSRM ' + res.status);
      const data = await res.json();
      if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(data.code);
      const route = data.routes[0];
      const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      osrmLine = L.polyline(coords, { color: '#2563eb', weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(leafletMap);
      // Ajustar vista para mostrar toda la ruta si aún no hay seguimiento
      if (routePolyline.getLatLngs().length === 0) {
        leafletMap.fitBounds(osrmLine.getBounds(), { padding: [30, 30], maxZoom: 15 });
      }
      // Guardar instrucciones para panel (opcional)
      window._osrmSteps = route.legs[0]?.steps || [];
      window._osrmSummary = { distance: route.distance, duration: route.duration };
      console.log('[OSRM] ruta', { km: (route.distance/1000).toFixed(1), min: Math.round(route.duration/60), steps: window._osrmSteps.length });
      // Mostrar resumen breve sobre el mapa
      const summaryEl = document.getElementById('route-summary');
      if (summaryEl) {
        summaryEl.textContent = `${(route.distance/1000).toFixed(1)} km · ${Math.round(route.duration/60)} min · ${window._osrmSteps.length} giros`;
        summaryEl.classList.remove('hidden');
      }
    } catch (e) {
      console.warn('[OSRM] fallback a línea recta:', e.message);
      L.polyline([[tp.punto_inicio.lat, tp.punto_inicio.lon], [tp.punto_fin.lat, tp.punto_fin.lon]], {
        color: '#9ca3af', weight: 3, opacity: 0.6, dashArray: '8, 8', lineCap: 'round',
      }).addTo(leafletMap);
    }
  };
  addOsrmRoute();

  // Polilínea de la ruta recorrida
  routePolyline = L.polyline([], {
    color: '#1a237e',
    weight: 4,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
  }).addTo(leafletMap);

  // Marcador de posición actual — azul pulsante, siempre visible
  positionMarker = L.circleMarker([0, 0], {
    radius: 10,
    fillColor: '#2563eb',
    color: '#fff',
    weight: 3,
    opacity: 1,
    fillOpacity: 1,
  }).addTo(leafletMap);
  // Pulso exterior (efecto radar)
  const pulse = L.circleMarker([0, 0], { radius: 18, fillColor: '#2563eb', color: '#2563eb', weight: 1, opacity: 0.25, fillOpacity: 0.15 }).addTo(leafletMap);
  // Sincronizar pulso con posición
  const origSetLatLng = positionMarker.setLatLng.bind(positionMarker);
  positionMarker.setLatLng = (latlng) => { origSetLatLng(latlng); pulse.setLatLng(latlng); return positionMarker; };

  // Forzar resize después de un tick (por si el contenedor estaba oculto) — triple para cubrir animaciones
  setTimeout(() => leafletMap.invalidateSize(), 80);
  setTimeout(() => leafletMap.invalidateSize(), 300);
  setTimeout(() => leafletMap.invalidateSize(), 700);

  // ResizeObserver + window resize para recalcular tamaño si el layout cambia
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => leafletMap.invalidateSize());
    ro.observe(container);
  }
  window.addEventListener('resize', () => leafletMap.invalidateSize());

  // Botón recentrar
  window.recenterMap = () => {
    followUser = true;
    if (positionMarker && positionMarker.getLatLng) {
      const pos = positionMarker.getLatLng();
      if (pos.lat !== 0 || pos.lng !== 0) {
        leafletMap.setView([pos.lat, pos.lng], 17, { animate: true });
      }
    }
  };

  // Detectar movimiento manual del usuario
  leafletMap.on('dragstart zoomstart', () => {
    followUser = false;
  });
}

function updateMapRoute(routePoints) {
  if (!leafletMap || !routePolyline) return;
  if (!routePoints || routePoints.length === 0) {
    routePolyline.setLatLngs([]);
    return;
  }
  const latLngs = routePoints.map(p => [p.lat, p.lon]).filter(p => p[0] != null && p[1] != null && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (latLngs.length === 0) return;
  // Validar que no haya outliers que formen V gigante: si el bounds es >100km, no hacer fitBounds (evita zoom out por mancha)
  const bounds = L.latLngBounds(latLngs);
  const diagKm = haversineMeters(bounds.getSouthWest().lat, bounds.getSouthWest().lng, bounds.getNorthEast().lat, bounds.getNorthEast().lng) / 1000;
  if (diagKm > 100) {
    console.warn('[Mapa] ruta con bounds >100km, posible mancha, no se hace fitBounds', diagKm);
    // Solo centrar en último punto sin ajustar zoom
    if (followUser && latLngs.length > 0) {
      leafletMap.setView(latLngs[latLngs.length - 1], leafletMap.getZoom(), { animate: false });
    }
  } else if (followUser && latLngs.length === 1) {
    // Primer punto: centrar
    leafletMap.setView(latLngs[0], 16, { animate: true });
  } else if (followUser && latLngs.length <= 5) {
    // Primeros puntos: ajustar bounds una vez
    leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 16, animate: true });
  }
  routePolyline.setLatLngs(latLngs);
}

function updateMapPosition(lat, lon, accuracy) {
  if (!leafletMap || !positionMarker) return;
  if (lat == null || lon == null) return;

  const latLng = L.latLng(lat, lon);
  positionMarker.setLatLng(latLng);

  // Actualizar círculo de precisión si se proporciona
  if (accuracy && accuracy > 0) {
    positionMarker.setRadius(Math.max(8, accuracy / 2));
  }

  if (followUser) {
    leafletMap.setView(latLng, leafletMap.getZoom(), { animate: true, duration: 0.5 });
  }
}

function updateKmDisplay(totalKm) {
  const el = document.getElementById('km-display');
  if (el) el.textContent = Number(totalKm || 0).toFixed(2);
}

function updateWaitDisplay(totalWaitSeconds) {
  const el = document.getElementById('wait-display');
  if (el) {
    // fmtHM no está disponible aquí, usamos implementación local
    const h = Math.floor(totalWaitSeconds / 3600);
    const m = Math.floor((totalWaitSeconds % 3600) / 60);
    const s = totalWaitSeconds % 60;
    el.textContent = h > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}

function screenActivo() {
  const trip = state.activeTrip;
  if (!trip) return screenDashboard();
  const contract = contractById(trip.contract_id) || {};
  const ceco = cecoOf(contract, trip.ceco_id);
  const veh = vehicleById(trip.vehicle_id);
  const startMs = trip.start_time ? new Date(trip.start_time).getTime() : Date.now();
  const elapsedTotal = Number.isFinite(startMs) ? Math.max(0, (Date.now() - startMs) / 1000) : 0;
  const estadoInfo = ESTADOS[trip.status] || ESTADOS.conduccion;
  const puntoInicioTxt = trip.punto_inicio?.display_name ? esc(trip.punto_inicio.display_name.split(',').slice(0,2).join(',')) : '';
  const puntoFinTxt = trip.punto_fin?.display_name ? esc(trip.punto_fin.display_name.split(',').slice(0,2).join(',')) : '';
  // Botón único que alterna según estado (simplificado: solo conduccion ↔ espera)
  const actionButtons = trip.status === 'conduccion'
    ? `<button class="btn btn-wait btn-block" onclick="toggleEspera()">${icon('pause')} Iniciar espera</button>`
    : `<button class="btn btn-primary btn-block" onclick="toggleEspera()">${icon('car')} Reanudar viaje</button>`;
  const metricSecond = `<div class="card gray" style="text-align:center;"><div class="mini-label">TIEMPO ESPERA</div><div class="big-stat" id="wait-display" style="color:var(--wait);">${fmtHM(trip.total_wait_seconds || 0)}</div></div>`;

  return `
    <div class="row">
      <span class="chip ${estadoInfo.chip}">${estadoInfo.icon} ${estadoInfo.label}</span>
      <span class="mini-label">${fmtHM(elapsedTotal)}</span>
    </div>
    <div class="map-box">
      <div id="leaflet-map" style="width:100%; height:100%;"></div>
      <div id="arrival-banner" class="hidden" style="position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:#e6f4ea;color:var(--good);border:1px solid #a3d9b1;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,0.15);">✓ Has llegado al destino</div>
      <div id="route-summary" class="hidden" style="position:absolute;top:10px;right:10px;z-index:1000;background:rgba(255,255,255,0.96);border:1px solid var(--border);padding:6px 10px;border-radius:8px;font-size:11px;font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,0.12); max-width:55%; text-align:right;"></div>
      <button id="btn-recenter" class="btn btn-sm" style="position:absolute; bottom:34px; right:12px; z-index:1000; padding:8px 14px; border-radius:20px; box-shadow:0 2px 8px rgba(0,0,0,0.22); background:#fff; border:1px solid var(--border);" onclick="recenterMap()" title="Centrar en mi posición">
        ${icon('nav')} Centrar
      </button>
    </div>
    <div class="card">
      <div class="row"><span class="mini-label">CONTRATO</span><span style="font-size:12px; font-weight:600;">${esc(contract.name || '')}</span></div>
      <div class="row"><span class="mini-label">CECO</span><span style="font-size:12px;">${esc(ceco?.name || '')}</span></div>
      <div class="row"><span class="mini-label">VEHÍCULO</span><span style="font-size:12px;">${esc(veh?.plate || '')}</span></div>
      <div class="row"><span class="mini-label">TIPO DE VIAJE</span><span style="font-size:12px; text-transform:capitalize;">${esc(trip.trip_type)}</span></div>
      ${puntoInicioTxt ? `<div class="row"><span class="mini-label">ORIGEN</span><span style="font-size:11px; text-align:right; max-width:60%;">${puntoInicioTxt}</span></div>` : ''}
      ${puntoFinTxt ? `<div class="row"><span class="mini-label">DESTINO</span><span style="font-size:11px; text-align:right; max-width:60%;">${puntoFinTxt}</span></div>` : ''}
    </div>
    <div class="grid-2" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div class="card gray" style="text-align:center;">
        <div class="mini-label">KM RECORRIDOS</div>
        <div class="big-stat" id="km-display">${Number(trip.total_km || 0).toFixed(2)}</div>
      </div>
      ${metricSecond}
    </div>
    <button class="btn btn-outline btn-block" onclick="openNavegar()">${icon('nav')} Navegar (Google Maps / Waze)</button>
    ${actionButtons}
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
      <label class="label">Tipo de viaje aplicado</label>
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
      <label for="tripNotes" class="label">Observaciones (opcional)</label>
      <textarea id="tripNotes" aria-label="Observaciones" placeholder="Nombre del pasajero, motivo del viaje, notas…" maxlength="2000">${esc(trip.notes || '')}</textarea>
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
    stopTracking(trip.id);
    clearTrackingState();
    leafletMap = null; routePolyline = null; positionMarker = null;
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
  if (state.activeTrip) stopTracking(state.activeTrip.id);
  stopTicker();
  audit('logout').catch(() => {});
  await supabase.auth.signOut().catch(() => {});
};

export function stopDriverTicker() {
  stopTicker();
}

// ---------------------------------------------------------------------------
// Ticker: actualiza contadores de espera/pausa. Los km los maneja GPS tracking.
function ensureTicker() {
  stopTicker();
  if (state.mode === 'driver' && state.driverScreen === 'activo' && state.activeTrip && state.activeTrip.status !== 'finalizado') {
    ticker = setInterval(async () => {
      const trip = state.activeTrip;
      if (!trip) return;
      tickCount++;
      if (trip.status === 'espera') {
        trip.total_wait_seconds = (trip.total_wait_seconds ?? 0) + 1;
        try { setWaitSeconds(trip.id, trip.total_wait_seconds); } catch (e) {}
        updateWaitDisplay(trip.total_wait_seconds);
      }
      if (tickCount % 3 === 0 && trip.status === 'espera') {
        updateTrip(trip.id, { total_wait_seconds: trip.total_wait_seconds }).catch(() => {});
      }
    }, 1000);
  }
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  tickCount = 0;
}