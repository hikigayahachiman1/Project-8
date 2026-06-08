import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.OPERATOR_SESSION_SECRET;

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    })
  : null;

const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
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
      expired_at: now,
      expired_reason: 'IDLE_EXPIRED'
    })
    .eq('is_active', true)
    .lt('last_seen_at', sessionCutoffIso());

  if (operatorId) query = query.eq('operator_id', String(operatorId));

  const { error } = await query;
  if (error) throw error;
}

async function findActiveSession(operatorId) {
  const { data, error } = await supabase
    .from('operator_active_sessions')
    .select('id, last_seen_at')
    .eq('operator_id', String(operatorId))
    .eq('is_active', true)
    .gte('last_seen_at', sessionCutoffIso())
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function expireActiveSessionsForOperator(operatorId, reason) {
  const { data, error } = await supabase
    .from('operator_active_sessions')
    .update({
      is_active: false,
      expired_at: new Date().toISOString(),
      expired_reason: reason
    })
    .eq('operator_id', String(operatorId))
    .eq('is_active', true)
    .select('id');

  if (error) throw error;
  return data || [];
}

async function insertOperatorAdminAction(payload) {
  const { error } = await supabase
    .from('operator_admin_actions')
    .insert(payload);

  if (error && !['42P01', '42703'].includes(error.code)) throw error;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ success: false, error: 'Method not allowed.' });
    }

    if (!supabase) {
      return res.status(500).json({ success: false, error: 'Konfigurasi database pusat belum lengkap.' });
    }

    if (!sessionSecret) {
      return res.status(500).json({ success: false, error: 'OPERATOR_SESSION_SECRET belum diset.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username dan password wajib diisi.' });
    }

    const { data: operator, error } = await supabase
      .from('operators')
      .select('id, username, display_name, password_hash, role, is_active, is_protected')
      .eq('username', username)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;

    const invalidMessage = 'Username atau password salah.';
    if (!operator || !operator.password_hash) {
      return res.status(401).json({ success: false, error: invalidMessage });
    }

    const passwordOk = await bcrypt.compare(password, operator.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, error: invalidMessage });
    }

    await cleanupExpiredSessions(operator.id);
    if (operator.role === 'superadmin') {
      const replacedSessions = await expireActiveSessionsForOperator(operator.id, 'SUPERADMIN_REPLACED_OWN_SESSION');
      if (replacedSessions.length) {
        await insertOperatorAdminAction({
          action_type: 'SUPERADMIN_REPLACED_OWN_SESSION',
          actor_operator_id: String(operator.id),
          actor_username: operator.username,
          actor_role: operator.role,
          target_operator_id: String(operator.id),
          target_username: operator.username,
          target_role: operator.role,
          note: 'Superadmin login ulang dan mengganti sesi aktif lama.',
          affected_rows: replacedSessions.length
        });
      }
    } else {
      const activeSession = await findActiveSession(operator.id);
      if (activeSession) {
        return res.status(409).json({
          success: false,
          error: 'ACTIVE_SESSION_EXISTS',
          message: operator.role === 'admin'
            ? 'Akun admin ini masih aktif di perangkat/browser lain. Silakan logout dari sesi sebelumnya atau hubungi superadmin.'
            : 'Akun ini masih aktif di perangkat/browser lain. Silakan logout dari sesi sebelumnya atau hubungi admin.'
        });
      }
    }

    const sessionTokenId = randomUUID();
    const now = new Date().toISOString();

    const { error: sessionError } = await supabase
      .from('operator_active_sessions')
      .insert({
        operator_id: String(operator.id),
        username: operator.username,
        display_name: operator.display_name,
        role: operator.role,
        session_token_id: sessionTokenId,
        is_active: true,
        last_seen_at: now,
        created_at: now
      });

    if (sessionError) throw sessionError;

    await supabase
      .from('operators')
      .update({ last_login_at: now, updated_at: now })
      .eq('id', operator.id);

    const safeOperator = operatorResponse(operator);
    const token = jwt.sign({
      operator_id: operator.id,
      username: operator.username,
      display_name: operator.display_name,
      role: operator.role,
      is_protected: Boolean(operator.is_protected),
      session_token_id: sessionTokenId
    }, sessionSecret, { expiresIn: '12h' });

    return res.status(200).json({
      success: true,
      token,
      operator: safeOperator
    });
  } catch (error) {
    console.error('operator-login error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Server error.'
    });
  }
}
