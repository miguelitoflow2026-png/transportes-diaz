// Portada de acceso: elección de rol + login real con Supabase Auth.
// NO existe contraseña hardcodeada ni comparación en el navegador.
import { supabase } from './supabase.js';
import { state } from './state.js';
import { esc, icon } from './lib.js';
import { audit } from './api.js';

let step = 'chooseRole';
let gateError = '';

export function resetToRoles() {
  step = 'chooseRole';
  gateError = '';
}

window.gateSignOut = async () => {
  audit('logout').catch(() => {});
  await supabase.auth.signOut().catch(() => {});
};

export function render() {
  step = state.missingRole ? 'missingRole' : step;
  state.missingRole = false;
  const gate = document.getElementById('gate');
  document.getElementById('headerBar').classList.add('hidden');
  document.getElementById('driverMode').classList.add('hidden');
  document.getElementById('adminMode').classList.add('hidden');
  gate.classList.remove('hidden');

  if (step === 'chooseRole') {
    gate.innerHTML = `
      <div class="gate-card">
        <div class="gate-logo">${icon('car')}</div>
        <div class="gate-title">Transportes Díaz SpA</div>
        <div class="gate-sub">Selecciona cómo quieres ingresar</div>
        <button class="gate-role-btn" data-step="conductorLogin">
          <span class="gr-icon">${icon('car')}</span>
          <span><span class="gr-title">Soy conductor</span><br><span class="gr-sub">Registrar viajes en terreno (app móvil)</span></span>
        </button>
        <button class="gate-role-btn" data-step="adminLogin">
          <span class="gr-icon">${icon('receipt')}</span>
          <span><span class="gr-title">Soy gerencia / administración</span><br><span class="gr-sub">Backoffice: contratos, tarifas y reportes</span></span>
        </button>
      </div>`;
    gate.querySelectorAll('[data-step]').forEach((b) =>
      b.addEventListener('click', () => {
        step = b.dataset.step;
        gateError = '';
        render();
      }),
    );
    return;
  }

  if (step === 'missingRole') {
    gate.innerHTML = `
      <div class="gate-card">
        <div class="gate-title" style="text-align:left;">Acceso restringido</div>
        <p style="font-size:13px; color:var(--text-dim); margin-top:10px;">Tu cuenta no tiene un rol asignado. Contacta al administrador para habilitar tu acceso.</p>
        <div style="height:16px;"></div>
        <button class="btn btn-primary btn-block" data-step="chooseRole">Volver al inicio</button>
        <div style="height:10px;"></div>
        <button class="btn btn-outline btn-block" onclick="gateSignOut()">Cerrar sesión</button>
      </div>`;
    gate.querySelector('[data-step="chooseRole"]').addEventListener('click', () => {
      step = 'chooseRole';
      render();
    });
    return;
  }

  const isDriver = step === 'conductorLogin';
  gate.innerHTML = `
      <div class="gate-card">
        <span class="gate-back" data-step="chooseRole">← Volver</span>
        <div class="gate-title" style="text-align:left;">${isDriver ? 'Acceso conductor' : 'Acceso gerencia / administración'}</div>
        <div class="gate-sub" style="text-align:left; margin-bottom:10px;">Usa tu correo corporativo y tu clave personal</div>
        <div class="field"><span class="label">Correo</span><input id="loginEmail" type="email" placeholder="nombre@transportesdiaz.cl" autocomplete="username"></div>
        <div style="height:12px;"></div>
        <div class="field"><span class="label">Clave</span><input id="loginPass" type="password" placeholder="••••••••" autocomplete="current-password"></div>
        ${gateError ? `<div class="gate-error">${esc(gateError)}</div>` : ''}
        <div style="height:16px;"></div>
        <button class="btn btn-primary btn-block" id="loginSubmit">Iniciar sesión</button>
      </div>`;
  gate.querySelector('[data-step="chooseRole"]').addEventListener('click', () => {
    step = 'chooseRole';
    gateError = '';
    render();
  });
  gate.querySelector('#loginSubmit').addEventListener('click', () => submitLogin(isDriver));
  gate.querySelector('#loginPass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitLogin(isDriver);
  });
}

export function renderWithError() {
  gateError = 'Tu cuenta no tiene un rol asignado. Contacta a administración.';
  render();
}

async function submitLogin(isDriver) {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPass').value;
  if (!email || !password) {
    gateError = 'Ingresa tu correo y tu clave.';
    render();
    return;
  }
  const btn = document.getElementById('loginSubmit');
  btn.disabled = true;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    gateError = 'Correo o clave incorrectos.';
    btn.disabled = false;
    render();
    return;
  }

  const role = data.user.app_metadata?.role || '';
  if (role !== (isDriver ? 'conductor' : 'admin')) {
    // Logueó correctamente pero eligió el rol equivocado o no tiene rol.
    // SIGNED_OUT se dispara por onAuthStateChange y vuelve al gate.
    state.missingRole = !role;
    await supabase.auth.signOut();
    gateError = role
      ? 'Ese usuario pertenece a otro perfil. Selecciona el perfil correcto.'
      : 'Tu cuenta no tiene un rol asignado. Contacta a administración.';
    render();
    return;
  }

  state.user = data.user;
  state.role = role;
  audit('login').catch(() => {});
  // applyView() se dispara vía onAuthStateChange (SIGNED_IN) en main.js.
}