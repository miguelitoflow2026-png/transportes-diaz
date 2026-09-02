// Punto de entrada: inicializa Supabase Auth y enruta entre gate / conductor / admin.
import './styles.css';
import { supabase } from './supabase.js';
import { state } from './state.js';
import { audit } from './api.js';
import * as gate from './gate.js';
import * as driver from './driver.js';
import * as admin from './admin.js';

export async function applyView() {
  const role = state.user?.app_metadata?.role || '';
  state.parent_role = role;

  if (role === 'conductor') {
    state.mode = 'driver';
    await driver.enter();
  } else if (role === 'admin') {
    state.mode = 'admin';
    admin.render();
  } else {
    state.mode = 'gate';
    gate.renderWithError();
  }
}

function reset() {
  driver.stopDriverTicker();
  state.user = null;
  state.role = null;
  state.mode = 'gate';
  state.driverContext = null;
  state.activeTrip = null;
  state.newTrip = {};
  state.adminScreen = 'clientes';
  state.editingContractId = null;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Botón "Salir" del header global.
  document.querySelector('.header-logout').addEventListener('click', logout);

  const { data } = await supabase.auth.getSession();
  if (data.session?.user) {
    state.user = data.session.user;
    state.role = data.session.user.app_metadata?.role || '';
    await applyView();
  } else {
    gate.render();
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      state.user = session.user;
      state.role = session.user.app_metadata?.role || '';
      applyView();
    } else if (event === 'SIGNED_OUT') {
      reset();
      gate.render();
    } else if (event === 'TOKEN_REFRESHED') {
      state.user = session?.user || null;
    }
  });
});

export async function logout() {
  gate.resetToRoles();
  audit('logout').catch(() => {});
  await supabase.auth.signOut().catch(() => {});
  reset();
  gate.render();
}

// reloj del status bar
setInterval(() => {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}, 30000);