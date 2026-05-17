import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    })
  : null;

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeLoginId(value) {
  return String(value || '').trim().toUpperCase();
}

export default async function handler(req, res) {
  try {
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diset.'
      });
    }

    if (req.method === 'GET') {
      const date = String(req.query.date || '');

      if (!isValidDate(date)) {
        return res.status(400).json({
          success: false,
          error: 'Format date harus YYYY-MM-DD.'
        });
      }

      await supabase
        .from('bonus_done_daily')
        .delete()
        .lt('expires_at', new Date().toISOString());

      const { data, error } = await supabase
        .from('bonus_done_daily')
        .select('bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, created_at')
        .eq('bonus_date', date)
        .eq('bonus_type', 'BONUS_HARIAN')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: true });

      if (error) throw error;

      const loginIds = [...new Set((data || []).map(row => normalizeLoginId(row.login_key || row.login_id)))];

      return res.status(200).json({
        success: true,
        date,
        loginIds,
        rows: data || []
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      const date = String(body.date || '');
      const rows = Array.isArray(body.rows) ? body.rows : [];

      if (!isValidDate(date)) {
        return res.status(400).json({
          success: false,
          error: 'Format date harus YYYY-MM-DD.'
        });
      }

      const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();

      const normalizedPayload = rows
        .map(row => {
          const loginId = normalizeLoginId(row.login_id);
          return {
            bonus_date: date,
            login_id: loginId,
            login_key: loginId,
            bonus_type: 'BONUS_HARIAN',
            bonus_amount: Number.isFinite(Number(row.bonus_amount)) ? Number(row.bonus_amount) : null,
            remark: String(row.remark || ''),
            source: String(row.source || 'unknown'),
            operator_name: String(row.operator_name || ''),
            updated_at: now,
            expires_at: expiresAt
          };
        })
        .filter(row => row.login_id);

      const payloadMap = new Map();
      normalizedPayload.forEach(row => {
        const key = `${row.bonus_date}|${row.login_key}|${row.bonus_type}`;
        payloadMap.set(key, row);
      });
      const payload = [...payloadMap.values()];
      const duplicatesRemoved = rows.length - payload.length;

      if (payload.length === 0) {
        return res.status(200).json({
          success: true,
          inserted: 0,
          skipped: rows.length,
          received: rows.length,
          unique: 0,
          duplicatesRemoved
        });
      }

      const { data, error } = await supabase
        .from('bonus_done_daily')
        .insert(payload, {
          onConflict: 'bonus_date,login_key,bonus_type',
          ignoreDuplicates: true
        })
        .select('id, bonus_date, login_id, login_key');

      if (error) throw error;
      const claimedRows = data || [];
      const loginIds = [...new Set(claimedRows.map(row => normalizeLoginId(row.login_key || row.login_id)))];

      return res.status(200).json({
        success: true,
        received: rows.length,
        unique: payload.length,
        claimed: claimedRows.length,
        skipped: payload.length - claimedRows.length,
        duplicatesRemoved,
        loginIds,
        rows: claimedRows
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({
      success: false,
      error: 'Method not allowed.'
    });
  } catch (error) {
    console.error('bonus-done error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Server error.',
      details: error
    });
  }
}
