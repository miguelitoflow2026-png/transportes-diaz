// services/map.js — Lógica de mapa Leaflet extraída de driver.js (refactor incremental P1)
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { state } from '../state.js';

let leafletMap = null;
let routePolyline = null;
let positionMarker = null;
let followUser = true;

export function getMap() { return leafletMap; }
export function isMapReady() { return !!leafletMap; }

export function initLeafletMap() {
  const container = document.getElementById('leaflet-map');
  if (!container) return;
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
  leafletMap = L.map('leaflet-map', { zoomControl: true, attributionControl: true, preferCanvas: true }).setView(initialCenter, initialZoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(leafletMap);
  const tp = state.activeTrip;
  let osrmLine = null;
  const addOsrmRoute = async () => {
    if (!tp?.punto_inicio || !tp?.punto_fin || !Number.isFinite(tp.punto_inicio.lat) || !Number.isFinite(tp.punto_fin.lat)) {
      if (tp?.punto_inicio) L.circleMarker([tp.punto_inicio.lat, tp.punto_inicio.lon], { radius: 7, fillColor: '#1b7a43', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(leafletMap).bindTooltip('Origen', { permanent: false });
      return;
    }
    L.circleMarker([tp.punto_inicio.lat, tp.punto_inicio.lon], { radius: 7, fillColor: '#1b7a43', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(leafletMap).bindTooltip('Origen', { permanent: false });
    L.marker([tp.punto_fin.lat, tp.punto_fin.lon], { icon: L.divIcon({ html: '<div style="background:#b3261e;width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3)"></div>', iconSize: [14,14], iconAnchor: [7,7] }) }).addTo(leafletMap).bindTooltip('Destino', { permanent: false });
    const url = `https://router.project-osrm.org/route/v1/driving/${tp.punto_inicio.lon},${tp.punto_inicio.lat};${tp.punto_fin.lon},${tp.punto_fin.lat}?overview=full&geometries=geojson&steps=true`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('OSRM ' + res.status);
      const data = await res.json();
      if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(data.code);
      const route = data.routes[0];
      const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      osrmLine = L.polyline(coords, { color: '#2563eb', weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(leafletMap);
      if (routePolyline && routePolyline.getLatLngs().length === 0) {
        leafletMap.fitBounds(osrmLine.getBounds(), { padding: [30, 30], maxZoom: 15 });
      }
      window._osrmSteps = route.legs[0]?.steps || [];
      window._osrmSummary = { distance: route.distance, duration: route.duration };
      const summaryEl = document.getElementById('route-summary');
      if (summaryEl) {
        summaryEl.textContent = `${(route.distance/1000).toFixed(1)} km · ${Math.round(route.duration/60)} min · ${window._osrmSteps.length} giros`;
        summaryEl.classList.remove('hidden');
      }
    } catch (e) {
      L.polyline([[tp.punto_inicio.lat, tp.punto_inicio.lon], [tp.punto_fin.lat, tp.punto_fin.lon]], { color: '#9ca3af', weight: 3, opacity: 0.6, dashArray: '8, 8', lineCap: 'round' }).addTo(leafletMap);
    }
  };
  addOsrmRoute();
  routePolyline = L.polyline([], { color: '#1a237e', weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(leafletMap);
  positionMarker = L.circleMarker([0, 0], { radius: 10, fillColor: '#2563eb', color: '#fff', weight: 3, opacity: 1, fillOpacity: 1 }).addTo(leafletMap);
  const pulse = L.circleMarker([0, 0], { radius: 18, fillColor: '#2563eb', color: '#2563eb', weight: 1, opacity: 0.25, fillOpacity: 0.15 }).addTo(leafletMap);
  const origSetLatLng = positionMarker.setLatLng.bind(positionMarker);
  positionMarker.setLatLng = (latlng) => { origSetLatLng(latlng); pulse.setLatLng(latlng); return positionMarker; };
  setTimeout(() => leafletMap.invalidateSize(), 80);
  setTimeout(() => leafletMap.invalidateSize(), 300);
  setTimeout(() => leafletMap.invalidateSize(), 700);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => leafletMap.invalidateSize());
    ro.observe(container);
  }
  window.addEventListener('resize', () => leafletMap.invalidateSize());
  window.recenterMap = () => {
    followUser = true;
    if (positionMarker && positionMarker.getLatLng) {
      const pos = positionMarker.getLatLng();
      if (pos.lat !== 0 || pos.lng !== 0) leafletMap.setView([pos.lat, pos.lng], 17, { animate: true });
    }
  };
  leafletMap.on('dragstart zoomstart', () => { followUser = false; });
}

export function updateMapRoute(routePoints) {
  if (!leafletMap || !routePolyline) return;
  if (!routePoints || routePoints.length === 0) { routePolyline.setLatLngs([]); return; }
  const latLngs = routePoints.map(p => [p.lat, p.lon]).filter(p => p[0] != null && p[1] != null && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (latLngs.length === 0) return;
  const bounds = L.latLngBounds(latLngs);
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const haversine = (lat1, lon1, lat2, lon2) => {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.asin(Math.sqrt(a));
  };
  const diagKm = haversine(bounds.getSouthWest().lat, bounds.getSouthWest().lng, bounds.getNorthEast().lat, bounds.getNorthEast().lng) / 1000;
  if (diagKm > 100) {
    if (followUser && latLngs.length > 0) leafletMap.setView(latLngs[latLngs.length - 1], leafletMap.getZoom(), { animate: false });
  } else if (followUser && latLngs.length === 1) {
    leafletMap.setView(latLngs[0], 16, { animate: true });
  } else if (followUser && latLngs.length <= 5) {
    leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 16, animate: true });
  }
  routePolyline.setLatLngs(latLngs);
}

export function updateMapPosition(lat, lon, accuracy) {
  if (!leafletMap || !positionMarker) return;
  if (lat == null || lon == null) return;
  const latLng = L.latLng(lat, lon);
  positionMarker.setLatLng(latLng);
  if (accuracy && accuracy > 0) positionMarker.setRadius(Math.max(10, accuracy / 2));
  if (followUser) leafletMap.setView(latLng, leafletMap.getZoom(), { animate: true, duration: 0.5 });
}

export function destroyMap() {
  if (leafletMap) { try { leafletMap.remove(); } catch (e) {} leafletMap = null; routePolyline = null; positionMarker = null; }
}

export function setFollowUser(v) { followUser = v; }
export function getFollowUser() { return followUser; }
