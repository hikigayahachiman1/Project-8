import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

function json(res, status, payload) {
  res.status(status).json(payload);
}

function isTruthyMaintenance(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, {
      ok: false,
      error: 'Method tidak diizinkan'
    });
  }

  if (!supabase) {
    return json(res, 500, {
      ok: false,
      error: 'Gagal mengecek status sistem'
    });
  }

  try {
    const { data, error } = await supabase
      .from('parser_system_settings')
      .select('key, value')
      .in('key', ['maintenance_mode', 'maintenance_reason']);

    if (error) throw error;

    const settings = Object.fromEntries((data || []).map(row => [row.key, row.value]));
    return json(res, 200, {
      ok: true,
      maintenance: isTruthyMaintenance(settings.maintenance_mode),
      reason: String(settings.maintenance_reason || '').trim()
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: 'Gagal mengecek status sistem'
    });
  }
}
