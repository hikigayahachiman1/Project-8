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

function isHermesLock(lock) {
  const owner = String(lock?.claim_owner || '').toUpperCase();
  const operator = String(lock?.operator_name || '').toUpperCase();
  return owner.includes('HERMES') || operator.includes('HERMES');
}

function previewStatusFromLock(lock) {
  const status = String(lock?.lock_status || '').toUpperCase();
  if (status === 'PENDING') return 'WAITING_SUPERADMIN_APPROVAL';
  if (status === 'RELEASED_TO_WORKER') return 'RELEASED_TO_WORKER';
  if (status === 'DONE') return 'COMPLETED';
  if (status === 'EXPIRED') return 'CANCELLED';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'EMPTY') return 'PREVIEW';
  return status || 'PREVIEW';
}

function batchCodeFromLock(lock) {
  return lock?.claim_batch_id || '';
}

function requireSuperadmin(authContext) {
  if (authContext?.role === 'superadmin') return;
  const error = new Error('Hanya Superadmin yang boleh menjalankan aksi preview Hermes.');
  error.statusCode = 403;
  error.code = 'SUPERADMIN_REQUIRED';
  throw error;
}

function errorWithCode(code, message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function hermesTaskConfig() {
  const baseUrl = String(process.env.HERMES_TASK_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.HERMES_TASK_API_TOKEN || '').trim();
  if (!baseUrl || !token) {
    throw errorWithCode(
      'HERMES_TASK_NOT_CONFIGURED',
      'ENV HERMES_TASK_BASE_URL dan HERMES_TASK_API_TOKEN wajib diisi.',
      500
    );
  }
  return { baseUrl, token };
}

function rowToHermesTaskItem(row) {
  return {
    login_id: row.login_id || row.login_key || '',
    member_id: row.member_id || '',
    member_name: row.member_name || '',
    amount_bo: Number(row.bonus_amount || 0),
    remark: row.remark || ''
  };
}

function extractHermesTaskId(responseBody) {
  return responseBody?.task_id
    || responseBody?.id
    || responseBody?.task?.id
    || responseBody?.data?.task_id
    || responseBody?.data?.id
    || '';
}

async function createHermesTaskQueue(payload) {
  const { baseUrl, token } = hermesTaskConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}/api/task-queue/tasks/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      body = { message: text };
    }
    if (!response.ok) {
      throw errorWithCode(
        'HERMES_TASK_CREATE_FAILED',
        body?.message || `Hermes task queue gagal membuat task. HTTP ${response.status}.`,
        502,
        { hermes_response: body }
      );
    }
    return {
      task_id: extractHermesTaskId(body),
      response: body
    };
  } catch (error) {
    if (error?.code) throw error;
    const isAbort = error?.name === 'AbortError';
    throw errorWithCode(
      isAbort ? 'HERMES_TASK_TIMEOUT' : 'HERMES_TASK_UNREACHABLE',
      isAbort ? 'Hermes VPS task queue timeout.' : 'Hermes VPS task queue tidak bisa dihubungi.',
      502
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function updateHermesReleasedLock(claimBatchId, operatorName, taskResult, now) {
  const payload = {
    lock_status: 'RELEASED_TO_WORKER',
    updated_at: now,
    done_by_name: operatorName,
    task_id: taskResult.task_id || '',
    task_response: taskResult.response || null
  };
  let { data, error } = await supabase
    .from('bonus_process_locks')
    .update(payload)
    .eq('claim_batch_id', claimBatchId)
    .select('id, bonus_date, lock_status, claim_batch_id, claim_owner, operator_name, pending_expires_at, updated_at, done_by_name')
    .maybeSingle();
  if (error && error.code === '42703') {
    const fallback = await supabase
      .from('bonus_process_locks')
      .update({
        lock_status: 'RELEASED_TO_WORKER',
        updated_at: now,
        done_by_name: operatorName
      })
      .eq('claim_batch_id', claimBatchId)
      .select('id, bonus_date, lock_status, claim_batch_id, claim_owner, operator_name, pending_expires_at, updated_at, done_by_name')
      .maybeSingle();
    data = fallback.data;
    error = fallback.error;
  }
  if (error) throw error;
  return data;
}

async function fetchHermesLocks(bonusDate = '') {
  let query = supabase
    .from('bonus_process_locks')
    .select('id, bonus_date, lock_status, claim_batch_id, claim_owner, operator_name, pending_expires_at, started_at, created_at, updated_at, done_at, done_by_name')
    .order('updated_at', { ascending: false })
    .limit(100);
  if (bonusDate) query = query.eq('bonus_date', bonusDate);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).filter(isHermesLock);
}

async function fetchRowsByBatch(claimBatchId) {
  if (!claimBatchId) return [];
  const baseSelect = 'id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, operator_name, bonus_status, claim_owner, claim_batch_id, claimed_at, pending_expires_at, created_at, done_at';
  let { data, error } = await supabase
    .from('bonus_done_daily')
    .select(`${baseSelect}, member_id, member_name`)
    .eq('claim_batch_id', claimBatchId)
    .order('created_at', { ascending: true });
  if (error && error.code === '42703') {
    const fallback = await supabase
      .from('bonus_done_daily')
      .select(`${baseSelect}, member_id`)
      .eq('claim_batch_id', claimBatchId)
      .order('created_at', { ascending: true });
    data = fallback.data;
    error = fallback.error;
  }
  if (error && error.code === '42703') {
    const fallback = await supabase
      .from('bonus_done_daily')
      .select(baseSelect)
      .eq('claim_batch_id', claimBatchId)
      .order('created_at', { ascending: true });
    data = fallback.data;
    error = fallback.error;
  }
  if (error) throw error;
  return data || [];
}

function summarizePreviewRows(rows) {
  return {
    total_eligible: rows.length,
    ready_items: rows.filter(row => String(row.bonus_status || '').toUpperCase() === 'PENDING').length,
    skipped_already_given: 0,
    pending_other_batch: 0,
    manual_review: 0,
    total_amount_bo: rows.reduce((sum, row) => sum + Number(row.bonus_amount || 0), 0)
  };
}

function previewListItem(lock, rows) {
  const summary = summarizePreviewRows(rows);
  return {
    batch_code: batchCodeFromLock(lock),
    claim_batch_id: lock.claim_batch_id || '',
    source: 'hermes-telegram',
    bonus_date: lock.bonus_date || '',
    total_eligible: summary.total_eligible,
    ready_items: summary.ready_items,
    skipped_already_given: summary.skipped_already_given,
    pending_other_batch: summary.pending_other_batch,
    manual_review: summary.manual_review,
    total_amount_bo: summary.total_amount_bo,
    status: previewStatusFromLock(lock),
    created_at: lock.created_at || lock.started_at || '',
    updated_at: lock.updated_at || '',
    lock_status: lock.lock_status || ''
  };
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

function authDebug(authContext, body, claimBatchId) {
  return {
    body_role: body?.role || '',
    session_role: authContext?.role || '',
    current_role: authContext?.role || body?.role || '',
    current_operator_name: authContext?.operator?.display_name || authContext?.operator?.username || body?.operator_name || '',
    current_claim_owner: authContext?.claim_owner || '',
    claim_batch_id: claimBatchId
  };
}

function logBatchDebug(action, debug) {
  console.info(`bonus-control ${action} debug`, debug);
}

async function assertBatchPermission(action, claimBatchId, authContext, body) {
  const baseDebug = authDebug(authContext, body, claimBatchId);
  const { data: lock, error } = await supabase
    .from('bonus_process_locks')
    .select('id, claim_batch_id, claim_owner, operator_name, lock_status, pending_expires_at, bonus_date')
    .eq('claim_batch_id', claimBatchId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const debug = {
    ...baseDebug,
    batch_claim_owner: lock?.claim_owner || '',
    batch_operator_name: lock?.operator_name || '',
    batch_lock_status: lock?.lock_status || '',
    pending_expires_at: lock?.pending_expires_at || '',
    reject_reason: ''
  };
  if (!lock) {
    debug.reject_reason = 'BATCH_NOT_FOUND';
    logBatchDebug(action, debug);
    const missing = new Error('claim_batch_id tidak ditemukan.');
    missing.statusCode = 404;
    missing.code = 'BATCH_NOT_FOUND';
    missing.debug = debug;
    throw missing;
  }

  const lockStatus = String(lock.lock_status || '').toUpperCase();
  if (action === 'mark_done' && lockStatus === 'EXPIRED') {
    debug.reject_reason = 'BATCH_ALREADY_EXPIRED';
    logBatchDebug(action, debug);
    const expired = new Error('Batch sudah expired, tidak bisa ditandai DONE. Silakan generate ulang / release ulang.');
    expired.statusCode = 409;
    expired.code = 'BATCH_ALREADY_EXPIRED';
    expired.debug = debug;
    throw expired;
  }
  if (lockStatus !== 'PENDING') {
    debug.reject_reason = `BATCH_NOT_PENDING_${lockStatus || 'EMPTY'}`;
    logBatchDebug(action, debug);
    const notPending = new Error(`Batch sudah ${lockStatus || 'tidak PENDING'}, tidak ada PENDING aktif untuk diproses.`);
    notPending.statusCode = 409;
    notPending.code = 'BATCH_NOT_PENDING';
    notPending.debug = debug;
    throw notPending;
  }

  if (authContext?.role === 'superadmin') {
    debug.reject_reason = '';
    logBatchDebug(action, { ...debug, permission: 'SUPERADMIN_BYPASS' });
    return lock;
  }
  const bodyOperatorName = String(body?.operator_name || '').trim().toLowerCase();
  const lockOperatorName = String(lock.operator_name || '').trim().toLowerCase();
  const ownerMatches = authContext?.type === 'operator' && lock.claim_owner === authContext.claim_owner;
  const operatorNameMatches = Boolean(bodyOperatorName && lockOperatorName && bodyOperatorName === lockOperatorName);
  if (ownerMatches || operatorNameMatches) {
    logBatchDebug(action, { ...debug, permission: ownerMatches ? 'OWNER_MATCH' : 'OPERATOR_NAME_MATCH' });
    return lock;
  }

  debug.reject_reason = 'BATCH_PERMISSION_DENIED';
  logBatchDebug(action, debug);
  const denied = new Error('Hanya pemilik batch atau superadmin yang boleh mengubah batch ini.');
  denied.statusCode = 403;
  denied.code = 'BATCH_PERMISSION_DENIED';
  denied.debug = debug;
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
  await assertBatchPermission('mark_done', claimBatchId, authContext, body);

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
  const operatorName = String(body.operator_name || '').trim() || 'Operator';
  if (!claimBatchId) {
    const error = new Error('claim_batch_id wajib diisi.');
    error.statusCode = 400;
    error.code = 'CLAIM_BATCH_ID_REQUIRED';
    throw error;
  }
  await assertBatchPermission('expire_batch', claimBatchId, authContext, body);

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
    operator_name: operatorName,
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
  const list = await hermesPreviewList({});
  return {
    ok: true,
    action: 'hermes_preview_status',
    message: list.rows.length ? 'Hermes preview queue dimuat.' : 'Hermes preview queue belum dibuat.',
    preview_statuses: ['PREVIEW', 'WAITING_SUPERADMIN_APPROVAL', 'RELEASED_TO_WORKER', 'COMPLETED', 'FAILED', 'CANCELLED'],
    rows: list.rows
  };
}

async function hermesPreviewList(body) {
  const bonusDate = String(body.bonus_date || '').trim();
  if (bonusDate && !isValidDate(bonusDate)) {
    const error = new Error('bonus_date wajib format YYYY-MM-DD.');
    error.statusCode = 400;
    error.code = 'INVALID_BONUS_DATE';
    throw error;
  }
  const locks = await fetchHermesLocks(bonusDate);
  const batchIds = locks.map(lock => lock.claim_batch_id).filter(Boolean);
  let rows = [];
  if (batchIds.length) {
    const { data, error } = await supabase
      .from('bonus_done_daily')
      .select('bonus_date, bonus_type, bonus_amount, bonus_status, claim_batch_id')
      .in('claim_batch_id', batchIds);
    if (error) throw error;
    rows = data || [];
  }
  const rowMap = new Map();
  rows.forEach(row => {
    const key = row.claim_batch_id || '';
    if (!rowMap.has(key)) rowMap.set(key, []);
    rowMap.get(key).push(row);
  });
  const previews = locks.map(lock => previewListItem(lock, rowMap.get(lock.claim_batch_id) || []));
  return {
    ok: true,
    action: 'hermes_preview_list',
    bonus_date: bonusDate,
    count: previews.length,
    rows: previews,
    message: previews.length ? 'Hermes preview queue dimuat.' : 'Hermes preview queue belum dibuat.'
  };
}

async function hermesPreviewDetail(body) {
  const claimBatchId = String(body.claim_batch_id || body.batch_code || '').trim();
  if (!claimBatchId) {
    const error = new Error('claim_batch_id atau batch_code wajib diisi.');
    error.statusCode = 400;
    error.code = 'CLAIM_BATCH_ID_REQUIRED';
    throw error;
  }
  const { data: lock, error: lockError } = await supabase
    .from('bonus_process_locks')
    .select('id, bonus_date, lock_status, claim_batch_id, claim_owner, operator_name, pending_expires_at, started_at, created_at, updated_at, done_at')
    .eq('claim_batch_id', claimBatchId)
    .maybeSingle();
  if (lockError) throw lockError;
  if (!lock || !isHermesLock(lock)) {
    const error = new Error('Preview Hermes tidak ditemukan.');
    error.statusCode = 404;
    error.code = 'HERMES_PREVIEW_NOT_FOUND';
    throw error;
  }
  const rawRows = await fetchRowsByBatch(claimBatchId);
  const rows = rawRows.map((row, index) => ({
    No: index + 1,
    bonus_date: row.bonus_date || '',
    login_id: row.login_id || row.login_key || '',
    login_key: row.login_key || row.login_id || '',
    member_id: row.member_id || '',
    amount_bo: row.bonus_amount ?? '',
    remark: row.remark || '',
    status: String(row.bonus_status || '').toUpperCase() === 'PENDING' ? 'READY' : row.bonus_status || '',
    reason: '',
    warning: '',
    claim_batch_id: row.claim_batch_id || '',
    created_at: row.created_at || ''
  }));
  return {
    ok: true,
    action: 'hermes_preview_detail',
    batch: previewListItem(lock, rawRows),
    rows
  };
}

async function hermesPreviewExport(body) {
  const detail = await hermesPreviewDetail(body);
  const columns = ['No', 'Bonus Date', 'Login ID', 'Login Key', 'Amount BO', 'Remark', 'Status', 'Reason', 'Batch Code', 'Created At'];
  const rows = detail.rows.map(row => ({
    No: row.No,
    'Bonus Date': row.bonus_date,
    'Login ID': row.login_id,
    'Login Key': row.login_key,
    'Amount BO': row.amount_bo,
    Remark: row.remark,
    Status: row.status,
    Reason: row.reason,
    'Batch Code': row.claim_batch_id,
    'Created At': row.created_at
  }));
  return {
    ok: true,
    action: 'hermes_preview_export',
    batch: detail.batch,
    count: rows.length,
    rows,
    tsv: [columns.join('\t'), ...rows.map(row => columns.map(column => tsvEscape(row[column])).join('\t'))].join('\n')
  };
}

async function hermesPreviewRelease(body, authContext) {
  requireSuperadmin(authContext);
  const claimBatchId = String(body.claim_batch_id || body.batch_code || '').trim();
  const operatorName = String(body.operator_name || authContext?.operator?.display_name || authContext?.operator?.username || 'Superadmin').trim();
  if (!claimBatchId) {
    const error = new Error('claim_batch_id atau batch_code wajib diisi.');
    error.statusCode = 400;
    error.code = 'CLAIM_BATCH_ID_REQUIRED';
    throw error;
  }
  const { data: lock, error: lockReadError } = await supabase
    .from('bonus_process_locks')
    .select('id, bonus_date, lock_status, claim_batch_id, claim_owner, operator_name, pending_expires_at, started_at, created_at, updated_at')
    .eq('claim_batch_id', claimBatchId)
    .maybeSingle();
  if (lockReadError) throw lockReadError;
  if (!lock || !isHermesLock(lock)) {
    const error = new Error('Preview Hermes tidak ditemukan.');
    error.statusCode = 404;
    error.code = 'HERMES_PREVIEW_NOT_FOUND';
    throw error;
  }
  const previewStatus = previewStatusFromLock(lock);
  if (!['PREVIEW', 'WAITING_SUPERADMIN_APPROVAL'].includes(previewStatus)) {
    const error = new Error(`Preview tidak bisa release karena status sekarang ${previewStatus}.`);
    error.statusCode = 409;
    error.code = 'PREVIEW_NOT_RELEASABLE';
    throw error;
  }

  const rawRows = await fetchRowsByBatch(claimBatchId);
  const readyRows = rawRows.filter(row => String(row.bonus_status || '').toUpperCase() === 'PENDING');
  if (!readyRows.length) {
    throw errorWithCode('NO_READY_ITEMS', 'Tidak ada item READY untuk dikirim ke worker.', 400, {
      debug: {
        claim_batch_id: claimBatchId,
        preview_status: previewStatus,
        row_status_counts: countBy(rawRows, 'bonus_status')
      }
    });
  }

  const now = new Date().toISOString();
  const taskPayload = {
    type: 'RUN_AUTO_REVIEW',
    source: 'parser-superadmin-release',
    batch_code: claimBatchId,
    claim_batch_id: claimBatchId,
    bonus_date: lock.bonus_date,
    mode: 'BONUS_HARIAN',
    items: readyRows.map(rowToHermesTaskItem),
    meta: {
      released_by: operatorName,
      released_role: authContext?.role || body.role || '',
      released_at: now
    }
  };
  const taskResult = await createHermesTaskQueue(taskPayload);
  const updatedLock = await updateHermesReleasedLock(claimBatchId, operatorName, taskResult, now);
  return {
    ok: true,
    action: 'hermes_preview_release',
    status: 'RELEASED_TO_WORKER',
    batch_code: claimBatchId,
    claim_batch_id: claimBatchId,
    task_id: taskResult.task_id,
    task_response: taskResult.response,
    lock: updatedLock,
    task_payload: {
      type: 'RUN_AUTO_REVIEW',
      source: 'parser-superadmin-release',
      mode: 'BONUS_HARIAN',
      batch_code: claimBatchId,
      claim_batch_id: claimBatchId,
      bonus_date: lock.bonus_date,
      items: taskPayload.items,
      meta: taskPayload.meta
    },
    message: 'Task berhasil dikirim ke Hermes. Local Worker akan memproses saat aktif.'
  };
}

async function hermesPreviewCancel(body, authContext) {
  requireSuperadmin(authContext);
  const claimBatchId = String(body.claim_batch_id || body.batch_code || '').trim();
  if (!claimBatchId) {
    const error = new Error('claim_batch_id atau batch_code wajib diisi.');
    error.statusCode = 400;
    error.code = 'CLAIM_BATCH_ID_REQUIRED';
    throw error;
  }
  const { data: lock, error: lockReadError } = await supabase
    .from('bonus_process_locks')
    .select('id, lock_status, claim_batch_id, claim_owner, operator_name')
    .eq('claim_batch_id', claimBatchId)
    .maybeSingle();
  if (lockReadError) throw lockReadError;
  if (!lock || !isHermesLock(lock)) {
    const error = new Error('Preview Hermes tidak ditemukan.');
    error.statusCode = 404;
    error.code = 'HERMES_PREVIEW_NOT_FOUND';
    throw error;
  }
  const now = new Date().toISOString();
  const { data: rows, error: rowError } = await supabase
    .from('bonus_done_daily')
    .update({ bonus_status: 'EXPIRED', updated_at: now })
    .eq('claim_batch_id', claimBatchId)
    .eq('bonus_status', 'PENDING')
    .select('id');
  if (rowError) throw rowError;
  const { data: updatedLock, error: lockError } = await supabase
    .from('bonus_process_locks')
    .update({ lock_status: 'EXPIRED', updated_at: now })
    .eq('claim_batch_id', claimBatchId)
    .select('id, bonus_date, lock_status, claim_batch_id, updated_at')
    .maybeSingle();
  if (lockError) throw lockError;
  return {
    ok: true,
    action: 'hermes_preview_cancel',
    status: 'CANCELLED',
    batch_code: claimBatchId,
    claim_batch_id: claimBatchId,
    cancelled_rows: rows?.length || 0,
    lock: updatedLock
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
    if (action === 'hermes_preview_list') return json(res, 200, await hermesPreviewList(body));
    if (action === 'hermes_preview_detail') return json(res, 200, await hermesPreviewDetail(body));
    if (action === 'hermes_preview_export') return json(res, 200, await hermesPreviewExport(body));
    if (action === 'hermes_preview_release') return json(res, 200, await hermesPreviewRelease(body, authContext));
    if (action === 'hermes_preview_cancel') return json(res, 200, await hermesPreviewCancel(body, authContext));

    return json(res, 400, { ok: false, error: 'UNKNOWN_ACTION', message: 'Action tidak dikenal.' });
  } catch (error) {
    console.error('bonus-control error:', error);
    return json(res, error.statusCode || 500, {
      ok: false,
      error: error.code || 'BONUS_CONTROL_FAILED',
      message: error.message || 'Bonus control gagal.',
      debug: error.debug || null
    });
  }
}
