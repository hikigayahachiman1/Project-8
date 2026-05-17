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

function normalizeText(value) {
  return String(value || '').trim();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function dedupeRows(rows, date, now, pendingExpiresAt, expiresAt, claimOwner, claimBatchId) {
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
      operator_name: normalizeText(row.operator_name),
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

function loginIdsFromRows(rows) {
  return [...new Set((rows || []).map(row => normalizeLoginId(row.login_key || row.login_id)).filter(Boolean))];
}

async function deleteExpiredRows() {
  const now = new Date().toISOString();
  await supabase.from('bonus_done_daily').delete().lt('expires_at', now);
  await supabase.from('bonus_process_locks').delete().lt('expires_at', now);
}

async function fetchDateLock(date) {
  const { data, error } = await supabase
    .from('bonus_process_locks')
    .select('*')
    .eq('bonus_date', date)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchPendingRows(date, claimOwner) {
  const { data, error } = await supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, bonus_status, claim_owner, claim_batch_id, claimed_at, pending_expires_at, created_at')
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

async function insertPendingRows(payload) {
  if (payload.length === 0) return [];

  const { data, error } = await supabase
    .rpc('claim_bonus_done_daily', { items: payload });

  if (error) {
    if (error.code === '23505') return [];
    throw error;
  }

  return data || [];
}

async function handleClaimBatch(body, res) {
  const date = String(body.date || '');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const claimOwner = normalizeText(body.claim_owner);
  const claimBatchId = normalizeText(body.claim_batch_id);

  if (!isValidDate(date)) {
    return res.status(400).json({ success: false, error: 'Format date harus YYYY-MM-DD.' });
  }

  if (!claimOwner || !claimBatchId) {
    return res.status(400).json({ success: false, error: 'claim_owner dan claim_batch_id wajib diisi.' });
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const pendingExpiresAt = addMinutes(nowDate, 5);
  const expiresAt = addDays(nowDate, 2);
  const payload = dedupeRows(rows, date, now, pendingExpiresAt, expiresAt, claimOwner, claimBatchId);

  let lock = await fetchDateLock(date);

  if (!lock) {
    const { error: lockError } = await supabase
      .from('bonus_process_locks')
      .insert({
        bonus_date: date,
        lock_status: 'PENDING',
        claim_owner: claimOwner,
        claim_batch_id: claimBatchId,
        started_at: now,
        updated_at: now,
        pending_expires_at: pendingExpiresAt,
        expires_at: expiresAt
      });

    if (lockError) {
      if (lockError.code !== '23505') throw lockError;
      lock = await fetchDateLock(date);
    } else {
      const insertedRows = await insertPendingRows(payload);
      return res.status(200).json({
        success: true,
        status: 'claimed',
        received: rows.length,
        unique: payload.length,
        claimed: insertedRows.length,
        skipped: payload.length - insertedRows.length,
        rows: insertedRows,
        loginIds: loginIdsFromRows(insertedRows),
        message: 'Batch berhasil dibuat.'
      });
    }
  }

  if (!lock) {
    throw new Error('Gagal membaca lock batch bonus.');
  }

  if (lock.lock_status === 'DONE') {
    return res.status(200).json({
      success: true,
      status: 'already_done',
      rows: [],
      loginIds: [],
      message: 'Bonus Harian tanggal ini sudah ditandai selesai.'
    });
  }

  if (lock.lock_status === 'PENDING' && lock.claim_owner === claimOwner) {
    await extendOwnPending(date, claimOwner, pendingExpiresAt, now);
    const ownRows = await fetchPendingRows(date, claimOwner);

    return res.status(200).json({
      success: true,
      status: 'own_pending',
      received: rows.length,
      unique: payload.length,
      claimed: ownRows.length,
      skipped: 0,
      rows: ownRows,
      loginIds: loginIdsFromRows(ownRows),
      message: 'Menampilkan ulang pending milik Anda.'
    });
  }

  const pendingActive = lock.pending_expires_at && new Date(lock.pending_expires_at).getTime() > nowDate.getTime();

  if (lock.lock_status === 'PENDING' && pendingActive) {
    return res.status(200).json({
      success: true,
      status: 'locked_by_other',
      lockedByOther: true,
      rows: [],
      loginIds: [],
      message: 'Bonus Harian tanggal ini sedang diproses operator lain.'
    });
  }

  return res.status(200).json({
    success: true,
    status: 'pending_expired',
    pendingExpired: true,
    rows: [],
    loginIds: [],
    message: 'Ada pending lama yang belum ditandai selesai.'
  });
}

async function handleDone(body, res) {
  const date = String(body.date || '');
  const claimOwner = normalizeText(body.claim_owner);

  if (!isValidDate(date)) {
    return res.status(400).json({ success: false, error: 'Format date harus YYYY-MM-DD.' });
  }

  if (!claimOwner) {
    return res.status(400).json({ success: false, error: 'claim_owner wajib diisi.' });
  }

  const now = new Date().toISOString();
  const lock = await fetchDateLock(date);

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
      updated_at: now
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
      updated_at: now
    })
    .eq('bonus_date', date)
    .eq('claim_owner', claimOwner)
    .eq('bonus_status', 'PENDING')
    .eq('bonus_type', 'BONUS_HARIAN')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, bonus_status, claim_owner, claim_batch_id, done_at');

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

async function handleGet(req, res) {
  const date = String(req.query.date || '');
  const claimOwner = normalizeText(req.query.claim_owner);

  if (!isValidDate(date)) {
    return res.status(400).json({
      success: false,
      error: 'Format date harus YYYY-MM-DD.'
    });
  }

  await deleteExpiredRows();

  const lock = await fetchDateLock(date);
  const now = Date.now();

  const { data: rows, error } = await supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, bonus_status, claim_owner, claim_batch_id, claimed_at, done_at, pending_expires_at, created_at')
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
    rows: rows || []
  });
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
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      const action = String(body.action || '').trim();

      if (action === 'claim_batch') return await handleClaimBatch(body, res);
      if (action === 'done') return await handleDone(body, res);

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
    return res.status(500).json({
      success: false,
      error: error.message || 'Server error.',
      details: error
    });
  }
}
