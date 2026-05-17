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

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function operatorResponse(operator) {
  return {
    id: operator.id,
    username: operator.username,
    display_name: operator.display_name,
    role: operator.role
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ success: false, error: 'Method not allowed.' });
    }

    if (!supabase) {
      return res.status(500).json({ success: false, error: 'SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diset.' });
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
      .select('id, username, display_name, password_hash, role, is_active')
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

    await supabase
      .from('operators')
      .update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', operator.id);

    const safeOperator = operatorResponse(operator);
    const token = jwt.sign({
      operator_id: operator.id,
      username: operator.username,
      display_name: operator.display_name,
      role: operator.role
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
