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

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ success: false, error: 'Method not allowed.' });
    }

    if (!supabase) {
      return res.status(500).json({ success: false, error: 'SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diset.' });
    }

    if (!sessionSecret) {
      return res.status(500).json({ success: false, error: 'OPERATOR_SESSION_SECRET belum diset.' });
    }

    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: 'Session tidak valid.' });
    }

    let payload;
    try {
      payload = jwt.verify(token, sessionSecret);
    } catch (error) {
      return res.status(401).json({ success: false, error: 'Session tidak valid.' });
    }

    const { data: operator, error } = await supabase
      .from('operators')
      .select('id, username, display_name, role, is_active, is_protected')
      .eq('id', payload.operator_id)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    if (!operator) {
      return res.status(401).json({ success: false, error: 'Session tidak valid.' });
    }

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
