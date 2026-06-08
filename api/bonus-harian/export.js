import { createClient } from '@supabase/supabase-js';

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

function auth(req) {
  const match = String(req.headers.authorization || req.headers.Authorization || '').match(/^Bearer\s+(.+)$/i);
  return Boolean(process.env.HERMES_PARSER_API_TOKEN && match && match[1] === process.env.HERMES_PARSER_API_TOKEN);
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function rowText(row, delimiter) {
  const values = [
    row.bonus_date || '',
    row.claim_batch_id || '',
    row.login_id || row.login_key || '',
    row.login_key || '',
    row.bonus_amount ?? '',
    row.remark || '',
    row.bonus_status || '',
    row.source || '',
    row.operator_name || '',
    row.claim_batch_id || '',
    row.pending_expires_at || '',
    row.done_at || '',
    row.created_at || ''
  ];
  return delimiter === ',' ? values.map(escapeCsv).join(',') : values.join('\t');
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
    const format = String(req.query.format || 'tsv').toLowerCase() === 'csv' ? 'csv' : 'tsv';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bonusDate)) {
      return res.status(400).json({ ok: false, error: 'INVALID_BONUS_DATE' });
    }
    const { data, error } = await supabase
      .from('bonus_done_daily')
      .select('bonus_date, login_id, login_key, bonus_amount, remark, source, operator_name, bonus_status, claim_batch_id, pending_expires_at, done_at, created_at')
      .eq('bonus_date', bonusDate)
      .eq('bonus_type', 'BONUS_HARIAN')
      .order('created_at', { ascending: true });
    if (error) throw error;

    const delimiter = format === 'csv' ? ',' : '\t';
    const header = ['Bonus Date','Batch ID','Login ID','Login Key','Amount BO','Remark','Status','Reason','Operator','Claim Batch ID','Pending Expires At','Done At','Created At'];
    const body = [header.join(delimiter), ...(data || []).map(row => rowText(row, delimiter))].join('\n');
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'text/tab-separated-values; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bonus-harian-${bonusDate}.${format}"`);
    return res.status(200).send(body);
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'EXPORT_FAILED', message: error.message || 'Gagal export Bonus Harian.' });
  }
}
