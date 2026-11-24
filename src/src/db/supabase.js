import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

const options = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    headers: {
      'X-Client-Info': 'factor-server/0.1.0',
    },
  },
};

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  options
);

export const storage = supabase.storage.from(config.supabase.storageBucket);

export async function pingDb() {
  const { error } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true })
    .limit(1);
  if (error) throw new Error(`Supabase ping failed: ${error.message}`);
  return true;
}