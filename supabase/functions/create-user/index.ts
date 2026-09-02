// Edge Function: create-user
// Invocada por el backoffice (solo usuarios con role admin en app_metadata)
// con la clave pública (anon) + el JWT del admin autenticado.
// Crea el usuario de Auth (email + contraseña, sin string compartido) y su
// registro en public.drivers o public.admin_users. Guarda role en app_metadata.
//
// Deploy: supabase functions deploy create-user --no-verify-jwt
// (la verificación de admin se hace aquí dentro contra app_metadata del JWT)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_ANON_KEY') ?? '',
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RUT_RE = /^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function services() {
  const authHeader = 'Bearer ' + (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  // 1) Verifica que quien llama es un admin autenticado.
  const { data: caller, error: callerErr } = await supabase.auth.getUser(token);
  if (callerErr || !caller?.user || caller.user.app_metadata?.role !== 'admin') {
    return json({ error: 'Solo el personal admin puede crear usuarios' }, 403);
  }

  // 2) Payload
  try {
    const body = await req.json();
    const { email, password, name, rut, role, cargo } = body;

    if (!email || !EMAIL_RE.test(email)) return json({ error: 'Email inválido' }, 400);
    if (!name || name.trim().length < 2) return json({ error: 'Nombre requerido' }, 400);
    if (!password || password.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
    if (role !== 'conductor' && role !== 'admin') return json({ error: 'Rol inválido' }, 400);
    if (role === 'conductor') {
      if (!rut || !RUT_RE.test(rut)) return json({ error: 'RUT inválido (formato xx.xxx.xxx-x)' }, 400);
    }

    const admin = await services();

    // 3) Crea el usuario de Auth (sin contraseña hardcodeada en código).
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Omitir para enviar correo de invitación.
      app_metadata: { role },
      user_metadata: { name },
    });
    if (createErr) return json({ error: createErr.message }, 400);

    // 4) Registro en la tabla de negocio correspondiente.
    if (role === 'conductor') {
      const { error: insErr } = await admin.from('drivers').insert({
        id: created.user.id, name: name.trim(), rut, email: email.toLowerCase(), active: true,
      });
      if (insErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: 'No se pudo crear el conductor: ' + insErr.message }, 400);
      }
    } else {
      const { error: insErr } = await admin.from('admin_users').insert({
        id: created.user.id, name: name.trim(), email: email.toLowerCase(),
        cargo: cargo?.trim() ?? null, role: 'admin', active: true,
      });
      if (insErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: 'No se pudo crear el admin: ' + insErr.message }, 400);
      }
    }

    return json({
      id: created.user.id,
      email: created.user.email,
      role,
      temporary_password: password, // Se muestra UNA vez a quien la crea.
      note: 'Entregue esta clave al usuario; se recomienda cambiarla en el primer acceso.',
    }, 201);
  } catch (e) {
    return json({ error: 'JSON inválido: ' + e.message }, 400);
  }
});