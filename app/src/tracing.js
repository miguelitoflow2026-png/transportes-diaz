// tracing.js — Módulo de tracking GPS real para la app de conductor
// Reemplaza la simulación por GPS real con persistencia y sync a Supabase

import { supabase } from './supabase.js';
import { state } from './state.js';

const STORAGE_KEY = 'td-trip-tracking';
const SYNC_INTERVAL_MS = 30000; // cada 30s sincroniza a Supabase
const MIN_DISTANCE_M = 5; // solo guarda posición si se movió >5m

let watchId = null;
let wakeLock = null;
let syncTimer = null;
let isTracking = false;

// -----------------------------------------------------------
// Haversine: distancia en metros entre dos puntos lat/lon
// -----------------------------------------------------------
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // radio Tierra en metros
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// -----------------------------------------------------------
// localStorage: persistencia del estado del viaje
// -----------------------------------------------------------
export function saveTrackingState(tripId, data) {
  const payload = {
    tripId,
    totalKm: data.totalKm ?? 0,
    totalWaitSeconds: data.totalWaitSeconds ?? 0,
    lastLat: data.lastLat ?? null,
    lastLon: data.lastLon ?? null,
    lastRecordedAt: data.lastRecordedAt ?? null,
    routePoints: data.routePoints ?? [], // [{lat, lon, accuracy, timestamp}]
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('No se pudo guardar tracking state:', e);
  }
}

export function loadTrackingState(tripId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.tripId !== tripId) return null; // viaje distinto
    return parsed;
  } catch (e) {
    console.warn('No se pudo cargar tracking state:', e);
    return null;
  }
}

export function clearTrackingState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('No se pudo limpiar tracking state:', e);
  }
}

// -----------------------------------------------------------
// Wake Lock: evitar que la pantalla se apague (si el navegador lo permite)
// -----------------------------------------------------------
export async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      return true;
    } catch (e) {
      console.warn('Wake Lock no disponible:', e.message);
      return false;
    }
  }
  return false;
}

export function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// -----------------------------------------------------------
// Sync a Supabase: guarda total_km en trips + posiciones en trip_positions
// -----------------------------------------------------------
export async function syncToSupabase(tripId, data) {
  if (!tripId) return;

  // 1) Actualizar total_km y total_wait_seconds en trips
  try {
    await supabase
      .from('trips')
      .update({
        total_km: data.totalKm,
        total_wait_seconds: data.totalWaitSeconds,
        updated_at: new Date().toISOString(),
      })
      .eq('id', tripId)
      .eq('driver_id', state.user?.id);
  } catch (e) {
    console.warn('Sync trips falló:', e.message);
  }

  // 2) Insertar últimas posiciones en trip_positions vía RLS (sin recalcular km server-side)
  // Usamos insert directo; km ya se sincronizó arriba con el valor del cliente.
  if (data.routePoints && data.routePoints.length > 0) {
    // Enviar solo los últimos 10 puntos no sincronizados para no saturar
    const toSync = data.routePoints.slice(-10);
    const rows = toSync.map(p => ({
      trip_id: tripId,
      driver_id: state.user?.id,
      lat: p.lat,
      lon: p.lon,
      accuracy: p.accuracy ?? null,
      altitude: p.altitude ?? null,
      speed: p.speed ?? null,
      heading: p.heading ?? null,
      recorded_at: p.timestamp || new Date().toISOString(),
    }));
    try {
      await supabase.from('trip_positions').insert(rows);
    } catch (e) {
      // Silenciar duplicados por RLS o red
      console.warn('Sync positions falló:', e.message);
    }
  }
}

// -----------------------------------------------------------
// Iniciar/Parar tracking GPS
// -----------------------------------------------------------
export function startTracking(tripId, onPositionUpdate) {
  if (isTracking) return;
  if (!navigator.geolocation) {
    console.warn('Geolocation API no soportada');
    onPositionUpdate?.({ error: 'Geolocation no soportada' });
    return;
  }

  isTracking = true;

  // Cargar estado previo si existe
  const saved = loadTrackingState(tripId);
  let totalKm = 0;
  let totalWaitSeconds = 0;
  let routePoints = [];
  let lastLat = null;
  let lastLon = null;
  let lastRecordedAt = null;

  if (saved) {
    totalKm = saved.totalKm ?? 0;
    totalWaitSeconds = saved.totalWaitSeconds ?? 0;
    lastLat = saved.lastLat;
    lastLon = saved.lastLon;
    lastRecordedAt = saved.lastRecordedAt;
    routePoints = saved.routePoints ?? [];
    console.log('Estado de tracking recuperado:', { totalKm, points: routePoints.length });
  }

  // Solicitar Wake Lock
  requestWakeLock();

  // Callback de posición
  const handlePosition = (pos) => {
    const { latitude, longitude, accuracy, altitude, speed, heading } = pos.coords;
    const timestamp = pos.timestamp;

    // Filtrar por precisión (ignorar si accuracy > 50m)
    if (accuracy > 50) return;

    // Calcular distancia incremental desde la última posición válida
    let incKm = 0;
    if (lastLat != null && lastLon != null) {
      const distM = haversineMeters(lastLat, lastLon, latitude, longitude);
      if (distM >= MIN_DISTANCE_M) {
        incKm = distM / 1000;
        totalKm = Math.round((totalKm + incKm) * 100) / 100;
      }
    }

    // Actualizar último punto conocido
    lastLat = latitude;
    lastLon = longitude;
    lastRecordedAt = new Date(timestamp).toISOString();

    // Guardar punto en ruta (para el mapa)
    routePoints.push({ lat: latitude, lon: longitude, accuracy, altitude, speed, heading, timestamp: lastRecordedAt });
    if (routePoints.length > 500) routePoints.shift(); // límite memoria

    // Persistir localStorage en cada posición válida
    saveTrackingState(tripId, {
      totalKm,
      totalWaitSeconds,
      lastLat,
      lastLon,
      lastRecordedAt,
      routePoints,
    });

    // Notificar a la UI (para actualizar km y mapa)
    onPositionUpdate?.({
      lat: latitude,
      lon: longitude,
      accuracy,
      altitude,
      speed,
      heading,
      totalKm,
      totalWaitSeconds,
      routePoints: [...routePoints], // copia
      incKm,
    });
  };

  const handleError = (err) => {
    console.warn('Error geolocation:', err.code, err.message);
    onPositionUpdate?.({ error: err.message });
  };

  // watchPosition con alta precisión
  watchId = navigator.geolocation.watchPosition(handlePosition, handleError, {
    enableHighAccuracy: true,
    maximumAge: 1000, // aceptar posiciones de hasta 1s
    timeout: 10000,
  });

  // Timer de sync periódico a Supabase
  syncTimer = setInterval(async () => {
    const currentState = loadTrackingState(tripId);
    if (currentState && currentState.lastLat != null) {
      await syncToSupabase(tripId, currentState);
      console.log('Sync a Supabase completado');
    }
  }, SYNC_INTERVAL_MS);
}

export function stopTracking(tripId) {
  if (!isTracking) return;
  isTracking = false;

  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  releaseWakeLock();

  // Sync final al parar
  if (tripId) {
    const saved = loadTrackingState(tripId);
    if (saved) {
      syncToSupabase(tripId, saved).then(() => {
        console.log('Sync final completado');
      });
    }
  }
}

export function pauseTracking() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  releaseWakeLock();
  isTracking = false;
}

export function resumeTracking(tripId, onPositionUpdate) {
  // Reanuda desde donde quedó (usando localStorage)
  if (isTracking) return;
  startTracking(tripId, onPositionUpdate);
}

export function getTrackingStatus() {
  return {
    isTracking,
    hasWatchId: watchId !== null,
    hasWakeLock: wakeLock !== null,
  };
}

// -----------------------------------------------------------
// Utilidades para la UI del mapa
// -----------------------------------------------------------
export function getRoutePoints() {
  const saved = loadTrackingState(state.activeTrip?.id);
  return saved?.routePoints ?? [];
}

export function getLastPosition() {
  const saved = loadTrackingState(state.activeTrip?.id);
  if (!saved) return null;
  return {
    lat: saved.lastLat,
    lon: saved.lastLon,
    accuracy: null,
    timestamp: saved.lastRecordedAt,
  };
}

export function getTotalKm() {
  const saved = loadTrackingState(state.activeTrip?.id);
  return saved?.totalKm ?? 0;
}