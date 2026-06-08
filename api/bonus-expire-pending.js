import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function isAuthorized(req) {
  const expected = process.env.HERMES_PARSER_API_TOKEN || '';
  return Boolean(expected && bearerToken(req) === expected);
}

async function expireOldPending() {
  const { data, error } = await supabase.rpc('expire_old_bonus_pending');
  if (error) throw error;
  return {
    ok: true,
    expired_bonus_rows: Number(data?.expired_bonus_rows || 0),
    expired_lock_rows: Number(data?.expired_lock_rows || 0)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });

  try {
    return res.status(200).json(await expireOldPending());
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'EXPIRE_FAILED', message: error.message || 'Gagal expire pending.' });
  }
}
