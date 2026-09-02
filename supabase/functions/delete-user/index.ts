// Edge Function: delete-user
// Elimina un usuario de Auth (y su fila en public.drivers / public.admin_users).
// Solo admin. Los viajes que referencien al conductor bloquean la eliminación
// (on delete restrict) para conservar la integridad histórica.
//
// Deploy: supabase functions deploy delete-user --no-verify-jwt

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: caller, error: callerErr } = await supabase.auth.getUser(token);
  if (callerErr || !caller?.user || caller.user.app_metadata?.role !== 'admin') {
    return json({ error: 'Solo el personal admin puede eliminar usuarios' }, 403);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { user_id } = await req.json().catch(() => ({}));
  if (!user_id) return json({ error: 'user_id requerido' }, 400);

  const { error: delErr } = await admin.auth.admin.deleteUser(user_id);
  if (delErr) return json({ error: delErr.message }, 400);

  return json({ ok: true, user_id });
});