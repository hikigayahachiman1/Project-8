import { createClient } from '@supabase/supabase-js';

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

function auth(req) {
  const match = String(req.headers.authorization || req.headers.Authorization || '').match(/^Bearer\s+(.+)$/i);
  return Boolean(process.env.HERMES_PARSER_API_TOKEN && match && match[1] === process.env.HERMES_PARSER_API_TOKEN);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!auth(req)) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const claimBatchId = String(body.claim_batch_id || '').trim();
    const operatorName = String(body.operator_name || 'Hermes Telegram').trim();
    if (!claimBatchId) return res.status(400).json({ ok: false, error: 'CLAIM_BATCH_ID_REQUIRED' });

    const now = new Date().toISOString();
    const note = `Batch dibatalkan/expired oleh ${operatorName}`;
    const { data: rows, error: rowError } = await supabase
      .from('bonus_done_daily')
      .update({
        bonus_status: 'EXPIRED',
        updated_at: now,
        finalized_note: note
      })
      .eq('claim_batch_id', claimBatchId)
      .eq('bonus_status', 'PENDING')
      .select('id, login_id, login_key, bonus_amount, bonus_status');
    if (rowError) throw rowError;

    const { error: lockError } = await supabase
      .from('bonus_process_locks')
      .update({
        lock_status: 'EXPIRED',
        updated_at: now,
        finalized_note: note
      })
      .eq('claim_batch_id', claimBatchId)
      .eq('lock_status', 'PENDING');
    if (lockError) throw lockError;

    return res.status(200).json({
      ok: true,
      claim_batch_id: claimBatchId,
      expired_count: rows?.length || 0,
      rows: rows || []
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'EXPIRE_BATCH_FAILED', message: error.message || 'Gagal expire batch.' });
  }
}
