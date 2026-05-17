import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const allowBootstrap = process.env.ALLOW_BOOTSTRAP_ADMIN === 'true';

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    })
  : null;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  try {
    if (!allowBootstrap) {
      return res.status(404).json({ success: false, error: 'Not found.' });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ success: false, error: 'Method not allowed.' });
    }

    if (!supabase) {
      return res.status(500).json({ success: false, error: 'SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diset.' });
    }

    const { data: existingAdmins, error: adminError } = await supabase
      .from('operators')
      .select('id')
      .eq('role', 'admin')
      .eq('is_active', true)
      .limit(1);

    if (adminError) throw adminError;
    if ((existingAdmins || []).length > 0) {
      return res.status(409).json({ success: false, error: 'Admin sudah ada.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    const displayName = String(body.display_name || '').trim();

    if (!username || !password || !displayName) {
      return res.status(400).json({ success: false, error: 'Username, password, dan display_name wajib diisi.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password minimal 6 karakter.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
      .from('operators')
      .insert({
        username,
        display_name: displayName,
        password_hash: passwordHash,
        role: 'admin',
        is_active: true,
        updated_at: new Date().toISOString()
      })
      .select('id, username, display_name, role')
      .single();

    if (error) throw error;

    return res.status(201).json({ success: true, operator: data });
  } catch (error) {
    console.error('bootstrap-admin error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Server error.'
    });
  }
}
