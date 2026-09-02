// services/geocoding.js — Búsqueda Nominatim (OSM) extraída de driver.js
export async function searchNominatim(query) {
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

export async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
  try {
    const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  } catch (e) {
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }
}
