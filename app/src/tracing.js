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
    totalPauseSeconds: data.totalPauseSeconds ?? 0,
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

  // 1) Actualizar totales en trips (km, espera y pausa separados)
  try {
    await supabase
      .from('trips')
      .update({
        total_km: data.totalKm,
        total_wait_seconds: data.totalWaitSeconds,
        total_pause_seconds: data.totalPauseSeconds ?? 0,
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
  let totalPauseSeconds = 0;
  let routePoints = [];
  let lastLat = null;
  let lastLon = null;
  let lastRecordedAt = null;

  if (saved) {
    totalKm = saved.totalKm ?? 0;
    totalWaitSeconds = saved.totalWaitSeconds ?? 0;
    totalPauseSeconds = saved.totalPauseSeconds ?? 0;
    lastLat = saved.lastLat;
    lastLon = saved.lastLon;
    lastRecordedAt = saved.lastRecordedAt;
    let loadedPoints = saved.routePoints ?? [];
    // Limpieza de puntos viejos erráticos (mancha negra/V): filtrar 0,0, NaN, fuera de Chile y saltos >50km entre puntos consecutivos
    const CHILE_BOUNDS = { latMin: -56, latMax: -17, lonMin: -76, lonMax: -66 };
    const cleaned = [];
    for (const p of loadedPoints) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      if (p.lat === 0 && p.lon === 0) continue;
      if (p.lat < CHILE_BOUNDS.latMin || p.lat > CHILE_BOUNDS.latMax || p.lon < CHILE_BOUNDS.lonMin || p.lon > CHILE_BOUNDS.lonMax) {
        console.warn('[GPS limpieza] punto fuera de Chile descartado', p);
        continue;
      }
      if (cleaned.length > 0) {
        const prev = cleaned[cleaned.length - 1];
        const d = haversineMeters(prev.lat, prev.lon, p.lat, p.lon);
        if (d > 50000) { // >50km entre puntos consecutivos es outlier (ej. salto Santiago-Osorno)
          console.warn('[GPS limpieza] salto >50km descartado', { prev, p, d });
          continue;
        }
      }
      cleaned.push(p);
    }
    if (cleaned.length !== loadedPoints.length) {
      console.log(`[GPS limpieza] ${loadedPoints.length} → ${cleaned.length} puntos (filtrados ${loadedPoints.length - cleaned.length})`);
      // Si se filtraron muchos puntos, recalcular lastLat/Lon desde el último válido
      if (cleaned.length > 0) {
        const last = cleaned[cleaned.length - 1];
        lastLat = last.lat; lastLon = last.lon;
        lastRecordedAt = last.timestamp;
      } else {
        lastLat = null; lastLon = null; lastRecordedAt = null;
      }
    }
    routePoints = cleaned;
    // Si se limpiaron puntos, persistir el estado limpio para no volver a mostrar mancha
    if (cleaned.length !== loadedPoints.length) {
      saveTrackingState(tripId, { totalKm, totalWaitSeconds, totalPauseSeconds, lastLat, lastLon, lastRecordedAt, routePoints: cleaned });
    }
    console.log('Estado de tracking recuperado:', { totalKm, points: routePoints.length, cleanedFrom: loadedPoints.length });
  }

  // Solicitar Wake Lock
  requestWakeLock();

  // Callback de posición — con filtros robustos anti-outliers + debug temporal
  const handlePosition = (pos) => {
    let { latitude, longitude, accuracy, altitude, speed, heading } = pos.coords;
    const timestamp = pos.timestamp;

    // DEBUG temporal: log de posición cruda (remover después de depurar V)
    console.log('[GPS raw]', { latitude, longitude, accuracy: accuracy?.toFixed(1), speed: speed?.toFixed(1), heading, timestamp: new Date(timestamp).toISOString(), lastLat, lastLon, routePointsLen: routePoints.length });

    // --- Fix 1: descartar coordenadas nulas/inválidas ---
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      console.warn('[GPS descartado] NaN/Infinite', { latitude, longitude });
      return;
    }
    if (latitude === 0 && longitude === 0) {
      console.warn('[GPS descartado] (0,0) placeholder');
      return;
    }
    if (Math.abs(latitude) > 90 && Math.abs(longitude) <= 90) {
      // Inversión clara lat/lng
      console.warn('[GPS corregido] Inversión lat/lng detectada');
      const tmp = latitude; latitude = longitude; longitude = tmp;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      console.warn('[GPS descartado] fuera de rango', { latitude, longitude });
      return;
    }
    if (accuracy != null && accuracy > 50) {
      console.warn('[GPS descartado] accuracy mala', accuracy);
      return;
    }

    // --- Fix 2: filtro de velocidad/outlier + evitar mancha por puntos densos ---
    let incKm = 0;
    let shouldAddToPolyline = false;
    if (lastLat != null && lastLon != null) {
      const distM = haversineMeters(lastLat, lastLon, latitude, longitude);
      const dtSec = lastRecordedAt ? (timestamp - new Date(lastRecordedAt).getTime()) / 1000 : 1;
      const speedMps = dtSec > 0 ? distM / dtSec : 0;
      console.log('[GPS delta]', { distM: distM.toFixed(1), dtSec: dtSec.toFixed(1), speedKmh: (speedMps*3.6).toFixed(1) });
      if (speedMps > 41.6) { // 150 km/h, ajustado para vehículo urbano
        console.warn(`[GPS descartado] Outlier velocidad ${distM.toFixed(0)}m en ${dtSec.toFixed(1)}s (${(speedMps*3.6).toFixed(0)} km/h)`);
        return;
      }
      if (distM < 0.5) {
        console.log('[GPS descartado] ruido <0.5m');
        return;
      }
      if (distM >= MIN_DISTANCE_M) {
        incKm = distM / 1000;
        totalKm = Math.round((totalKm + incKm) * 100) / 100;
        shouldAddToPolyline = true;
      } else {
        // Movimiento 0.5-5m: NO agregar a polyline para evitar mancha negra por puntos densos
        console.log(`[GPS no polyline] movimiento pequeño ${distM.toFixed(1)}m (<5m), solo actualiza posición`);
        // Actualizar lastLat/Lon pero no agregar a ruta densa
        lastLat = latitude;
        lastLon = longitude;
        lastRecordedAt = new Date(timestamp).toISOString();
        // Notificar solo posición, sin agregar a routePoints
        onPositionUpdate?.({
          lat: latitude, lon: longitude, accuracy, altitude, speed, heading,
          totalKm, totalWaitSeconds, totalPauseSeconds,
          routePoints: [...routePoints], incKm: 0,
        });
        return;
      }
    } else if (routePoints.length > 0) {
      const last = routePoints[routePoints.length - 1];
      const distM = haversineMeters(last.lat, last.lon, latitude, longitude);
      if (distM < 0.5) {
        console.log('[GPS descartado] duplicado <0.5m vs ruta');
        return;
      }
      // Para recarga, el primer punto nuevo debe ser >=5m del último guardado para ser considerado movimiento real
      if (distM < MIN_DISTANCE_M) {
        console.log(`[GPS primer punto post-recarga] ${distM.toFixed(1)}m <5m, esperando movimiento real`);
        // No agregar aún, pero actualizar lastLat para próxima comparación
        lastLat = latitude; lastLon = longitude; lastRecordedAt = new Date(timestamp).toISOString();
        return;
      }
      shouldAddToPolyline = true;
    } else {
      // Primer punto absoluto del viaje — siempre agregar
      shouldAddToPolyline = true;
    }

    // Actualizar último punto conocido y guardar en ruta solo si es movimiento real
    lastLat = latitude;
    lastLon = longitude;
    lastRecordedAt = new Date(timestamp).toISOString();

    if (shouldAddToPolyline) {
      routePoints.push({ lat: latitude, lon: longitude, accuracy, altitude, speed, heading, timestamp: lastRecordedAt });
      if (routePoints.length > 500) routePoints.shift(); // límite memoria
      console.log('[GPS polyline] punto agregado', { lat: latitude.toFixed(5), lon: longitude.toFixed(5), totalKm, points: routePoints.length });
    }

    // Persistir localStorage en cada posición válida
    saveTrackingState(tripId, {
      totalKm,
      totalWaitSeconds,
      totalPauseSeconds,
      lastLat,
      lastLon,
      lastRecordedAt,
      routePoints,
    });

    // Notificar a la UI (para actualizar km y mapa) — incluye detección de llegada si el caller provee puntoFin
    onPositionUpdate?.({
      lat: latitude,
      lon: longitude,
      accuracy,
      altitude,
      speed,
      heading,
      totalKm,
      totalWaitSeconds,
      totalPauseSeconds,
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

export function setWaitSeconds(tripId, seconds) {
  const saved = loadTrackingState(tripId) || { totalKm: 0, routePoints: [] };
  saveTrackingState(tripId, {
    totalKm: saved.totalKm ?? 0,
    totalWaitSeconds: seconds,
    totalPauseSeconds: saved.totalPauseSeconds ?? 0,
    lastLat: saved.lastLat ?? null,
    lastLon: saved.lastLon ?? null,
    lastRecordedAt: saved.lastRecordedAt ?? null,
    routePoints: saved.routePoints ?? [],
  });
}

export function setPauseSeconds(tripId, seconds) {
  const saved = loadTrackingState(tripId) || { totalKm: 0, routePoints: [] };
  saveTrackingState(tripId, {
    totalKm: saved.totalKm ?? 0,
    totalWaitSeconds: saved.totalWaitSeconds ?? 0,
    totalPauseSeconds: seconds,
    lastLat: saved.lastLat ?? null,
    lastLon: saved.lastLon ?? null,
    lastRecordedAt: saved.lastRecordedAt ?? null,
    routePoints: saved.routePoints ?? [],
  });
}