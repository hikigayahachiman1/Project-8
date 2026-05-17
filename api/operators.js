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

const validRoles = new Set(['operator', 'audit', 'admin']);

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
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function requireAdmin(req) {
  if (!supabase) {
    const error = new Error('SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diset.');
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

  if (operator.role !== 'admin') {
    const forbidden = new Error('Anda tidak punya akses Admin Operator.');
    forbidden.statusCode = 403;
    throw forbidden;
  }

  return operator;
}

async function listOperators(res) {
  const { data, error } = await supabase
    .from('operators')
    .select('id, username, display_name, role, is_active, last_login_at, created_at, updated_at')
    .order('username', { ascending: true });

  if (error) throw error;

  return res.status(200).json({
    success: true,
    operators: (data || []).map(safeOperator)
  });
}

async function createOperator(body, res) {
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

  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('operators')
    .insert({
      username,
      display_name: displayName,
      password_hash: passwordHash,
      role,
      is_active: true,
      updated_at: now
    })
    .select('id, username, display_name, role, is_active, last_login_at, created_at, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'Username sudah digunakan.' });
    }
    throw error;
  }

  return res.status(201).json({ success: true, operator: safeOperator(data) });
}

async function updateOperator(body, res) {
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'ID operator tidak valid.' });
  }

  const { data: existing, error: fetchError } = await supabase
    .from('operators')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Operator tidak ditemukan.' });
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
    patch.role = role;
  }

  if (typeof body.is_active === 'boolean') {
    patch.is_active = body.is_active;
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
    .select('id, username, display_name, role, is_active, last_login_at, created_at, updated_at')
    .single();

  if (error) throw error;

  return res.status(200).json({ success: true, operator: safeOperator(data) });
}

async function disableOperator(req, res) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'ID operator tidak valid.' });
  }

  const { error } = await supabase
    .from('operators')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;

  return res.status(200).json({ success: true });
}

export default async function handler(req, res) {
  try {
    await requireAdmin(req);

    if (req.method === 'GET') return await listOperators(res);

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;

    if (req.method === 'POST') return await createOperator(body, res);
    if (req.method === 'PUT') return await updateOperator(body, res);
    if (req.method === 'DELETE') return await disableOperator(req, res);

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
