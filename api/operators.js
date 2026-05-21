import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.OPERATOR_SESSION_SECRET;

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    })
  : null;

const validRoles = new Set(['operator', 'audit', 'admin', 'superadmin']);
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function safeOperator(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    is_active: row.is_active,
    is_protected: Boolean(row.is_protected),
    last_login_at: row.last_login_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    session_status: row.session_status || 'Tidak aktif',
    session_last_seen_at: row.session_last_seen_at || null,
    active_session_count: row.active_session_count || 0
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

async function insertOperatorAdminAction(payload) {
  const { error } = await supabase
    .from('operator_admin_actions')
    .insert(payload);

  if (error && !['42P01', '42703'].includes(error.code)) throw error;
}

async function requireAdmin(req) {
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
    const authError = new Error('Session tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  if (!['admin', 'superadmin'].includes(operator.role)) {
    const forbidden = new Error('Anda tidak punya akses Admin Operator.');
    forbidden.statusCode = 403;
    throw forbidden;
  }

  return operator;
}

async function listOperators(req, res) {
  const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 100);
  const page = Math.max(Number(req.query?.page) || 1, 1);
  const search = normalizeUsername(req.query?.search || '');
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('operators')
    .select('id, username, display_name, role, is_active, is_protected, created_at, updated_at', { count: 'exact' })
    .order('username', { ascending: true })
    .range(from, to);

  if (search) {
    query = query.or(`username.ilike.%${search}%,display_name.ilike.%${search}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const operatorIds = (data || []).map(row => String(row.id));
  let sessionRows = [];
  if (operatorIds.length) {
    const { data: sessions, error: sessionError } = await supabase
      .from('operator_active_sessions')
      .select('operator_id, is_active, last_seen_at, expired_at')
      .in('operator_id', operatorIds)
      .eq('is_active', true)
      .gte('last_seen_at', sessionCutoffIso())
      .order('last_seen_at', { ascending: false });

    if (sessionError) throw sessionError;
    sessionRows = sessions || [];
  }

  const sessionMap = new Map();
  sessionRows.forEach(session => {
    const key = String(session.operator_id);
    if (!sessionMap.has(key)) {
      sessionMap.set(key, {
        activeCount: 0,
        lastSeenAt: session.last_seen_at || null,
        status: 'Aktif'
      });
    }
    const item = sessionMap.get(key);
    if (session.is_active) {
      item.activeCount += 1;
      item.status = 'Aktif';
      if (!item.lastSeenAt || new Date(session.last_seen_at).getTime() > new Date(item.lastSeenAt).getTime()) {
        item.lastSeenAt = session.last_seen_at;
      }
    }
  });

  return res.status(200).json({
    success: true,
    page,
    limit,
    total: count || 0,
    hasMore: to + 1 < (count || 0),
    operators: (data || []).map(row => {
      const session = sessionMap.get(String(row.id));
      return safeOperator({
        ...row,
        session_status: session ? session.status : 'Tidak aktif',
        session_last_seen_at: session ? session.lastSeenAt : null,
        active_session_count: session ? session.activeCount : 0
      });
    })
  });
}

function isSuperAdmin(operator) {
  return operator && operator.role === 'superadmin';
}

async function countActiveAdminLike(exceptId = null) {
  let query = supabase
    .from('operators')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .in('role', ['admin', 'superadmin']);

  if (exceptId) query = query.neq('id', exceptId);

  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

async function createOperator(requester, body, res) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');
  const displayName = String(body.display_name || '').trim();
  const role = String(body.role || 'operator').trim().toLowerCase();

  if (!username || !displayName || !password) {
    return res.status(400).json({ success: false, error: 'Username, nama, dan password wajib diisi.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ success: false, error: 'Password minimal 6 karakter.' });
  }

  if (!validRoles.has(role)) {
    return res.status(400).json({ success: false, error: 'Role tidak valid.' });
  }

  const wantsProtected = body.is_protected === true;
  if ((role === 'superadmin' || wantsProtected) && !isSuperAdmin(requester)) {
    return res.status(403).json({ success: false, error: 'Hanya superadmin yang boleh membuat akun superadmin/protected.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('operators')
    .insert({
      username,
      display_name: displayName,
      password_hash: passwordHash,
      role,
      is_protected: isSuperAdmin(requester) ? wantsProtected : false,
      is_active: true,
      updated_at: now
    })
    .select('id, username, display_name, role, is_active, is_protected, last_login_at, created_at, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'Username sudah digunakan.' });
    }
    throw error;
  }

  return res.status(201).json({ success: true, operator: safeOperator(data) });
}

async function updateOperator(requester, body, res) {
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'ID operator tidak valid.' });
  }

  const { data: existing, error: fetchError } = await supabase
    .from('operators')
    .select('id, role, is_active, is_protected')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Operator tidak ditemukan.' });
  }

  const requesterIsSuper = isSuperAdmin(requester);
  const targetProtected = existing.role === 'superadmin' || existing.is_protected === true;
  if (targetProtected && !requesterIsSuper) {
    return res.status(403).json({ success: false, error: 'Akun superadmin/protected tidak bisa diubah oleh admin biasa.' });
  }

  const patch = { updated_at: new Date().toISOString() };

  if (body.display_name !== undefined) {
    const displayName = String(body.display_name || '').trim();
    if (!displayName) return res.status(400).json({ success: false, error: 'Nama operator wajib diisi.' });
    patch.display_name = displayName;
  }

  if (body.role !== undefined) {
    const role = String(body.role || '').trim().toLowerCase();
    if (!validRoles.has(role)) return res.status(400).json({ success: false, error: 'Role tidak valid.' });
    if (role === 'superadmin' && !requesterIsSuper) {
      return res.status(403).json({ success: false, error: 'Hanya superadmin yang boleh mengatur role superadmin.' });
    }
    patch.role = role;
  }

  if (typeof body.is_active === 'boolean') {
    if (body.is_active === false && existing.is_active && ['admin', 'superadmin'].includes(existing.role)) {
      const remaining = await countActiveAdminLike(existing.id);
      if (remaining === 0) {
        return res.status(403).json({ success: false, error: 'Tidak boleh menonaktifkan satu-satunya admin/superadmin aktif.' });
      }
    }
    patch.is_active = body.is_active;
  }

  if (typeof body.is_protected === 'boolean') {
    if (!requesterIsSuper) {
      return res.status(403).json({ success: false, error: 'Hanya superadmin yang boleh mengubah proteksi akun.' });
    }
    patch.is_protected = body.is_protected;
  }

  if (body.password !== undefined && body.password !== null && String(body.password).trim()) {
    const password = String(body.password);
    if (password.length < 6) return res.status(400).json({ success: false, error: 'Password minimal 6 karakter.' });
    patch.password_hash = await bcrypt.hash(password, 12);
  }

  const { data, error } = await supabase
    .from('operators')
    .update(patch)
    .eq('id', id)
    .select('id, username, display_name, role, is_active, is_protected, last_login_at, created_at, updated_at')
    .single();

  if (error) throw error;

  return res.status(200).json({ success: true, operator: safeOperator(data) });
}

async function disableOperator(requester, req, res) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'ID operator tidak valid.' });
  }

  const { data: existing, error: fetchError } = await supabase
    .from('operators')
    .select('id, role, is_active, is_protected')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) return res.status(404).json({ success: false, error: 'Operator tidak ditemukan.' });
  if (existing.role === 'superadmin' || existing.is_protected === true) {
    return res.status(403).json({ success: false, error: 'Akun protected tidak boleh dinonaktifkan.' });
  }

  if (existing.is_active && ['admin', 'superadmin'].includes(existing.role)) {
    const remaining = await countActiveAdminLike(existing.id);
    if (remaining === 0) {
      return res.status(403).json({ success: false, error: 'Tidak boleh menonaktifkan satu-satunya admin/superadmin aktif.' });
    }
  }

  const { error } = await supabase
    .from('operators')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;

  return res.status(200).json({ success: true });
}

function canForceLogout(requester, target) {
  if (!requester || !target) return false;
  if (requester.role === 'superadmin') return true;
  if (requester.role !== 'admin') return false;
  if (target.is_protected || target.role === 'admin' || target.role === 'superadmin') return false;
  return ['operator', 'audit'].includes(target.role);
}

async function forceLogoutOperator(requester, body, res) {
  const targetId = Number(body.operator_id || body.id);
  const reason = String(body.reason || 'Paksa logout oleh admin').trim();

  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ success: false, error: 'ID operator tidak valid.' });
  }

  const { data: target, error: targetError } = await supabase
    .from('operators')
    .select('id, username, display_name, role, is_protected')
    .eq('id', targetId)
    .maybeSingle();

  if (targetError) throw targetError;
  if (!target) return res.status(404).json({ success: false, error: 'Operator tidak ditemukan.' });

  if (!canForceLogout(requester, target)) {
    return res.status(403).json({ success: false, error: 'Anda tidak memiliki akses untuk melepas sesi akun ini.' });
  }

  const now = new Date().toISOString();
  const { data: sessions, error: sessionError } = await supabase
    .from('operator_active_sessions')
    .update({
      is_active: false,
      expired_at: now,
      expired_reason: 'FORCE_LOGOUT_BY_ADMIN'
    })
    .eq('operator_id', String(target.id))
    .eq('is_active', true)
    .select('id');

  if (sessionError) throw sessionError;

  await insertOperatorAdminAction({
    action_type: 'FORCE_LOGOUT_SESSION',
    actor_operator_id: String(requester.id),
    actor_username: requester.username,
    actor_role: requester.role,
    target_operator_id: String(target.id),
    target_username: target.username,
    target_role: target.role,
    note: reason,
    affected_rows: (sessions || []).length
  });

  return res.status(200).json({
    success: true,
    ok: true,
    message: 'Sesi aktif berhasil dilepas. Akun bisa login kembali.',
    affected_sessions: (sessions || []).length
  });
}

export default async function handler(req, res) {
  try {
    const requester = await requireAdmin(req);

    if (req.method === 'GET') return await listOperators(req, res);

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;

    if (req.method === 'POST') {
      const action = String(body.action || '').trim();
      if (action === 'force_logout_operator') return await forceLogoutOperator(requester, body, res);
      return await createOperator(requester, body, res);
    }
    if (req.method === 'PUT') return await updateOperator(requester, body, res);
    if (req.method === 'DELETE') return await disableOperator(requester, req, res);

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  } catch (error) {
    console.error('operators error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Server error.'
    });
  }
}
