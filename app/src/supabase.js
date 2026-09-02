import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn('Configura app/.env con VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (ver README.md).');
}

export const supabase = createClient(url || 'https://project.ref.supabase.co', anonKey || 'anon-placeholder');