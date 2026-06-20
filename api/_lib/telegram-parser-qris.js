import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

export const TELEGRAM_PARSER_SOURCE = 'telegram-parser-qris';
export const TELEGRAM_PREVIEW_STATUS = 'WAITING_SUPERADMIN_APPROVAL';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.OPERATOR_SESSION_SECRET;

export const telegramParserSupabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

export function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

export function requireSupabase() {
  if (!telegramParserSupabase) {
    const error = new Error('Konfigurasi Supabase belum lengkap.');
    error.statusCode = 500;
    error.code = 'SUPABASE_NOT_CONFIGURED';
    throw error;
  }
}

export async function getOperator(req, roles = []) {
  requireSupabase();
  if (!sessionSecret) return null;
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, sessionSecret);
    if (!payload.operator_id || !payload.session_token_id) return null;
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: session, error: sessionError } = await telegramParserSupabase
      .from('operator_active_sessions')
      .select('id')
      .eq('operator_id', String(payload.operator_id))
      .eq('session_token_id', String(payload.session_token_id))
      .eq('is_active', true)
      .gte('last_seen_at', cutoff)
      .maybeSingle();
    if (sessionError || !session) return null;
    const { data: operator, error } = await telegramParserSupabase
      .from('operators')
      .select('id, username, display_name, role, is_active')
      .eq('id', payload.operator_id)
      .eq('is_active', true)
      .maybeSingle();
    if (error || !operator) return null;
    if (roles.length && !roles.includes(String(operator.role || '').toLowerCase())) return null;
    return operator;
  } catch (error) {
    return null;
  }
}

export async function requireOperator(req, roles = []) {
  const operator = await getOperator(req, roles);
  if (operator) return operator;
  const error = new Error(roles.length ? 'Akses Superadmin diperlukan.' : 'Session operator tidak valid.');
  error.statusCode = roles.length ? 403 : 401;
  error.code = roles.length ? 'SUPERADMIN_REQUIRED' : 'UNAUTHORIZED';
  throw error;
}

export async function requireIngestActor(req) {
  const expected = process.env.TELEGRAM_PARSER_QRIS_API_TOKEN || '';
  const token = bearerToken(req);
  if (expected && token === expected) {
    return { type: 'API', id: '', name: 'Telegram Parser QRIS API' };
  }
  const operator = await getOperator(req);
  if (operator) {
    return {
      type: 'OPERATOR',
      id: String(operator.id),
      name: operator.display_name || operator.username || 'Operator'
    };
  }
  const error = new Error('Token Telegram Parser QRIS atau session operator tidak valid.');
  error.statusCode = 401;
  error.code = 'UNAUTHORIZED';
  throw error;
}

export function parseJsonBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

export function cleanCell(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/^="([\s\S]*)"$/, '$1')
    .replace(/^=([\s\S]*)$/, '$1')
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

export function normalizeLoginId(value) {
  return cleanCell(value).toUpperCase();
}

function parseNumber(value) {
  const raw = cleanCell(value).replace(/[^\d.,-]/g, '');
  if (!raw) return 0;
  if (raw.includes(',') && raw.includes('.')) return Number(raw.replace(/,/g, '')) || 0;
  if (raw.includes(',') && !raw.includes('.')) return Number(raw.replace(/\./g, '').replace(',', '.')) || 0;
  return Number(raw) || 0;
}

function detectDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/).find(line => line.trim()) || '';
  const counts = {
    '\t': (firstLine.match(/\t/g) || []).length,
    ',': (firstLine.match(/,/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCsvRows(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cleanCell(cell));
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index++;
      row.push(cleanCell(cell));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cleanCell(cell));
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function firstValue(row, fields) {
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== '') return row[field];
  }
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, ''), value]));
  for (const field of fields) {
    const value = normalized[field.toLowerCase().replace(/\s+/g, '')];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function parseBoDate(value) {
  const match = cleanCell(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(+match[3], +match[1] - 1, +match[2], +match[4], +match[5], +match[6]));
}

function bonusDateFromBo(value) {
  const date = parseBoDate(value);
  if (!date) return '';
  const shifted = new Date(date.getTime() - 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function todayWib() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseDepositText(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '');
  const rows = parseCsvRows(text);
  const records = [];
  let skipped = 0;
  const header = (rows[0] || []).join(' ').toLowerCase();
  const csvLike = rows.length >= 2 && /login\s*id|application\s*time|amount|member\s*id|status/.test(header);

  if (csvLike) {
    const headers = rows[0].map(cleanCell);
    rows.slice(1).forEach((values, inputIndex) => {
      const row = Object.fromEntries(headers.map((key, index) => [key, cleanCell(values[index] || '')]));
      const loginId = cleanCell(firstValue(row, ['Login ID', 'LoginID', 'login_id', 'User ID', 'USER ID', 'Username', 'User Name']));
      const applicationTime = cleanCell(firstValue(row, ['Application Time (GMT+8)', 'Application Time', 'Apply Time', 'Date Created', 'Created Time', 'Date']));
      const amount = cleanCell(firstValue(row, ['Amount', 'Nominal', 'Deposit Amount', 'Approved Amount']));
      const payment = cleanCell(firstValue(row, ['Payment', 'Channel']));
      const method = cleanCell(firstValue(row, ['Payment Method', 'Payment Method ', 'Method']));
      const currency = cleanCell(firstValue(row, ['Currency']));
      if (!applicationTime || !loginId || !amount || (payment && payment.toUpperCase() !== 'QRIS IM') || (method && !/^QRIS$/i.test(method)) || (currency && currency.toUpperCase() !== 'IDR')) {
        skipped++;
        return;
      }
      if (/^MAGNUM188/i.test(loginId) || /@\d+$/.test(loginId)) {
        skipped++;
        return;
      }
      const fee = cleanCell(firstValue(row, ['Fee', 'QRIS Fee', 'Potongan QRIS'])) || '0';
      records.push({
        rowNumber: inputIndex + 2,
        loginId,
        loginKey: normalizeLoginId(loginId),
        memberId: cleanCell(firstValue(row, ['Member ID', 'MemberID', 'member_id', 'Member Id'])),
        memberName: cleanCell(firstValue(row, ['Member Name', 'MemberName', 'Member Acct Name', 'Nama Rekening', 'Account Name', 'Bank Account Name', 'Name'])),
        applicationTime,
        bonusDate: bonusDateFromBo(applicationTime),
        amount: parseNumber(amount),
        fee: parseNumber(fee),
        status: cleanCell(firstValue(row, ['Status', 'Trans. Status', 'Transaction Status'])),
        rawItem: row
      });
    });
  } else {
    const lines = text.split(/\r?\n/).map(cleanCell).filter(Boolean);
    const datePattern = /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/;
    const numberPattern = /^[\d,]+\.\d{1,2}$/;
    for (let index = 6; index < lines.length - 6; index++) {
      if (!datePattern.test(lines[index]) || String(lines[index + 1]).toUpperCase() !== 'QRIS IM' || String(lines[index + 3]).toUpperCase() !== 'IDR' || !numberPattern.test(lines[index + 4]) || !numberPattern.test(lines[index + 5])) continue;
      const loginId = lines[index - 5] || '';
      if (/^MAGNUM188/i.test(loginId) || /@\d+$/.test(loginId)) {
        skipped++;
        continue;
      }
      records.push({
        rowNumber: records.length + 1,
        loginId,
        loginKey: normalizeLoginId(loginId),
        memberId: /^\d+@?\d*$/i.test(lines[index - 6] || '') ? lines[index - 6] : '',
        memberName: lines[index - 4] || '',
        applicationTime: lines[index],
        bonusDate: bonusDateFromBo(lines[index]),
        amount: parseNumber(lines[index + 4]),
        fee: parseNumber(lines[index + 5]),
        status: lines[index + 6] || '',
        rawItem: { raw_lines: lines.slice(index - 6, index + 7) }
      });
    }
  }
  if (!records.length) {
    const error = new Error('Tidak ada transaksi deposit valid yang ditemukan.');
    error.statusCode = 400;
    error.code = 'NO_VALID_DEPOSIT_ROWS';
    throw error;
  }
  return { records, skipped };
}

export function buildTelegramPreview(records, bonusDate) {
  const eligibleDeposits = records
    .filter(row => (!row.status || /^APPROVED$/i.test(row.status)) && row.bonusDate === bonusDate)
    .map(row => ({ ...row, totalAmount: Math.round((row.amount + row.fee) * 1000), timestamp: parseBoDate(row.applicationTime)?.getTime() || 0 }));
  const largestByLogin = new Map();
  for (const row of eligibleDeposits) {
    const current = largestByLogin.get(row.loginKey);
    if (!current || row.totalAmount > current.totalAmount || (row.totalAmount === current.totalAmount && row.timestamp > current.timestamp)) largestByLogin.set(row.loginKey, row);
  }
  const items = [...largestByLogin.values()].map(row => {
    const amountBo = row.totalAmount >= 100000 ? 10 : row.totalAmount >= 50000 ? 5 : 0;
    let status = amountBo > 0 ? 'READY' : 'SKIPPED_BELOW_THRESHOLD';
    const warnings = [];
    if (amountBo > 0 && !row.memberId) warnings.push('Member ID kosong');
    if (amountBo > 0 && !row.memberName) warnings.push('Member Name kosong');
    if (amountBo > 0 && row.loginId.length <= 5) warnings.push('Login ID pendek');
    if (warnings.length) status = 'MANUAL_REVIEW';
    return { ...row, amountBo, amountRaw: amountBo * 1000, previewStatus: status, warning: warnings.join(' | ') };
  });
  const count = status => items.filter(item => item.previewStatus === status).length;
  return {
    items,
    summary: {
      total_parsed: records.length,
      deposits_for_bonus_date: eligibleDeposits.length,
      ready_items: count('READY'),
      skipped_items: count('SKIPPED_BELOW_THRESHOLD'),
      manual_review_items: count('MANUAL_REVIEW'),
      total_amount: eligibleDeposits.reduce((sum, row) => sum + row.totalAmount, 0),
      total_bonus_bo: items.filter(item => item.previewStatus !== 'SKIPPED_BELOW_THRESHOLD').reduce((sum, item) => sum + item.amountBo, 0)
    }
  };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function batchCode(bonusDate) {
  return `TPQ-${String(bonusDate).replace(/-/g, '')}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function apiError(res, error, fallback = 'Request Telegram Parser QRIS gagal.') {
  console.error('telegram-parser-qris error:', error);
  return res.status(error.statusCode || 500).json({
    success: false,
    error: error.code || 'TELEGRAM_PARSER_QRIS_FAILED',
    message: error.message || fallback
  });
}

export async function fetchBatchDetail(identifier) {
  requireSupabase();
  let query = telegramParserSupabase.from('telegram_parser_batches').select('*').eq('source', TELEGRAM_PARSER_SOURCE);
  query = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(identifier || '')) ? query.eq('id', identifier) : query.eq('batch_code', identifier);
  const { data: batch, error } = await query.maybeSingle();
  if (error) throw error;
  if (!batch) return null;
  const [depositsResult, previewResult, eventsResult] = await Promise.all([
    telegramParserSupabase.from('telegram_parser_deposit_items').select('*').eq('batch_id', batch.id).order('row_number'),
    telegramParserSupabase.from('telegram_bonus_preview_items').select('*').eq('batch_id', batch.id).order('login_key'),
    telegramParserSupabase.from('telegram_parser_batch_events').select('*').eq('batch_id', batch.id).order('created_at', { ascending: false })
  ]);
  if (depositsResult.error) throw depositsResult.error;
  if (previewResult.error) throw previewResult.error;
  if (eventsResult.error) throw eventsResult.error;
  return { batch, deposit_items: depositsResult.data || [], preview_items: previewResult.data || [], events: eventsResult.data || [] };
}
