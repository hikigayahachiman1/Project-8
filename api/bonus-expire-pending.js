import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.OPERATOR_SESSION_SECRET;
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

async function isOperatorAuthorized(req) {
  if (!sessionSecret || !supabase) return false;
  const token = bearerToken(req);
  if (!token) return false;

  try {
    const payload = jwt.verify(token, sessionSecret);
    if (!payload.operator_id || !payload.session_token_id) return false;

    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: session, error: sessionError } = await supabase
      .from('operator_active_sessions')
      .select('id')
      .eq('operator_id', payload.operator_id)
      .eq('session_token_id', String(payload.session_token_id))
      .eq('is_active', true)
      .gte('last_seen_at', cutoff)
      .maybeSingle();
    if (sessionError || !session) return false;

    const { data: operator, error: operatorError } = await supabase
      .from('operators')
      .select('id')
      .eq('id', payload.operator_id)
      .eq('is_active', true)
      .maybeSingle();
    return !operatorError && Boolean(operator);
  } catch (error) {
    return false;
  }
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
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  if (!isAuthorized(req) && !(await isOperatorAuthorized(req))) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  try {
    return res.status(200).json(await expireOldPending());
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'EXPIRE_FAILED', message: error.message || 'Gagal expire pending.' });
  }
}
