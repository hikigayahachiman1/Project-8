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
    const { data: lock, error: lockReadError } = await supabase
      .from('bonus_process_locks')
      .select('*')
      .eq('claim_batch_id', claimBatchId)
      .eq('lock_status', 'PENDING')
      .maybeSingle();
    if (lockReadError) throw lockReadError;
    if (!lock) return res.status(404).json({ ok: false, error: 'PENDING_BATCH_NOT_FOUND' });

    const { data: rows, error: rowError } = await supabase
      .from('bonus_done_daily')
      .update({
        bonus_status: 'DONE',
        done_at: now,
        done_by_name: operatorName,
        updated_at: now
      })
      .eq('claim_batch_id', claimBatchId)
      .eq('bonus_status', 'PENDING')
      .select('id, login_id, login_key, bonus_amount, bonus_status');
    if (rowError) throw rowError;

    const { error: lockError } = await supabase
      .from('bonus_process_locks')
      .update({
        lock_status: 'DONE',
        done_at: now,
        done_by_name: operatorName,
        updated_at: now
      })
      .eq('claim_batch_id', claimBatchId)
      .eq('lock_status', 'PENDING');
    if (lockError) throw lockError;

    return res.status(200).json({
      ok: true,
      claim_batch_id: claimBatchId,
      done_count: rows?.length || 0,
      rows: rows || []
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'MARK_DONE_FAILED', message: error.message || 'Gagal tandai DONE.' });
  }
}
