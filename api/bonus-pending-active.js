import { createClient } from '@supabase/supabase-js';

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

function auth(req) {
  const match = String(req.headers.authorization || req.headers.Authorization || '').match(/^Bearer\s+(.+)$/i);
  return Boolean(process.env.HERMES_PARSER_API_TOKEN && match && match[1] === process.env.HERMES_PARSER_API_TOKEN);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!auth(req)) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });

  try {
    const bonusDate = String(req.query.bonus_date || '').trim();
    const query = supabase
      .from('bonus_done_daily')
      .select('login_id, login_key, bonus_amount, remark, operator_name, claim_batch_id, claimed_at, pending_expires_at')
      .eq('bonus_type', 'BONUS_HARIAN')
      .eq('bonus_status', 'PENDING')
      .gt('pending_expires_at', new Date().toISOString())
      .order('claimed_at', { ascending: true });
    if (bonusDate) query.eq('bonus_date', bonusDate);
    const { data, error } = await query;
    if (error) throw error;
    return res.status(200).json({ ok: true, rows: data || [] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'PENDING_FAILED', message: error.message || 'Gagal membaca pending aktif.' });
  }
}
