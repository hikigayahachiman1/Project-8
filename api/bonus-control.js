import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.OPERATOR_SESSION_SECRET;

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

function json(res, status, body) {
  return res.status(status).json(body);
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function parserTokenAuthorized(req) {
  const expected = process.env.HERMES_PARSER_API_TOKEN || '';
  return Boolean(expected && bearerToken(req) === expected);
}

async function getOperatorContext(req) {
  if (!sessionSecret || !supabase) return null;
  const token = bearerToken(req);
  if (!token) return null;

  try {
    const payload = jwt.verify(token, sessionSecret);
    if (!payload.operator_id || !payload.session_token_id) return null;

    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: session, error: sessionError } = await supabase
      .from('operator_active_sessions')
      .select('id')
      .eq('operator_id', payload.operator_id)
      .eq('session_token_id', String(payload.session_token_id))
      .eq('is_active', true)
      .gte('last_seen_at', cutoff)
      .maybeSingle();
    if (sessionError || !session) return null;

    const { data: operator, error: operatorError } = await supabase
      .from('operators')
      .select('id, username, display_name, role, is_active')
      .eq('id', payload.operator_id)
      .eq('is_active', true)
      .maybeSingle();
    if (operatorError || !operator) return null;
    return {
      type: 'operator',
      operator,
      role: operator.role || 'operator',
      claim_owner: `OPERATOR-${operator.id}`
    };
  } catch (error) {
    return null;
  }
}

async function getAuthContext(req) {
  const operator = await getOperatorContext(req);
  if (operator) return operator;
  if (parserTokenAuthorized(req)) return { type: 'parser_token', role: 'parser' };
  return null;
}

function parseBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function countBy(rows, field) {
  return (rows || []).reduce((acc, row) => {
    const key = String(row[field] || 'EMPTY').toUpperCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeRpcCount(data, field) {
  if (Array.isArray(data)) return Number(data[0]?.[field] || 0);
  return Number(data?.[field] || 0);
}

function normalizeBonusType(value) {
  const type = String(value || 'ALL').trim().toUpperCase();
  if (['BONUS_HARIAN', 'KLAIM_MAHJONG', 'ALL'].includes(type)) return type;
  return 'ALL';
}

function statusKey(row) {
  const status = String(row.bonus_status || 'EMPTY').toUpperCase();
  const pendingMs = row.pending_expires_at ? new Date(row.pending_expires_at).getTime() : 0;
  if (status === 'DONE') return 'DONE';
  if (status === 'PENDING' && pendingMs >= Date.now()) return 'PENDING_ACTIVE';
  if (status === 'PENDING') return 'PENDING_EXPIRED';
  if (status === 'EXPIRED') return 'EXPIRED';
  if (status === 'EMPTY') return 'EMPTY';
  return status || 'EMPTY';
}

function emptyStatusSummary() {
  return {
    DONE: { count: 0, amount: 0 },
    PENDING_ACTIVE: { count: 0, amount: 0 },
    PENDING_EXPIRED: { count: 0, amount: 0 },
    EXPIRED: { count: 0, amount: 0 },
    EMPTY: { count: 0, amount: 0 }
  };
}

function addSummary(summary, key, row) {
  if (!summary[key]) summary[key] = { count: 0, amount: 0 };
  summary[key].count += 1;
  summary[key].amount += Number(row.bonus_amount || 0);
}

async function health() {
  const serverTime = new Date().toISOString();
  const hasSupabaseEnv = Boolean(supabaseUrl && serviceRoleKey);
  let supabaseConnected = false;
  let supabaseError = '';

  if (supabase) {
    const { error } = await supabase
      .from('bonus_done_daily')
      .select('id')
      .limit(1);
    supabaseConnected = !error;
    supabaseError = error ? (error.message || error.code || 'Supabase query gagal.') : '';
  }

  const hermesBaseUrl = process.env.HERMES_BASE_URL || process.env.HERMES_API_BASE_URL || process.env.LOCAL_ADJUSTMENT_RUNNER_URL || '';
  let hermesConnected = null;
  let hermesError = '';
  if (hermesBaseUrl && typeof fetch === 'function') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const response = await fetch(hermesBaseUrl, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);
      hermesConnected = response.ok;
      if (!response.ok) hermesError = `HTTP ${response.status}`;
    } catch (error) {
      hermesConnected = false;
      hermesError = error.message || 'Hermes tidak dapat dihubungi.';
    }
  }

  return {
    ok: hasSupabaseEnv && supabaseConnected,
    action: 'health',
    supabase_env_available: hasSupabaseEnv,
    supabase_connected: supabaseConnected,
    hermes_connected: hermesConnected,
    parser_api_connected: true,
    server_time: serverTime,
    error: supabaseError || hermesError || ''
  };
}

async function expireOldPending() {
  const { data, error } = await supabase.rpc('expire_old_bonus_pending');
  if (error) throw error;
  return {
    ok: true,
    action: 'expire_pending',
    expired_bonus_rows: normalizeRpcCount(data, 'expired_bonus_rows'),
    expired_lock_rows: normalizeRpcCount(data, 'expired_lock_rows')
  };
}

async function status(body) {
  const bonusDate = String(body.bonus_date || '').trim();
  if (!isValidDate(bonusDate)) {
    const error = new Error('bonus_date wajib format YYYY-MM-DD.');
    error.statusCode = 400;
    error.code = 'INVALID_BONUS_DATE';
    throw error;
  }

  const { data: rows, error } = await supabase
    .from('bonus_done_daily')
    .select('id, bonus_status, pending_expires_at')
    .eq('bonus_date', bonusDate)
    .eq('bonus_type', 'BONUS_HARIAN');
  if (error) throw error;

  const { data: locks, error: lockError } = await supabase
    .from('bonus_process_locks')
    .select('id, bonus_date, lock_status, claim_batch_id, claim_owner, operator_name, pending_expires_at, started_at, updated_at, done_at')
    .eq('bonus_date', bonusDate)
    .order('updated_at', { ascending: false });
  if (lockError) throw lockError;

  const nowMs = Date.now();
  const summary = {
    done: 0,
    pending_active: 0,
    expired: 0,
    other: 0,
    total: rows?.length || 0
  };

  (rows || []).forEach(row => {
    const rowStatus = String(row.bonus_status || '').toUpperCase();
    const pendingMs = row.pending_expires_at ? new Date(row.pending_expires_at).getTime() : 0;
    if (rowStatus === 'DONE') summary.done += 1;
    else if (rowStatus === 'PENDING' && pendingMs >= nowMs) summary.pending_active += 1;
    else if (rowStatus === 'EXPIRED' || rowStatus === 'PENDING') summary.expired += 1;
    else summary.other += 1;
  });

  return {
    ok: true,
    action: 'status',
    bonus_date: bonusDate,
    summary,
    locks_summary: countBy(locks || [], 'lock_status'),
    locks: locks || []
  };
}

async function dashboardStatus(body) {
  const bonusDate = String(body.bonus_date || '').trim();
  if (!isValidDate(bonusDate)) {
    const error = new Error('bonus_date wajib format YYYY-MM-DD.');
    error.statusCode = 400;
    error.code = 'INVALID_BONUS_DATE';
    throw error;
  }

  const { data: rows, error } = await supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, operator_name, bonus_status, claim_owner, claim_batch_id, claimed_at, pending_expires_at, created_at, done_at')
    .eq('bonus_date', bonusDate)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const { data: locks, error: lockError } = await supabase
    .from('bonus_process_locks')
    .select('id, bonus_date, lock_status, claim_batch_id, claim_owner, operator_name, pending_expires_at, started_at, updated_at, done_at')
    .eq('bonus_date', bonusDate)
    .order('updated_at', { ascending: false })
    .limit(25);
  if (lockError) throw lockError;

  const byStatus = emptyStatusSummary();
  const byBonusType = {};
  (rows || []).forEach(row => {
    const key = statusKey(row);
    addSummary(byStatus, key, row);
    const bonusType = String(row.bonus_type || 'EMPTY').toUpperCase();
    if (!byBonusType[bonusType]) byBonusType[bonusType] = emptyStatusSummary();
    addSummary(byBonusType[bonusType], key, row);
  });

  const emptyBatchCount = (locks || []).filter(lock => String(lock.lock_status || '').toUpperCase() === 'EMPTY').length;
  byStatus.EMPTY.count += emptyBatchCount;

  return {
    ok: true,
    action: 'dashboard_status',
    bonus_date: bonusDate,
    summary: byStatus,
    by_bonus_type: byBonusType,
    locks_summary: countBy(locks || [], 'lock_status'),
    recent_batches: locks || [],
    recent_pending: (rows || [])
      .filter(row => ['PENDING_ACTIVE', 'PENDING_EXPIRED'].includes(statusKey(row)))
      .slice(0, 50)
  };
}

async function pendingActive(body) {
  const bonusDate = String(body.bonus_date || '').trim();
  const bonusType = normalizeBonusType(body.bonus_type);
  if (bonusDate && !isValidDate(bonusDate)) {
    const error = new Error('bonus_date wajib format YYYY-MM-DD.');
    error.statusCode = 400;
    error.code = 'INVALID_BONUS_DATE';
    throw error;
  }

  let query = supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, operator_name, claim_owner, claim_batch_id, claimed_at, pending_expires_at, created_at')
    .eq('bonus_status', 'PENDING')
    .gte('pending_expires_at', new Date().toISOString())
    .order('claimed_at', { ascending: true });
  if (bonusDate) query = query.eq('bonus_date', bonusDate);
  if (bonusType !== 'ALL') query = query.eq('bonus_type', bonusType);
  const { data, error } = await query;
  if (error) throw error;

  return {
    ok: true,
    action: 'pending_active',
    bonus_date: bonusDate,
    count: data?.length || 0,
    rows: data || []
  };
}

async function pendingExpired(body) {
  const bonusDate = String(body.bonus_date || '').trim();
  const bonusType = normalizeBonusType(body.bonus_type);
  if (bonusDate && !isValidDate(bonusDate)) {
    const error = new Error('bonus_date wajib format YYYY-MM-DD.');
    error.statusCode = 400;
    error.code = 'INVALID_BONUS_DATE';
    throw error;
  }

  let query = supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, operator_name, claim_owner, claim_batch_id, claimed_at, pending_expires_at, created_at')
    .eq('bonus_status', 'PENDING')
    .lt('pending_expires_at', new Date().toISOString())
    .order('pending_expires_at', { ascending: true });
  if (bonusDate) query = query.eq('bonus_date', bonusDate);
  if (bonusType !== 'ALL') query = query.eq('bonus_type', bonusType);
  const { data, error } = await query;
  if (error) throw error;

  return {
    ok: true,
    action: 'pending_expired',
    bonus_date: bonusDate || '',
    bonus_type: bonusType,
    count: data?.length || 0,
    rows: data || []
  };
}

async function assertBatchPermission(claimBatchId, authContext) {
  const { data: lock, error } = await supabase
    .from('bonus_process_locks')
    .select('id, claim_batch_id, claim_owner, lock_status')
    .eq('claim_batch_id', claimBatchId)
    .eq('lock_status', 'PENDING')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!lock) {
    const missing = new Error('Batch PENDING tidak ditemukan.');
    missing.statusCode = 404;
    missing.code = 'PENDING_BATCH_NOT_FOUND';
    throw missing;
  }
  if (authContext?.role === 'superadmin') return lock;
  if (authContext?.type === 'operator' && lock.claim_owner === authContext.claim_owner) return lock;
  const denied = new Error('Hanya pemilik batch atau superadmin yang boleh mengubah batch ini.');
  denied.statusCode = 403;
  denied.code = 'BATCH_PERMISSION_DENIED';
  throw denied;
}

async function markDone(body, authContext) {
  const claimBatchId = String(body.claim_batch_id || '').trim();
  const operatorName = String(body.operator_name || '').trim() || 'Operator';
  if (!claimBatchId) {
    const error = new Error('claim_batch_id wajib diisi.');
    error.statusCode = 400;
    error.code = 'CLAIM_BATCH_ID_REQUIRED';
    throw error;
  }
  await assertBatchPermission(claimBatchId, authContext);

  const now = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from('bonus_done_daily')
    .update({
      bonus_status: 'DONE',
      done_at: now,
      done_by_name: operatorName,
      updated_at: now
    })
    .eq('claim_batch_id', claimBatchId)
    .eq('bonus_status', 'PENDING')
    .select('id, bonus_date, login_id, login_key, bonus_amount, bonus_status, done_at, done_by_name');
  if (error) throw error;

  const { data: locks, error: lockError } = await supabase
    .from('bonus_process_locks')
    .update({
      lock_status: 'DONE',
      done_at: now,
      done_by_name: operatorName,
      updated_at: now
    })
    .eq('claim_batch_id', claimBatchId)
    .eq('lock_status', 'PENDING')
    .select('id, bonus_date, lock_status, claim_batch_id, done_at, done_by_name');
  if (lockError) throw lockError;

  return {
    ok: true,
    action: 'mark_done',
    claim_batch_id: claimBatchId,
    done_count: rows?.length || 0,
    lock_done_count: locks?.length || 0,
    rows: rows || [],
    locks: locks || []
  };
}

async function expireBatch(body, authContext) {
  const claimBatchId = String(body.claim_batch_id || '').trim();
  if (!claimBatchId) {
    const error = new Error('claim_batch_id wajib diisi.');
    error.statusCode = 400;
    error.code = 'CLAIM_BATCH_ID_REQUIRED';
    throw error;
  }
  await assertBatchPermission(claimBatchId, authContext);

  const now = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from('bonus_done_daily')
    .update({
      bonus_status: 'EXPIRED',
      updated_at: now
    })
    .eq('claim_batch_id', claimBatchId)
    .eq('bonus_status', 'PENDING')
    .select('id, bonus_date, login_id, login_key, bonus_amount, bonus_status');
  if (error) throw error;

  const { data: locks, error: lockError } = await supabase
    .from('bonus_process_locks')
    .update({
      lock_status: 'EXPIRED',
      updated_at: now
    })
    .eq('claim_batch_id', claimBatchId)
    .eq('lock_status', 'PENDING')
    .select('id, bonus_date, lock_status, claim_batch_id');
  if (lockError) throw lockError;

  return {
    ok: true,
    action: 'expire_batch',
    claim_batch_id: claimBatchId,
    expired_count: rows?.length || 0,
    lock_expired_count: locks?.length || 0,
    rows: rows || [],
    locks: locks || []
  };
}

function tsvEscape(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim();
}

async function exportBonus(body) {
  const bonusDate = String(body.bonus_date || '').trim();
  if (!isValidDate(bonusDate)) {
    const error = new Error('bonus_date wajib format YYYY-MM-DD.');
    error.statusCode = 400;
    error.code = 'INVALID_BONUS_DATE';
    throw error;
  }

  const { data, error } = await supabase
    .from('bonus_done_daily')
    .select('bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, bonus_status, operator_name, done_by_name, claim_batch_id, pending_expires_at, created_at, done_at')
    .eq('bonus_date', bonusDate)
    .eq('bonus_type', 'BONUS_HARIAN')
    .order('created_at', { ascending: true });
  if (error) throw error;

  const rows = (data || []).map((row, index) => ({
    No: index + 1,
    'Bonus Date': row.bonus_date || '',
    'Login ID': row.login_id || row.login_key || '',
    'Login Key': row.login_key || row.login_id || '',
    'Bonus Type': row.bonus_type || '',
    'Amount BO': row.bonus_amount ?? '',
    Remark: row.remark || '',
    Status: row.bonus_status || '',
    Operator: row.done_by_name || row.operator_name || '',
    'Claim Batch ID': row.claim_batch_id || '',
    'Pending Expires At': row.pending_expires_at || '',
    'Done At': row.done_at || '',
    'Created At': row.created_at || ''
  }));
  const columns = ['No', 'Bonus Date', 'Login ID', 'Login Key', 'Bonus Type', 'Amount BO', 'Remark', 'Status', 'Operator', 'Claim Batch ID', 'Pending Expires At', 'Done At', 'Created At'];
  const tsv = [
    columns.join('\t'),
    ...rows.map(row => columns.map(column => tsvEscape(row[column])).join('\t'))
  ].join('\n');

  return {
    ok: true,
    action: 'export_bonus',
    bonus_date: bonusDate,
    count: rows.length,
    rows,
    tsv
  };
}

async function exportClaimMahjong(body) {
  const bonusDate = String(body.bonus_date || '').trim();
  if (bonusDate && !isValidDate(bonusDate)) {
    const error = new Error('bonus_date wajib format YYYY-MM-DD.');
    error.statusCode = 400;
    error.code = 'INVALID_BONUS_DATE';
    throw error;
  }

  let query = supabase
    .from('bonus_done_daily')
    .select('bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, bonus_status, operator_name, done_by_name, claim_batch_id, pending_expires_at, created_at, done_at')
    .eq('bonus_type', 'KLAIM_MAHJONG')
    .order('created_at', { ascending: true });
  if (bonusDate) query = query.eq('bonus_date', bonusDate);
  const { data, error } = await query;
  if (error) throw error;

  if (!data || data.length === 0) {
    return {
      ok: false,
      action: 'export_claim_mahjong',
      message: 'Data Klaim Mahjong belum disimpan ke Supabase, perlu mapping tabel terlebih dahulu.',
      rows: [],
      tsv: ''
    };
  }

  const rows = data.map((row, index) => ({
    No: index + 1,
    'Bonus Date': row.bonus_date || '',
    'Login ID': row.login_id || row.login_key || '',
    'Login Key': row.login_key || row.login_id || '',
    'Bonus Type': row.bonus_type || '',
    'Amount BO': row.bonus_amount ?? '',
    Remark: row.remark || '',
    Status: row.bonus_status || '',
    Operator: row.done_by_name || row.operator_name || '',
    'Claim Batch ID': row.claim_batch_id || '',
    'Pending Expires At': row.pending_expires_at || '',
    'Done At': row.done_at || '',
    'Created At': row.created_at || ''
  }));
  const columns = ['No', 'Bonus Date', 'Login ID', 'Login Key', 'Bonus Type', 'Amount BO', 'Remark', 'Status', 'Operator', 'Claim Batch ID', 'Pending Expires At', 'Done At', 'Created At'];
  return {
    ok: true,
    action: 'export_claim_mahjong',
    bonus_date: bonusDate || '',
    count: rows.length,
    rows,
    tsv: [columns.join('\t'), ...rows.map(row => columns.map(column => tsvEscape(row[column])).join('\t'))].join('\n')
  };
}

async function hermesPreviewStatus() {
  return {
    ok: true,
    action: 'hermes_preview_status',
    message: 'Hermes preview queue belum dibuat.',
    preview_statuses: ['PREVIEW', 'WAITING_APPROVAL', 'RELEASED_TO_WORKER', 'COMPLETED', 'FAILED'],
    rows: []
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  const authContext = await getAuthContext(req);
  if (!authContext) {
    return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
  }

  try {
    const body = parseBody(req);
    const action = String(body.action || '').trim();
    if (action === 'health') return json(res, 200, await health());
    if (!supabase) return json(res, 500, { ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    if (action === 'expire_pending') return json(res, 200, await expireOldPending());
    if (action === 'status') return json(res, 200, await status(body));
    if (action === 'dashboard_status') return json(res, 200, await dashboardStatus(body));
    if (action === 'pending_active') return json(res, 200, await pendingActive(body));
    if (action === 'pending_expired') return json(res, 200, await pendingExpired(body));
    if (action === 'mark_done') return json(res, 200, await markDone(body, authContext));
    if (action === 'expire_batch') return json(res, 200, await expireBatch(body, authContext));
    if (action === 'export_bonus') return json(res, 200, await exportBonus(body));
    if (action === 'export_claim_mahjong') return json(res, 200, await exportClaimMahjong(body));
    if (action === 'hermes_preview_status') return json(res, 200, await hermesPreviewStatus());

    return json(res, 400, { ok: false, error: 'UNKNOWN_ACTION', message: 'Action tidak dikenal.' });
  } catch (error) {
    console.error('bonus-control error:', error);
    return json(res, error.statusCode || 500, {
      ok: false,
      error: error.code || 'BONUS_CONTROL_FAILED',
      message: error.message || 'Bonus control gagal.'
    });
  }
}
