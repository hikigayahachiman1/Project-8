import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.OPERATOR_SESSION_SECRET;
const hermesApiUrl = String(process.env.HERMES_API_URL || '').replace(/\/+$/, '');
const hermesApiSecret = process.env.HERMES_API_SECRET || '';

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const DEBUG_QUESTION_PATTERN = /\b(debug|log|logs|stack|trace|internal|session|token|service[_\s-]*role|status internal|server status|audit log|error log)\b/i;

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sessionCutoffIso() {
  return new Date(Date.now() - SESSION_IDLE_MS).toISOString();
}

async function cleanupExpiredSessions(operatorId = null) {
  const now = new Date().toISOString();
  let query = supabase
    .from('operator_active_sessions')
    .update({ is_active: false, expired_at: now, expired_reason: 'IDLE_EXPIRED' })
    .eq('is_active', true)
    .lt('last_seen_at', sessionCutoffIso());

  if (operatorId) query = query.eq('operator_id', String(operatorId));
  const { error } = await query;
  if (error) throw error;
}

async function requireOperator(req) {
  if (!supabase || !sessionSecret) {
    const error = new Error('Konfigurasi Hermes belum lengkap.');
    error.statusCode = 500;
    throw error;
  }

  const token = bearerToken(req);
  if (!token) {
    const error = new Error('Sesi tidak valid.');
    error.statusCode = 401;
    throw error;
  }

  let payload;
  try {
    payload = jwt.verify(token, sessionSecret);
  } catch (error) {
    const authError = new Error('Sesi tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  if (!payload.operator_id || !payload.session_token_id) {
    const authError = new Error('Sesi tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  await cleanupExpiredSessions(payload.operator_id);

  const { data: activeSession, error: sessionError } = await supabase
    .from('operator_active_sessions')
    .select('id')
    .eq('operator_id', String(payload.operator_id))
    .eq('session_token_id', String(payload.session_token_id))
    .eq('is_active', true)
    .gte('last_seen_at', sessionCutoffIso())
    .maybeSingle();

  if (sessionError) throw sessionError;
  if (!activeSession) {
    const authError = new Error('Sesi berakhir atau sudah tidak aktif. Silakan login kembali.');
    authError.statusCode = 401;
    throw authError;
  }

  const { data: operator, error } = await supabase
    .from('operators')
    .select('id, username, display_name, role, is_active')
    .eq('id', payload.operator_id)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  if (!operator) {
    const authError = new Error('Sesi tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  await supabase
    .from('operator_active_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', activeSession.id);

  return operator;
}

function extractHermesAnswer(data) {
  if (!data || typeof data !== 'object') return '';
  return String(data.answer || data.message || data.reply || data.text || '').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method tidak diizinkan.' });
  }

  try {
    const operator = await requireOperator(req);
    const body = await readJsonBody(req);
    const question = String(body.question || '').trim();

    if (!question) {
      return res.status(400).json({ ok: false, message: 'Pertanyaan wajib diisi.' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ ok: false, message: 'Pertanyaan terlalu panjang. Maksimal 2000 karakter.' });
    }
    if (operator.role !== 'superadmin' && DEBUG_QUESTION_PATTERN.test(question)) {
      return res.status(403).json({
        ok: false,
        message: 'Fitur debug/log/status internal hanya tersedia untuk superadmin.'
      });
    }
    if (!hermesApiUrl) {
      return res.status(500).json({ ok: false, message: 'Hermes API belum dikonfigurasi.' });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (hermesApiSecret) headers['x-hermes-secret'] = hermesApiSecret;

    const response = await fetch(`${hermesApiUrl}/api/parser/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        question,
        role: operator.role,
        username: operator.username,
        requested_by: operator.username,
        source: 'parser-index'
      })
    });

    const hermesData = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status >= 500 ? 502 : response.status).json({
        ok: false,
        message: extractHermesAnswer(hermesData) || 'Hermes belum dapat dihubungi.'
      });
    }

    return res.status(200).json({
      ok: true,
      answer: extractHermesAnswer(hermesData) || 'Hermes belum memberi jawaban.'
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      ok: false,
      message: status === 401
        ? 'Sesi berakhir atau sudah tidak aktif. Silakan login kembali.'
        : 'Hermes belum dapat dihubungi.'
    });
  }
}
