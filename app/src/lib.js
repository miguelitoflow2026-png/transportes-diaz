// Utilidades compartidas: formateo, iconos, escape (anti-XSS) y toasts.

// Escapa texto libre antes de insertarlo en innerHTML (XSS).
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

export function formatCLP(n) {
  return '$' + Math.round(n || 0).toLocaleString('es-CL');
}
export function pad(n) {
  return n.toString().padStart(2, '0');
}
export function fmtHM(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  totalSeconds = Math.floor(totalSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
export function fmtHMshort(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const h = Math.floor(totalSeconds / 3600);
  let m = Math.round((totalSeconds % 3600) / 60);
  // Corrección carry: 60 min -> 1h
  let hh = h;
  if (m >= 60) { hh += 1; m = 0; }
  return `${pad(hh)}:${pad(m)}`;
}
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}
export function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

let toastTimer = null;
export function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

export function icon(name) {
  const icons = {
    car: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17h14M5 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm14 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0zM3 17V11l2-5h14l2 5v6"/></svg>',
    clock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    receipt: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z"/><path d="M9 8h6M9 12h6"/></svg>',
    user: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    home: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9z"/></svg>',
    history: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></svg>',
    nav: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>',
    check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
    pause: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    file: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>',
  };
  return icons[name] || '';
}

// Skeleton compartido post-login.
export function showShell(mode, label) {
  document.getElementById('gate').classList.add('hidden');
  document.getElementById('headerBar').classList.remove('hidden');
  document.getElementById('driverMode').classList.toggle('hidden', mode !== 'driver');
  document.getElementById('adminMode').classList.toggle('hidden', mode !== 'admin');
  document.getElementById('headerRoleLabel').textContent = label;
}