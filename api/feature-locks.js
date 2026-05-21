import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.OPERATOR_SESSION_SECRET;

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const FEATURES = [
  { feature_key: 'parser', feature_name: 'Parser QRIS' },
  { feature_key: 'bonus', feature_name: 'Bonus Harian' },
  { feature_key: 'claim_mahjong', feature_name: 'Klaim Mahjong' },
  { feature_key: 'audit', feature_name: 'Audit Bonus' },
  { feature_key: 'admin_operators', feature_name: 'Admin Operator' },
  { feature_key: 'monitoring_bonus', feature_name: 'Monitoring Bonus Operator' },
  { feature_key: 'module_guide', feature_name: 'Modul Panduan' }
];

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

function isMissingFeatureLocksTable(error) {
  return error && (error.code === '42P01' || /feature_access_locks/i.test(error.message || ''));
}

function missingFeatureLocksTableError() {
  const error = new Error('Table feature_access_locks belum dibuat di database pusat.');
  error.statusCode = 500;
  return error;
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
  if (!supabase) {
    const error = new Error('Konfigurasi database pusat belum lengkap.');
    error.statusCode = 500;
    throw error;
  }
  if (!sessionSecret) {
    const error = new Error('OPERATOR_SESSION_SECRET belum diset.');
    error.statusCode = 500;
    throw error;
  }

  const token = bearerToken(req);
  if (!token) {
    const error = new Error('Session tidak valid.');
    error.statusCode = 401;
    throw error;
  }

  let payload;
  try {
    payload = jwt.verify(token, sessionSecret);
  } catch (error) {
    const authError = new Error('Session tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  if (!payload.operator_id || !payload.session_token_id) {
    const authError = new Error('Session tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  await cleanupExpiredSessions(payload.operator_id);

  const { data: session, error: sessionError } = await supabase
    .from('operator_active_sessions')
    .select('id')
    .eq('operator_id', String(payload.operator_id))
    .eq('session_token_id', String(payload.session_token_id))
    .eq('is_active', true)
    .gte('last_seen_at', sessionCutoffIso())
    .maybeSingle();

  if (sessionError) throw sessionError;
  if (!session) {
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
    const authError = new Error('Session tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  return operator;
}

function mergeDefaults(rows = []) {
  const map = new Map(rows.map(row => [row.feature_key, row]));
  return FEATURES.map(feature => ({
    ...feature,
    ...(map.get(feature.feature_key) || {}),
    is_locked: Boolean(map.get(feature.feature_key)?.is_locked)
  }));
}

async function listLocks(res) {
  const { data, error } = await supabase
    .from('feature_access_locks')
    .select('feature_key, feature_name, is_locked, locked_reason, updated_by_operator_id, updated_by_username, updated_by_role, updated_at, created_at')
    .order('feature_name', { ascending: true });

  if (error) {
    if (isMissingFeatureLocksTable(error)) throw missingFeatureLocksTableError();
    throw error;
  }
  return res.status(200).json({ ok: true, locks: mergeDefaults(data || []) });
}

async function logFeatureLock(operator, featureKey, isLocked, reason) {
  const { error } = await supabase
    .from('operator_admin_actions')
    .insert({
      action_type: isLocked ? 'FEATURE_LOCK_ENABLED' : 'FEATURE_LOCK_DISABLED',
      actor_operator_id: String(operator.id),
      actor_username: operator.username,
      actor_role: operator.role,
      target_operator_id: featureKey,
      target_username: featureKey,
      target_role: 'feature',
      note: reason || '',
      affected_rows: 1
    });

  if (error && !['42P01', '42703'].includes(error.code)) throw error;
}

async function setLock(res, operator, body) {
  if (operator.role !== 'superadmin') {
    return res.status(403).json({
      ok: false,
      message: 'Hanya Superadmin yang dapat mengubah kunci menu.'
    });
  }

  const featureKey = String(body.feature_key || '').trim();
  const feature = FEATURES.find(item => item.feature_key === featureKey);
  if (!feature) {
    return res.status(400).json({ ok: false, message: 'Menu tidak dikenal.' });
  }

  const isLocked = Boolean(body.is_locked);
  const reason = String(body.locked_reason || '').trim();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('feature_access_locks')
    .upsert({
      feature_key: feature.feature_key,
      feature_name: feature.feature_name,
      is_locked: isLocked,
      locked_reason: isLocked ? reason : '',
      updated_by_operator_id: String(operator.id),
      updated_by_username: operator.username,
      updated_by_role: operator.role,
      updated_at: now
    }, { onConflict: 'feature_key' });

  if (error) {
    if (isMissingFeatureLocksTable(error)) throw missingFeatureLocksTableError();
    throw error;
  }
  await logFeatureLock(operator, featureKey, isLocked, reason);
  return listLocks(res);
}

export default async function handler(req, res) {
  try {
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ ok: false, message: 'Method tidak diizinkan.' });
    }

    const operator = await requireOperator(req);
    if (req.method === 'GET') return listLocks(res);

    const body = await readJsonBody(req);
    if (String(body.action || '').trim() !== 'set_lock') {
      return res.status(400).json({ ok: false, message: 'Action tidak dikenal.' });
    }
    return setLock(res, operator, body);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.code || 'FEATURE_LOCK_ERROR',
      message: error.message || 'Server error.'
    });
  }
}
