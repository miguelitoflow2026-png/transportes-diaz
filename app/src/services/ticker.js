// services/ticker.js — Ticker de espera y helpers de display extraídos de driver.js
import { state } from '../state.js';
import { updateTrip } from '../api.js';
import { setWaitSeconds } from '../tracing.js';
import { fmtHM } from '../lib.js';

let ticker = null;
let tickCount = 0;

export function ensureTicker() {
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

export function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  tickCount = 0;
}

export function stopDriverTicker() { stopTicker(); }

export function updateWaitDisplay(totalWaitSeconds) {
  const el = document.getElementById('wait-display');
  if (el) el.textContent = fmtHM(totalWaitSeconds ?? 0);
}

export function updateKmDisplay(totalKm) {
  const el = document.getElementById('km-display');
  if (el) el.textContent = Number(totalKm || 0).toFixed(2);
}
