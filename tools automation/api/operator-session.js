import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.OPERATOR_SESSION_SECRET;

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    })
  : null;

const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function operatorResponse(operator) {
  return {
    id: operator.id,
    username: operator.username,
    display_name: operator.display_name,
    role: operator.role,
    is_protected: Boolean(operator.is_protected)
  };
}

function sessionCutoffIso() {
  return new Date(Date.now() - SESSION_IDLE_MS).toISOString();
}

async function cleanupExpiredSessions(operatorId = null) {
  const now = new Date().toISOString();
  let query = supabase
    .from('operator_active_sessions')
    .update({
      is_active: false,
      expired_at: now
    })
    .eq('is_active', true)
    .lt('last_seen_at', sessionCutoffIso());

  if (operatorId) query = query.eq('operator_id', String(operatorId));

  const { error } = await query;
  if (error) throw error;
}

function sessionExpiredResponse(res) {
  return res.status(401).json({
    success: false,
    error: 'SESSION_EXPIRED',
    message: 'Sesi berakhir atau sudah tidak aktif. Silakan login kembali.'
  });
}

async function verifyOperatorToken(req) {
  const token = bearerToken(req);
  if (!token) return { error: 'missing' };

  try {
    return { payload: jwt.verify(token, sessionSecret) };
  } catch (error) {
    return { error: 'invalid' };
  }
}

export default async function handler(req, res) {
  try {
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ success: false, error: 'Method not allowed.' });
    }

    if (!supabase) {
      return res.status(500).json({ success: false, error: 'Konfigurasi database pusat belum lengkap.' });
    }

    if (!sessionSecret) {
      return res.status(500).json({ success: false, error: 'OPERATOR_SESSION_SECRET belum diset.' });
    }

    const verified = await verifyOperatorToken(req);
    if (verified.error || !verified.payload) {
      return sessionExpiredResponse(res);
    }

    const payload = verified.payload;
    if (!payload.operator_id || !payload.session_token_id) {
      return sessionExpiredResponse(res);
    }

    await cleanupExpiredSessions(payload.operator_id);

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      const action = String(body.action || '').trim();

      if (action !== 'logout') {
        return res.status(400).json({ success: false, error: 'Action tidak dikenal.' });
      }

      const now = new Date().toISOString();
      const { error: logoutError } = await supabase
        .from('operator_active_sessions')
        .update({
          is_active: false,
          expired_at: now
        })
        .eq('operator_id', String(payload.operator_id))
        .eq('session_token_id', String(payload.session_token_id));

      if (logoutError) throw logoutError;

      return res.status(200).json({ success: true, status: 'logged_out' });
    }

    const { data: activeSession, error: sessionError } = await supabase
      .from('operator_active_sessions')
      .select('id, last_seen_at')
      .eq('operator_id', String(payload.operator_id))
      .eq('session_token_id', String(payload.session_token_id))
      .eq('is_active', true)
      .gte('last_seen_at', sessionCutoffIso())
      .maybeSingle();

    if (sessionError) throw sessionError;
    if (!activeSession) {
      return sessionExpiredResponse(res);
    }

    const { data: operator, error } = await supabase
      .from('operators')
      .select('id, username, display_name, role, is_active, is_protected')
      .eq('id', payload.operator_id)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    if (!operator) {
      return sessionExpiredResponse(res);
    }

    const { error: touchError } = await supabase
      .from('operator_active_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', activeSession.id);

    if (touchError) throw touchError;

    return res.status(200).json({
      success: true,
      operator: operatorResponse(operator)
    });
  } catch (error) {
    console.error('operator-session error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Server error.'
    });
  }
}
