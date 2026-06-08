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

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeLoginId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

async function getOperatorFromRequest(req, required = false) {
  if (!sessionSecret) {
    if (required) {
      const error = new Error('OPERATOR_SESSION_SECRET belum diset.');
      error.statusCode = 500;
      throw error;
    }
    return null;
  }

  const token = bearerToken(req);
  if (!token) {
    if (!required) return null;
    const error = new Error('Session operator tidak valid.');
    error.statusCode = 401;
    throw error;
  }

  let payload;
  try {
    payload = jwt.verify(token, sessionSecret);
  } catch (error) {
    if (!required) return null;
    const authError = new Error('Session operator tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  const { data: operator, error } = await supabase
    .from('operators')
    .select('id, username, display_name, role, is_active, is_protected')
    .eq('id', payload.operator_id)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  if (!operator) {
    if (!required) return null;
    const authError = new Error('Session operator tidak valid.');
    authError.statusCode = 401;
    throw authError;
  }

  return operator;
}

function claimOwnerFromOperator(operator, fallback) {
  return operator ? `OPERATOR-${operator.id}` : normalizeText(fallback);
}

function operatorNameFromOperator(operator, fallback) {
  return operator ? normalizeText(operator.display_name || operator.username) : normalizeText(fallback);
}

function isAdminOperator(operator) {
  return operator && ['admin', 'superadmin'].includes(operator.role);
}

async function getAdminOperatorFromRequest(req) {
  const operator = await getOperatorFromRequest(req, true);
  if (!isAdminOperator(operator)) {
    const error = new Error('Akses admin dibatasi.');
    error.statusCode = 403;
    throw error;
  }
  return operator;
}

function dedupeRows(rows, date, now, pendingExpiresAt, expiresAt, claimOwner, claimBatchId, operatorName) {
  const map = new Map();

  (rows || []).forEach(row => {
    const loginId = normalizeLoginId(row.login_id || row.loginId);
    if (!loginId) return;

    const item = {
      bonus_date: date,
      login_id: loginId,
      login_key: loginId,
      bonus_type: 'BONUS_HARIAN',
      bonus_amount: Number.isFinite(Number(row.bonus_amount ?? row.bonus)) ? Number(row.bonus_amount ?? row.bonus) : null,
      remark: normalizeText(row.remark),
      source: normalizeText(row.source || 'process_claim') || 'process_claim',
      operator_name: operatorName || normalizeText(row.operator_name),
      bonus_status: 'PENDING',
      claim_owner: claimOwner,
      claim_batch_id: claimBatchId,
      claimed_at: now,
      updated_at: now,
      pending_expires_at: pendingExpiresAt,
      expires_at: expiresAt
    };

    map.set(`${item.bonus_date}|${item.login_key}|${item.bonus_type}`, item);
  });

  return [...map.values()];
}

function dedupeAdjustmentApprovedRows(rows, now, expiresAt, operatorName, fallbackDate = '') {
  const map = new Map();

  (rows || []).forEach(row => {
    const loginId = normalizeLoginId(row.login_id || row.login_key || row.loginId);
    const bonusDate = String(row.bonus_date || fallbackDate || '').trim();
    if (!loginId) return;
    if (!isValidDate(bonusDate)) return;

    const item = {
      bonus_date: bonusDate,
      login_id: loginId,
      login_key: loginId,
      bonus_type: 'BONUS_HARIAN',
      bonus_amount: Number.isFinite(Number(row.bonus_amount ?? row.bonus)) ? Number(row.bonus_amount ?? row.bonus) : null,
      remark: normalizeText(row.remark),
      source: 'adjustment_approved',
      operator_name: operatorName,
      bonus_status: 'DONE',
      done_at: now,
      done_by_name: operatorName,
      updated_at: now,
      expires_at: expiresAt
    };

    map.set(`${item.bonus_date}|${item.login_key}|${item.bonus_type}`, item);
  });

  return [...map.values()];
}

function loginIdsFromRows(rows) {
  return [...new Set((rows || []).map(row => normalizeLoginId(row.login_key || row.login_id)).filter(Boolean))];
}

function decorateBatch(lock, rows, serverTime) {
  const batchRows = rows || [];
  const nowMs = new Date(serverTime).getTime();
  const pendingExpiresMs = lock && lock.pending_expires_at ? new Date(lock.pending_expires_at).getTime() : 0;
  const isExpired = lock && lock.lock_status === 'PENDING' && (!pendingExpiresMs || pendingExpiresMs <= nowMs);
  const displayStatus = isExpired ? 'EXPIRED' : (lock.lock_status || '-');
  const totalBonus = batchRows.reduce((sum, row) => sum + (Number(row.bonus_amount) || 0), 0);

  return {
    ...lock,
    display_status: displayStatus,
    row_count: batchRows.length,
    total_bonus: totalBonus,
    pending_remaining_ms: lock && lock.lock_status === 'PENDING' && pendingExpiresMs
      ? Math.max(0, pendingExpiresMs - nowMs)
      : 0
  };
}

async function safeUpdateBonusRowsMetadata(match, values) {
  const { error } = await supabase
    .from('bonus_done_daily')
    .update(values)
    .match(match);

  if (error && error.code !== '42703') throw error;
}

async function safeUpdateLockMetadata(lockId, values) {
  const { error } = await supabase
    .from('bonus_process_locks')
    .update(values)
    .eq('id', lockId);

  if (error && error.code !== '42703') throw error;
}

async function safeInsertAdminAction(payload) {
  const { error } = await supabase
    .from('bonus_admin_actions')
    .insert(payload);

  if (error && !['42P01', '42703'].includes(error.code)) throw error;
}

async function deleteExpiredRows() {
  const now = new Date().toISOString();
  await supabase.from('bonus_done_daily').delete().lt('expires_at', now);
  await supabase.from('bonus_process_locks').delete().lt('expires_at', now);
}

async function expireOldBonusPending() {
  const { data, error } = await supabase.rpc('expire_old_bonus_pending');
  if (!error) {
    return {
      expired_bonus_rows: Number(data?.expired_bonus_rows || 0),
      expired_lock_rows: Number(data?.expired_lock_rows || 0)
    };
  }

  const now = new Date().toISOString();
  const { data: bonusRows, error: bonusFetchError } = await supabase
    .from('bonus_done_daily')
    .select('id')
    .eq('bonus_status', 'PENDING')
    .lt('pending_expires_at', now);
  if (bonusFetchError) throw bonusFetchError;

  const { error: bonusUpdateError } = await supabase
    .from('bonus_done_daily')
    .update({
      bonus_status: 'EXPIRED',
      updated_at: now,
      finalized_note: 'Auto expired karena pending_expires_at sudah lewat'
    })
    .eq('bonus_status', 'PENDING')
    .lt('pending_expires_at', now);
  if (bonusUpdateError && bonusUpdateError.code === '42703') {
    const retry = await supabase
      .from('bonus_done_daily')
      .update({
        bonus_status: 'EXPIRED',
        updated_at: now
      })
      .eq('bonus_status', 'PENDING')
      .lt('pending_expires_at', now);
    if (retry.error) throw retry.error;
  } else if (bonusUpdateError) {
    throw bonusUpdateError;
  }

  const { data: lockRows, error: lockFetchError } = await supabase
    .from('bonus_process_locks')
    .select('id')
    .eq('lock_status', 'PENDING')
    .lt('pending_expires_at', now);
  if (lockFetchError) throw lockFetchError;

  const { error: lockUpdateError } = await supabase
    .from('bonus_process_locks')
    .update({
      lock_status: 'EXPIRED',
      updated_at: now,
      finalized_note: 'Auto expired karena pending_expires_at sudah lewat'
    })
    .eq('lock_status', 'PENDING')
    .lt('pending_expires_at', now);
  if (lockUpdateError && lockUpdateError.code === '42703') {
    const retry = await supabase
      .from('bonus_process_locks')
      .update({
        lock_status: 'EXPIRED',
        updated_at: now
      })
      .eq('lock_status', 'PENDING')
      .lt('pending_expires_at', now);
    if (retry.error) throw retry.error;
  } else if (lockUpdateError) {
    throw lockUpdateError;
  }

  return {
    expired_bonus_rows: bonusRows?.length || 0,
    expired_lock_rows: lockRows?.length || 0
  };
}

async function fetchPendingLock(date) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('bonus_process_locks')
    .select('*')
    .eq('bonus_date', date)
    .eq('lock_status', 'PENDING')
    .gte('pending_expires_at', now)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchPendingRows(date, claimOwner) {
  const { data, error } = await supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, operator_name, bonus_status, claim_owner, claim_batch_id, claimed_at, pending_expires_at, created_at')
    .eq('bonus_date', date)
    .eq('bonus_type', 'BONUS_HARIAN')
    .eq('bonus_status', 'PENDING')
    .eq('claim_owner', claimOwner)
    .order('claimed_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function extendOwnPending(date, claimOwner, pendingExpiresAt, now) {
  const { error: lockError } = await supabase
    .from('bonus_process_locks')
    .update({
      pending_expires_at: pendingExpiresAt,
      updated_at: now
    })
    .eq('bonus_date', date)
    .eq('claim_owner', claimOwner)
    .eq('lock_status', 'PENDING');

  if (lockError) throw lockError;

  const { error: rowError } = await supabase
    .from('bonus_done_daily')
    .update({
      pending_expires_at: pendingExpiresAt,
      updated_at: now
    })
    .eq('bonus_date', date)
    .eq('claim_owner', claimOwner)
    .eq('bonus_status', 'PENDING')
    .eq('bonus_type', 'BONUS_HARIAN');

  if (rowError) throw rowError;
}

async function closeEmptyPendingLock(lock, now) {
  if (!lock || !lock.id) return;

  const { error } = await supabase
    .from('bonus_process_locks')
    .update({
      lock_status: 'EMPTY',
      done_at: now,
      updated_at: now
    })
    .eq('id', lock.id)
    .eq('lock_status', 'PENDING');

  if (error) throw error;
}

async function filterInsertableRows(payload) {
  if (payload.length === 0) return [];

  const date = payload[0].bonus_date;
  const loginKeys = [...new Set(payload.map(row => row.login_key).filter(Boolean))];

  const { data: existingRows, error: existingError } = await supabase
    .from('bonus_done_daily')
    .select('login_key, bonus_status, pending_expires_at')
    .eq('bonus_date', date)
    .eq('bonus_type', 'BONUS_HARIAN')
    .in('bonus_status', ['DONE', 'PENDING'])
    .in('login_key', loginKeys);

  if (existingError) throw existingError;

  const nowMs = Date.now();
  const existingKeys = new Set((existingRows || [])
    .filter(row => {
      const status = String(row.bonus_status || '').toUpperCase();
      if (status === 'DONE') return true;
      if (status !== 'PENDING') return false;
      const pendingMs = row.pending_expires_at ? new Date(row.pending_expires_at).getTime() : 0;
      return pendingMs >= nowMs;
    })
    .map(row => normalizeLoginId(row.login_key)));
  return payload.filter(row => !existingKeys.has(row.login_key));
}

async function insertPendingRows(payload) {
  if (payload.length === 0) return [];

  const insertRows = await filterInsertableRows(payload);
  if (insertRows.length === 0) return [];

  const { data, error } = await supabase
    .from('bonus_done_daily')
    .insert(insertRows)
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, operator_name, bonus_status, claim_owner, claim_batch_id, claimed_at, pending_expires_at, created_at');

  if (error) {
    if (error.code === '23505') return [];
    throw error;
  }

  return data || [];
}

async function reviveEmptyPendingLock(lockId, date, claimOwner, claimBatchId, operatorName, now, pendingExpiresAt, expiresAt) {
  if (!lockId) return null;

  const { data, error } = await supabase
    .from('bonus_process_locks')
    .update({
      bonus_date: date,
      lock_status: 'PENDING',
      claim_owner: claimOwner,
      claim_batch_id: claimBatchId,
      operator_name: operatorName,
      started_at: now,
      updated_at: now,
      pending_expires_at: pendingExpiresAt,
      expires_at: expiresAt,
      done_at: null
    })
    .eq('id', lockId)
    .eq('lock_status', 'EMPTY')
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createPendingBatch(date, rows, payload, claimOwner, claimBatchId, operatorName, now, pendingExpiresAt, expiresAt, emptyPendingCleared = false, reusableLockId = null) {
  const insertablePayload = await filterInsertableRows(payload);

  if (insertablePayload.length === 0) {
    return {
      success: true,
      status: payload.length > 0 ? 'all_already_done' : 'no_candidates',
      emptyPendingCleared,
      received: rows.length,
      unique: payload.length,
      claimed: 0,
      skipped: payload.length,
      rows: [],
      loginIds: [],
      lock: null,
      serverTime: now,
      message: payload.length > 0
        ? 'Semua kandidat sudah pernah ditandai selesai bonus.'
        : 'Tidak ada kandidat bonus baru untuk diproses.'
    };
  }

  const { error: lockError } = await supabase
    .from('bonus_process_locks')
    .insert({
      bonus_date: date,
      lock_status: 'PENDING',
      claim_owner: claimOwner,
      claim_batch_id: claimBatchId,
      operator_name: operatorName,
      started_at: now,
      updated_at: now,
      pending_expires_at: pendingExpiresAt,
      expires_at: expiresAt
    });

  if (lockError) {
    if (lockError.code !== '23505') throw lockError;

    const existingPending = await fetchPendingLock(date);
    if (existingPending) return null;

    if (emptyPendingCleared && reusableLockId) {
      const revivedLock = await reviveEmptyPendingLock(reusableLockId, date, claimOwner, claimBatchId, operatorName, now, pendingExpiresAt, expiresAt);
      if (!revivedLock) return null;

      const insertedRows = await insertPendingRows(insertablePayload);
      return {
        success: true,
        status: 'claimed',
        emptyPendingCleared,
        received: rows.length,
        unique: payload.length,
        claimed: insertedRows.length,
        skipped: payload.length - insertedRows.length,
        rows: insertedRows,
        loginIds: loginIdsFromRows(insertedRows),
        lock: revivedLock,
        serverTime: now,
        message: 'Pending kosong sebelumnya dibersihkan, batch baru dibuat.'
      };
    }

    return null;
  }

  const insertedRows = await insertPendingRows(insertablePayload);
  const lock = await fetchPendingLock(date);

  return {
    success: true,
    status: 'claimed',
    emptyPendingCleared,
    received: rows.length,
    unique: payload.length,
    claimed: insertedRows.length,
    skipped: payload.length - insertedRows.length,
    rows: insertedRows,
    loginIds: loginIdsFromRows(insertedRows),
    lock,
    serverTime: now,
    message: emptyPendingCleared
      ? 'Pending kosong sebelumnya dibersihkan, batch baru dibuat.'
      : 'Batch berhasil dibuat.'
  };
}

async function handleClaimBatch(req, body, res) {
  const operator = await getOperatorFromRequest(req, true);
  const date = String(body.date || '');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const claimOwner = claimOwnerFromOperator(operator, body.claim_owner);
  const claimBatchId = normalizeText(body.claim_batch_id);
  const operatorName = operatorNameFromOperator(operator, body.operator_name);

  if (!isValidDate(date)) {
    return res.status(400).json({ success: false, error: 'Format date harus YYYY-MM-DD.' });
  }

  if (!claimOwner || !claimBatchId) {
    return res.status(400).json({ success: false, error: 'claim_owner dan claim_batch_id wajib diisi.' });
  }

  const expireResult = await expireOldBonusPending();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const pendingExpiresAt = addMinutes(nowDate, 5);
  const expiresAt = addDays(nowDate, 2);
  const payload = dedupeRows(rows, date, now, pendingExpiresAt, expiresAt, claimOwner, claimBatchId, operatorName);

  let lock = await fetchPendingLock(date);
  let emptyPendingCleared = false;
  let reusableEmptyLockId = null;

  if (lock && lock.lock_status === 'PENDING' && lock.claim_owner === claimOwner) {
    const ownRows = await fetchPendingRows(date, claimOwner);

    if (ownRows.length > 0) {
      await extendOwnPending(date, claimOwner, pendingExpiresAt, now);
      const updatedLock = await fetchPendingLock(date);

    return res.status(200).json({
      success: true,
      status: 'own_pending',
      expireResult,
      received: rows.length,
        unique: payload.length,
        claimed: ownRows.length,
        skipped: 0,
        rows: ownRows,
        loginIds: loginIdsFromRows(ownRows),
        lock: updatedLock,
        serverTime: now,
        message: 'Menampilkan ulang pending milik Anda.'
      });
    }

    reusableEmptyLockId = lock.id;
    await closeEmptyPendingLock(lock, now);
    emptyPendingCleared = true;
    lock = null;
  }

  if (lock) {
    const pendingActive = lock.pending_expires_at && new Date(lock.pending_expires_at).getTime() > nowDate.getTime();

    if (lock.lock_status === 'PENDING' && pendingActive) {
      return res.status(200).json({
        success: true,
        status: 'locked_by_other',
        expireResult,
        lockedByOther: true,
        rows: [],
        loginIds: [],
        lock,
        serverTime: now,
        message: 'Bonus Harian tanggal ini sedang diproses operator lain.'
      });
    }

    return res.status(200).json({
      success: true,
      status: 'pending_expired',
      expireResult,
      pendingExpired: true,
      rows: [],
      loginIds: [],
      lock,
      serverTime: now,
      message: 'Ada pending lama yang belum ditandai selesai.'
    });
  }

  const created = await createPendingBatch(date, rows, payload, claimOwner, claimBatchId, operatorName, now, pendingExpiresAt, expiresAt, emptyPendingCleared, reusableEmptyLockId);

  if (created) {
    created.expireResult = expireResult;
    return res.status(200).json(created);
  }

  lock = await fetchPendingLock(date);
  if (!lock) throw new Error('Gagal membaca lock batch bonus.');

  const pendingActive = lock.pending_expires_at && new Date(lock.pending_expires_at).getTime() > nowDate.getTime();
  return res.status(200).json({
    success: true,
    status: pendingActive ? 'locked_by_other' : 'pending_expired',
    expireResult,
    lockedByOther: pendingActive,
    pendingExpired: !pendingActive,
    rows: [],
    loginIds: [],
    lock,
    serverTime: now,
    message: pendingActive
      ? 'Bonus Harian tanggal ini sedang diproses operator lain.'
      : 'Ada pending lama yang belum ditandai selesai.'
  });
}

async function handleDone(req, body, res) {
  const operator = await getOperatorFromRequest(req, true);
  const date = String(body.date || '');
  const claimOwner = claimOwnerFromOperator(operator, body.claim_owner);
  const operatorName = operatorNameFromOperator(operator, body.operator_name);

  if (!isValidDate(date)) {
    return res.status(400).json({ success: false, error: 'Format date harus YYYY-MM-DD.' });
  }

  if (!claimOwner) {
    return res.status(400).json({ success: false, error: 'claim_owner wajib diisi.' });
  }

  const now = new Date().toISOString();
  const lock = await fetchPendingLock(date);

  if (!lock || lock.lock_status !== 'PENDING' || lock.claim_owner !== claimOwner) {
    return res.status(409).json({
      success: false,
      status: 'not_owner',
      message: 'Anda bukan pemegang pending batch tanggal ini.'
    });
  }

  const { error: lockError } = await supabase
    .from('bonus_process_locks')
    .update({
      lock_status: 'DONE',
      done_at: now,
      updated_at: now,
      done_by_name: operatorName
    })
    .eq('bonus_date', date)
    .eq('claim_owner', claimOwner)
    .eq('lock_status', 'PENDING');

  if (lockError) throw lockError;

  const { data, error: rowError } = await supabase
    .from('bonus_done_daily')
    .update({
      bonus_status: 'DONE',
      done_at: now,
      updated_at: now,
      done_by_name: operatorName
    })
    .eq('bonus_date', date)
    .eq('claim_owner', claimOwner)
    .eq('bonus_status', 'PENDING')
    .eq('bonus_type', 'BONUS_HARIAN')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, operator_name, bonus_status, claim_owner, claim_batch_id, done_at, done_by_name');

  if (rowError) throw rowError;

  const doneRows = data || [];

  return res.status(200).json({
    success: true,
    status: 'done',
    doneCount: doneRows.length,
    loginIds: loginIdsFromRows(doneRows),
    rows: doneRows,
    message: 'Bonus Harian berhasil ditandai selesai.'
  });
}

async function handleSyncAdjustmentApproved(req, body, res) {
  const operator = await getOperatorFromRequest(req, true);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const fallbackDate = String(body.date || '');

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = addDays(nowDate, 2);
  const operatorName = operatorNameFromOperator(operator, body.operator_name);
  const payload = dedupeAdjustmentApprovedRows(rows, now, expiresAt, operatorName, fallbackDate);

  if (payload.length === 0) {
    return res.status(200).json({
      success: true,
      status: 'no_adjustment_approved',
      syncedCount: 0,
      loginIds: [],
      dates: [],
      serverTime: now
    });
  }

  const { data, error } = await supabase
    .from('bonus_done_daily')
    .upsert(payload, {
      onConflict: 'bonus_date,login_key,bonus_type',
      ignoreDuplicates: false
    })
    .select('login_key');

  if (error) throw error;

  const loginIds = loginIdsFromRows(data && data.length ? data : payload);
  const dates = [...new Set(payload.map(row => row.bonus_date).filter(Boolean))].sort();

  return res.status(200).json({
    success: true,
    status: 'synced_adjustment_approved',
    syncedCount: payload.length,
    loginIds,
    dates,
    serverTime: now
  });
}

async function handleAdminListBonusBatches(req, body, res) {
  const shouldPerfLog = process.env.NODE_ENV !== 'production';
  if (shouldPerfLog) console.time('admin_list_bonus_batches');
  await getAdminOperatorFromRequest(req);

  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 150);
  const page = Math.max(Number(body.page) || 1, 1);
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const date = String(body.date || '').trim();
  const operatorInput = normalizeText(body.operator || '');
  const operatorFilter = operatorInput.toUpperCase();
  const statusFilter = normalizeText(body.status || '').toUpperCase();
  const serverTime = new Date().toISOString();

  let query = supabase
    .from('bonus_process_locks')
    .select('id, bonus_date, claim_owner, claim_batch_id, operator_name, lock_status, started_at, created_at, updated_at, pending_expires_at, done_at, done_by_name', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(from, to);

  if (date && isValidDate(date)) query = query.eq('bonus_date', date);
  if (operatorInput) query = query.or(`operator_name.ilike.%${operatorInput}%,claim_owner.ilike.%${operatorInput}%`);
  if (statusFilter === 'EXPIRED') query = query.eq('lock_status', 'PENDING');
  if (statusFilter && !['EXPIRED', 'ALL'].includes(statusFilter)) query = query.eq('lock_status', statusFilter);

  const { data: locks, error: lockError, count } = await query;
  if (lockError) throw lockError;

  const lockRows = locks || [];
  if (lockRows.length === 0) {
    if (shouldPerfLog) console.timeEnd('admin_list_bonus_batches');
    return res.status(200).json({
      success: true,
      status: 'admin_batches',
      batches: [],
      page,
      limit,
      hasMore: false,
      serverTime
    });
  }

  const dates = [...new Set(lockRows.map(lock => lock.bonus_date).filter(Boolean))];
  const owners = [...new Set(lockRows.map(lock => lock.claim_owner).filter(Boolean))];

  const { data: rows, error: rowError } = await supabase
    .from('bonus_done_daily')
    .select('bonus_date, bonus_type, bonus_amount, claim_owner, claim_batch_id')
    .in('bonus_date', dates)
    .in('claim_owner', owners)
    .eq('bonus_type', 'BONUS_HARIAN');

  if (rowError) throw rowError;

  const rowMap = new Map();
  (rows || []).forEach(row => {
    const key = `${row.bonus_date}|${row.claim_owner}|${row.claim_batch_id || ''}`;
    if (!rowMap.has(key)) rowMap.set(key, []);
    rowMap.get(key).push(row);
  });

  let batches = lockRows.map(lock => {
    const key = `${lock.bonus_date}|${lock.claim_owner}|${lock.claim_batch_id || ''}`;
    return decorateBatch(lock, rowMap.get(key) || [], serverTime);
  });

  if (operatorFilter) {
    batches = batches.filter(batch => {
      const name = normalizeText(batch.operator_name || '').toUpperCase();
      const owner = normalizeText(batch.claim_owner || '').toUpperCase();
      return name.includes(operatorFilter) || owner.includes(operatorFilter);
    });
  }

  if (statusFilter === 'EXPIRED') {
    batches = batches.filter(batch => batch.display_status === 'EXPIRED');
  } else if (statusFilter && statusFilter !== 'ALL') {
    batches = batches.filter(batch => batch.display_status === statusFilter);
  }

  if (shouldPerfLog) console.timeEnd('admin_list_bonus_batches');
  return res.status(200).json({
    success: true,
    status: 'admin_batches',
    batches,
    page,
    limit,
    hasMore: to + 1 < (count || 0),
    serverTime
  });
}

async function fetchLockById(lockId) {
  const { data, error } = await supabase
    .from('bonus_process_locks')
    .select('*')
    .eq('id', lockId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchRowsForLock(lock) {
  if (!lock) return [];

  let query = supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, operator_name, bonus_status, claim_owner, claim_batch_id, claimed_at, done_at, pending_expires_at, created_at, updated_at')
    .eq('bonus_date', lock.bonus_date)
    .eq('claim_owner', lock.claim_owner)
    .eq('bonus_type', 'BONUS_HARIAN')
    .order('created_at', { ascending: true });

  if (lock.claim_batch_id) query = query.eq('claim_batch_id', lock.claim_batch_id);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function handleAdminGetBonusBatchDetail(req, body, res) {
  await getAdminOperatorFromRequest(req);
  const lockId = Number(body.lock_id || body.id);
  if (!Number.isFinite(lockId) || lockId <= 0) {
    return res.status(400).json({ success: false, error: 'lock_id wajib diisi.' });
  }

  const serverTime = new Date().toISOString();
  const lock = await fetchLockById(lockId);
  if (!lock) {
    return res.status(404).json({ success: false, error: 'Batch tidak ditemukan.' });
  }

  const rows = await fetchRowsForLock(lock);

  return res.status(200).json({
    success: true,
    status: 'admin_batch_detail',
    batch: decorateBatch(lock, rows, serverTime),
    rows,
    serverTime
  });
}

async function handleAdminFinalizePendingBatch(req, body, res) {
  const admin = await getAdminOperatorFromRequest(req);
  const lockId = Number(body.lock_id || body.id);
  const note = normalizeText(body.note || '');

  if (!Number.isFinite(lockId) || lockId <= 0) {
    return res.status(400).json({ success: false, error: 'lock_id wajib diisi.' });
  }

  const lock = await fetchLockById(lockId);
  if (!lock) {
    return res.status(404).json({ success: false, error: 'Batch tidak ditemukan.' });
  }

  if (lock.lock_status !== 'PENDING') {
    return res.status(409).json({
      success: false,
      status: 'not_pending',
      message: 'Batch ini sudah tidak berstatus PENDING.'
    });
  }

  const now = new Date().toISOString();
  const adminId = String(admin.id);
  const adminName = operatorNameFromOperator(admin);

  const { data: updatedRows, error: rowError } = await supabase
    .from('bonus_done_daily')
    .update({
      bonus_status: 'DONE',
      done_at: now,
      updated_at: now,
      done_by_name: adminName
    })
    .eq('bonus_date', lock.bonus_date)
    .eq('claim_owner', lock.claim_owner)
    .eq('claim_batch_id', lock.claim_batch_id)
    .eq('bonus_status', 'PENDING')
    .eq('bonus_type', 'BONUS_HARIAN')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, operator_name, bonus_status, claim_owner, claim_batch_id, done_at, done_by_name');

  if (rowError) throw rowError;

  const doneRows = updatedRows || [];

  const { data: updatedLock, error: lockError } = await supabase
    .from('bonus_process_locks')
    .update({
      lock_status: 'DONE',
      done_at: now,
      updated_at: now,
      done_by_name: adminName
    })
    .eq('id', lock.id)
    .eq('lock_status', 'PENDING')
    .select('*')
    .maybeSingle();

  if (lockError) throw lockError;

  const metadata = {
    finalized_by_admin_id: adminId,
    finalized_by_admin_name: adminName,
    finalized_at: now,
    finalized_note: note
  };

  await safeUpdateLockMetadata(lock.id, metadata);
  await safeUpdateBonusRowsMetadata({
    bonus_date: lock.bonus_date,
    claim_owner: lock.claim_owner,
    claim_batch_id: lock.claim_batch_id,
    bonus_type: 'BONUS_HARIAN'
  }, metadata);
  await safeInsertAdminAction({
    action_type: 'admin_finalize_pending_batch',
    bonus_date: lock.bonus_date,
    claim_owner: lock.claim_owner,
    operator_name: lock.operator_name || '',
    admin_id: adminId,
    admin_name: adminName,
    affected_rows: doneRows.length,
    note
  });

  return res.status(200).json({
    success: true,
    status: 'admin_finalized',
    doneCount: doneRows.length,
    loginIds: loginIdsFromRows(doneRows),
    rows: doneRows,
    lock: updatedLock || { ...lock, lock_status: 'DONE', done_at: now, done_by_name: adminName },
    serverTime: now,
    message: 'Batch berhasil ditandai selesai oleh admin.'
  });
}

function claimCopyRows(rows) {
  return (rows || []).filter(row => {
    const amount = Number(row.bonus_amount);
    const bonusType = normalizeText(row.bonus_type || 'BONUS_HARIAN').toUpperCase();
    const loginId = normalizeLoginId(row.login_key || row.login_id);
    return loginId
      && bonusType === 'BONUS_HARIAN'
      && amount > 0
      && [5, 10].includes(amount);
  });
}

async function handleAdminLogOperatorClaimCopy(req, body, res) {
  const admin = await getAdminOperatorFromRequest(req);
  const lockId = Number(body.lock_id || body.id);

  if (!Number.isFinite(lockId) || lockId <= 0) {
    return res.status(400).json({ success: false, error: 'lock_id wajib diisi.' });
  }

  const lock = await fetchLockById(lockId);
  if (!lock) {
    return res.status(404).json({ success: false, error: 'Batch tidak ditemukan.' });
  }

  const rows = await fetchRowsForLock(lock);
  const copyRows = claimCopyRows(rows);
  const adminName = operatorNameFromOperator(admin);

  await safeInsertAdminAction({
    action_type: 'ADMIN_COPY_OPERATOR_CLAIM_TEXT',
    bonus_date: lock.bonus_date,
    claim_owner: lock.claim_owner,
    operator_name: lock.operator_name || '',
    admin_id: String(admin.id),
    admin_name: adminName,
    affected_rows: copyRows.length,
    note: 'Admin menyalin ID dan bonus claim operator untuk backup'
  });

  return res.status(200).json({
    success: true,
    status: 'admin_claim_copy_logged',
    affectedRows: copyRows.length,
    serverTime: new Date().toISOString()
  });
}

async function handleGet(req, res) {
  const operator = await getOperatorFromRequest(req, false);
  const date = String(req.query.date || '');
  const claimOwner = operator ? claimOwnerFromOperator(operator) : normalizeText(req.query.claim_owner);

  if (!isValidDate(date)) {
    return res.status(400).json({
      success: false,
      error: 'Format date harus YYYY-MM-DD.'
    });
  }

  await expireOldBonusPending();
  await deleteExpiredRows();

  const lock = await fetchPendingLock(date);
  const now = Date.now();

  const { data: rows, error } = await supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, operator_name, bonus_status, claim_owner, claim_batch_id, claimed_at, done_at, pending_expires_at, created_at')
    .eq('bonus_date', date)
    .eq('bonus_type', 'BONUS_HARIAN')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true });

  if (error) throw error;

  const doneRows = (rows || []).filter(row => row.bonus_status === 'DONE');
  const ownPendingRows = claimOwner
    ? (rows || []).filter(row => row.bonus_status === 'PENDING' && row.claim_owner === claimOwner)
    : [];
  const isPending = lock && lock.lock_status === 'PENDING';
  const isOwnLock = isPending && claimOwner && lock.claim_owner === claimOwner;
  const isLockedByOther = Boolean(isPending && !isOwnLock && lock.pending_expires_at && new Date(lock.pending_expires_at).getTime() > now);
  const isPendingExpired = Boolean(isPending && !isOwnLock && (!lock.pending_expires_at || new Date(lock.pending_expires_at).getTime() <= now));

  return res.status(200).json({
    success: true,
    date,
    lock: lock || null,
    doneLoginIds: loginIdsFromRows(doneRows),
    ownPendingLoginIds: loginIdsFromRows(ownPendingRows),
    loginIds: loginIdsFromRows(doneRows),
    isLockedByOther,
    isPendingExpired,
    statusSummary: {
      done: doneRows.length,
      own_pending: ownPendingRows.length,
      pending_active: (rows || []).filter(row => row.bonus_status === 'PENDING' && row.pending_expires_at && new Date(row.pending_expires_at).getTime() >= now).length,
      expired: (rows || []).filter(row => row.bonus_status === 'EXPIRED' || (row.bonus_status === 'PENDING' && (!row.pending_expires_at || new Date(row.pending_expires_at).getTime() < now))).length
    },
    rows: doneRows
  });
}

export default async function handler(req, res) {
  try {
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Konfigurasi database pusat belum lengkap.'
      });
    }

    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      const action = String(body.action || '').trim();

      if (action === 'claim_batch') return await handleClaimBatch(req, body, res);
      if (action === 'done') return await handleDone(req, body, res);
      if (action === 'sync_adjustment_approved') return await handleSyncAdjustmentApproved(req, body, res);
      if (action === 'admin_list_bonus_batches') return await handleAdminListBonusBatches(req, body, res);
      if (action === 'admin_get_bonus_batch_detail') return await handleAdminGetBonusBatchDetail(req, body, res);
      if (action === 'admin_finalize_pending_batch') return await handleAdminFinalizePendingBatch(req, body, res);
      if (action === 'admin_log_operator_claim_copy') return await handleAdminLogOperatorClaimCopy(req, body, res);

      return res.status(400).json({
        success: false,
        error: 'Action tidak dikenal.'
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({
      success: false,
      error: 'Method not allowed.'
    });
  } catch (error) {
    console.error('bonus-done error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Server error.',
      details: error
    });
  }
}
