import { createClient } from '@supabase/supabase-js';

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

function token(req) {
  const match = String(req.headers.authorization || req.headers.Authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function auth(req) {
  return Boolean(process.env.HERMES_PARSER_API_TOKEN && token(req) === process.env.HERMES_PARSER_API_TOKEN);
}

function todayJakarta() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const map = {};
  parts.forEach(part => { if (part.type !== 'literal') map[part.type] = part.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function countBy(rows, field, mapper = value => value) {
  return (rows || []).reduce((acc, row) => {
    const key = mapper(row[field] || 'EMPTY');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!auth(req)) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });

  try {
    await supabase.rpc('expire_old_bonus_pending');
    const bonusDate = String(req.query.bonus_date || todayJakarta());
    const { data: rows, error } = await supabase
      .from('bonus_done_daily')
      .select('id, bonus_status, pending_expires_at')
      .eq('bonus_date', bonusDate)
      .eq('bonus_type', 'BONUS_HARIAN');
    if (error) throw error;

    const { data: locks, error: lockError } = await supabase
      .from('bonus_process_locks')
      .select('id, lock_status, pending_expires_at, claim_batch_id, operator_name')
      .eq('bonus_date', bonusDate)
      .order('updated_at', { ascending: false });
    if (lockError) throw lockError;

    const now = Date.now();
    const bonusSummary = {
      DONE: 0,
      PENDING_ACTIVE: 0,
      EXPIRED: 0,
      EMPTY: 0
    };
    (rows || []).forEach(row => {
      const status = String(row.bonus_status || 'EMPTY').toUpperCase();
      if (status === 'PENDING' && row.pending_expires_at && new Date(row.pending_expires_at).getTime() >= now) bonusSummary.PENDING_ACTIVE += 1;
      else if (status === 'DONE') bonusSummary.DONE += 1;
      else if (status === 'EXPIRED' || status === 'PENDING') bonusSummary.EXPIRED += 1;
      else bonusSummary.EMPTY += 1;
    });

    return res.status(200).json({
      ok: true,
      bonus_date: bonusDate,
      summary: bonusSummary,
      locks_summary: countBy(locks || [], 'lock_status', value => String(value || 'EMPTY').toUpperCase()),
      locks: locks || []
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'STATUS_FAILED', message: error.message || 'Gagal membaca status bonus.' });
  }
}
