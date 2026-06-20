import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: false
  }
};

const FIXED_SOURCE = 'hermes-telegram';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const GENERATE_TIMEOUT_MS = 45 * 1000;
const MAX_PREVIEW_ITEMS = 50;
const RESERVE_UPDATE_CONCURRENCY = 8;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

function json(res, status, body) {
  if (res.writableEnded || res.headersSent) return false;
  res.status(status).json(body);
  return true;
}

function createRequestContext() {
  return {
    request_id: `parser-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    last_step: 'INIT',
    deadline_ms: Date.now() + GENERATE_TIMEOUT_MS,
    started_ms: Date.now(),
    timings: {}
  };
}

function logStep(ctx, step, meta = {}) {
  ctx.last_step = step;
  console.info('generate-json step', {
    request_id: ctx.request_id,
    step,
    ...meta,
    at: new Date().toISOString()
  });
}

function parserError(code, message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function supabaseError(error, message = 'Supabase gagal memproses data Bonus Harian.') {
  return parserError('SUPABASE_ERROR', error?.message || message, 500, {
    supabase_error: {
      code: error?.code || '',
      details: error?.details || '',
      hint: error?.hint || ''
    }
  });
}

function safeErrorMessage(error) {
  return String(error?.message || 'Parser gagal memproses file.').slice(0, 500);
}

function responseFromError(error, ctx) {
  const status = Number(error?.statusCode || 500);
  ctx.timings.TIME_TOTAL_MS = Date.now() - ctx.started_ms;
  return {
    status,
    body: {
      ok: false,
      error: error?.code || (status === 413 ? 'PAYLOAD_TOO_LARGE' : 'PARSER_FAILED'),
      message: safeErrorMessage(error),
      last_step: ctx.last_step,
      request_id: ctx.request_id,
      timings: ctx.timings
    }
  };
}

function detectUploadType(file) {
  const filename = String(file?.filename || '').toLowerCase();
  if (/\.xlsx$/.test(filename)) return 'xlsx';
  if (/\.csv$/.test(filename)) return 'csv';
  if (/\.tsv$/.test(filename)) return 'tsv';
  return filename ? 'raw_text' : 'missing';
}

function ensureWithinDeadline(ctx) {
  if (Date.now() <= ctx.deadline_ms) return;
  ctx.timings.TIME_TOTAL_MS = Date.now() - ctx.started_ms;
  throw parserError('PARSER_TIMEOUT', 'Generate preview melebihi batas waktu.', 504);
}

function markTime(ctx, label, startedAt, meta = {}) {
  const elapsed = Date.now() - startedAt;
  ctx.timings[label] = elapsed;
  console.info('generate-json timing', {
    request_id: ctx.request_id,
    step: label,
    elapsed_ms: elapsed,
    ...meta,
    at: new Date().toISOString()
  });
  return elapsed;
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function assertAuth(req) {
  const expected = process.env.HERMES_PARSER_API_TOKEN || '';
  const token = bearerToken(req);
  return Boolean(expected && token && token === expected);
}

function cleanCell(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/^="([\s\S]*)"$/, '$1')
    .replace(/^=([\s\S]*)$/, '$1')
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

function normalizeLoginId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeBonusText(text) {
  return String(text || '')
    .toUpperCase()
    .trim()
    .replace(/[^\w\s/@.-]/g, ' ')
    .replace(/[\s.-]+$/g, '')
    .replace(/\s+/g, ' ');
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function dateInputFromParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
  if (y < 2000 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function getTodayJakartaInput() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(part => {
    if (part.type !== 'literal') map[part.type] = part.value;
  });
  return `${map.year}-${map.month}-${map.day}`;
}

function displayLongDate(value) {
  const [year, month, day] = String(value || '').split('-');
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const monthIndex = Number(month) - 1;
  if (!year || !month || !day || !months[monthIndex]) return String(value || '').trim();
  return `${Number(day)} ${months[monthIndex]} ${year}`;
}

function compactDate(value) {
  return String(value || '').replace(/-/g, '');
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function createBatchCode(dateValue) {
  const now = new Date();
  const tail = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}`;
  return `BH-${compactDate(dateValue)}-${tail}`;
}

function isHermesSource(source) {
  return String(source || '').trim().toLowerCase() === FIXED_SOURCE;
}

function bonusMonthMap() {
  return {
    JANUARI: 1, JANUARY: 1, JAN: 1,
    FEBRUARI: 2, FEBRUARY: 2, FEB: 2,
    MARET: 3, MARCH: 3, MAR: 3,
    APRIL: 4, APR: 4,
    MEI: 5, MAY: 5,
    JUNI: 6, JUNE: 6, JUN: 6,
    JULI: 7, JULY: 7, JUL: 7,
    AGUSTUS: 8, AUGUST: 8, AGU: 8, AUG: 8,
    SEPTEMBER: 9, SEP: 9,
    OKTOBER: 10, OCTOBER: 10, OKT: 10, OCT: 10,
    NOVEMBER: 11, NOV: 11,
    DESEMBER: 12, DECEMBER: 12, DES: 12, DEC: 12
  };
}

function parseBonusDateFromRemark(text, fallbackDate) {
  const normalized = normalizeBonusText(text);
  if (!normalized) return '';
  const fallback = fallbackDate instanceof Date && !Number.isNaN(fallbackDate.getTime()) ? fallbackDate : null;
  const fallbackYear = fallback ? fallback.getUTCFullYear() : '';

  const bhCode = normalized.match(/\bBH[-\s]?(\d{4})(\d{2})(\d{2})\b/);
  if (bhCode) return dateInputFromParts(bhCode[1], bhCode[2], bhCode[3]);

  const compact = normalized.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compact) return dateInputFromParts(compact[1], compact[2], compact[3]);

  const slash = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const month = first > 12 ? second : first;
    const day = first > 12 ? first : second;
    return dateInputFromParts(slash[3], month, day);
  }

  const named = normalized.match(/\b(?:BONUS\s+HARIAN\s+)?(?:TGL\s+)?(\d{1,2})\s+([A-Z]+)(?:\s+(20\d{2}))?\b/);
  if (!named) return '';
  const month = bonusMonthMap()[named[2]];
  const year = named[3] || fallbackYear;
  if (!month || !year) return '';
  return dateInputFromParts(year, month, named[1]);
}

function isBonusHarianText(text) {
  const value = normalizeBonusText(text);
  if (/LUCKY\s*SPIN|LUCKYSPIN|KLAIM\s*FREESPIN|FREE\s*SPIN|FREESPIN|KLAIM\s*\d*\s*SCATTER|SCATTER|BUY\s*SPIN|BUYSPIN|SUPER\s*SCATTER|PRAGMATIC|MAHJONG|JP|JACKPOT/.test(value)) {
    return false;
  }
  return /\bBONUS\s*HARIAN\b|\bBH[-\s]/.test(value);
}

function parseBoDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(+match[3], +match[1] - 1, +match[2], +match[4], +match[5], +match[6]));
}

function gmt7DateInput(dateText) {
  const date = parseBoDate(dateText);
  if (!date) return '';
  const shifted = new Date(date.getTime() - 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
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
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  if (tabCount > commaCount && tabCount >= semicolonCount) return '\t';
  if (semicolonCount > commaCount && semicolonCount >= tabCount) return ';';
  return ',';
}

function parseCsvRows(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      row.push(cleanCell(cell));
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(cleanCell(cell));
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cleanCell(cell));
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

function csvRecords(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map(cleanCell);
  return rows.slice(1).map(row => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cleanCell(row[index] || '');
    });
    return record;
  });
}

function firstValue(row, fields) {
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== '') return row[field];
  }
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, ''), value]));
  for (const field of fields) {
    const key = field.toLowerCase().replace(/\s+/g, '');
    if (normalized[key] !== undefined && normalized[key] !== '') return normalized[key];
  }
  return '';
}

function looksLikeCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return false;
  const header = rows[0].join(' ').toLowerCase();
  return /login\s*id|application\s*time|amount|member\s*id|status/.test(header);
}

function parseDepositRows(rawText) {
  const text = String(rawText || '');
  const records = [];
  let skipped = 0;

  if (looksLikeCsv(text)) {
    csvRecords(text).forEach(row => {
      const loginId = cleanCell(firstValue(row, ['Login ID', 'LoginID', 'login_id', 'User ID', 'USER ID', 'Username', 'User Name']));
      const memberId = cleanCell(firstValue(row, ['Member ID', 'MemberID', 'member_id', 'Member Id']));
      const memberName = cleanCell(firstValue(row, ['Member Name', 'MemberName', 'Member Acct Name', 'Nama Rekening', 'Account Name', 'Bank Account Name', 'Name']));
      const applicationTime = cleanCell(firstValue(row, ['Application Time (GMT+8)', 'Application Time', 'Apply Time', 'Date Created', 'Created Time', 'Date']));
      const payment = cleanCell(firstValue(row, ['Payment', 'Channel']));
      const method = cleanCell(firstValue(row, ['Payment Method', 'Payment Method ', 'Method']));
      const currency = cleanCell(firstValue(row, ['Currency']));
      const amount = cleanCell(firstValue(row, ['Amount', 'Nominal', 'Deposit Amount', 'Approved Amount']));
      const fee = cleanCell(firstValue(row, ['Fee', 'QRIS Fee', 'Potongan QRIS']));
      const status = cleanCell(firstValue(row, ['Status', 'Trans. Status', 'Transaction Status']));

      if (!applicationTime || !loginId || !amount) return;
      if (payment && payment.toUpperCase() !== 'QRIS IM') return;
      if (method && !/^QRIS$/i.test(method)) return;
      if (currency && currency.toUpperCase() !== 'IDR') return;
      if (/^MAGNUM188/i.test(loginId) || /@\d+$/.test(loginId)) {
        skipped++;
        return;
      }

      records.push({
        loginId,
        loginKey: normalizeLoginId(loginId),
        memberId,
        memberName,
        applicationTime,
        amount,
        fee: fee || '0.00',
        status: status || ''
      });
    });
    return { records, skipped };
  }

  const lines = text.split(/\r?\n/).map(line => cleanCell(line)).filter(Boolean);
  const datePattern = /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/;
  const numPattern = /^[\d,]+\.\d{1,2}$/;

  for (let i = 6; i < lines.length - 6; i++) {
    if (!datePattern.test(lines[i])) continue;
    if (String(lines[i + 1] || '').toUpperCase() !== 'QRIS IM') continue;
    if (String(lines[i + 3] || '').toUpperCase() !== 'IDR') continue;
    if (!numPattern.test(lines[i + 4] || '')) continue;
    if (!numPattern.test(lines[i + 5] || '')) continue;

    const loginId = lines[i - 5] || '';
    if (/^MAGNUM188/i.test(loginId) || /@\d+$/.test(loginId)) {
      skipped++;
      continue;
    }

    records.push({
      loginId,
      loginKey: normalizeLoginId(loginId),
      memberId: /^\d+@?\d*$/i.test(lines[i - 6] || '') ? lines[i - 6] : '',
      memberName: lines[i - 4] || '',
      applicationTime: lines[i],
      amount: lines[i + 4],
      fee: lines[i + 5],
      status: lines[i + 6] || ''
    });
  }

  return { records, skipped };
}

function isAdjustmentStatusDone(status) {
  return /^(APPROVED|SUCCESS|COMPLETED)$/i.test(cleanCell(status));
}

function isAdjustmentStatusPending(status) {
  return /^PENDING$/i.test(cleanCell(status));
}

function isAdjustmentStatusRejected(status) {
  return /^(REJECT|REJECTED|CANCELLED|CANCELED)$/i.test(cleanCell(status));
}

function isBoStatusLine(value) {
  return /^(APPROVED|SUCCESS|COMPLETED|REJECT|REJECTED|PENDING|CANCELLED|CANCELED)$/i.test(cleanCell(value));
}

function parseAdjustmentRows(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return [];

  if (looksLikeCsv(text)) {
    return csvRecords(text).map(row => {
      const loginId = cleanCell(firstValue(row, ['Login ID', 'LoginID', 'login_id', 'User ID', 'Username', 'User Name']));
      const memberId = cleanCell(firstValue(row, ['Member ID', 'MemberID', 'member_id']));
      const status = cleanCell(firstValue(row, ['Status', 'Trans. Status', 'Transaction Status']));
      const transactionNumber = cleanCell(firstValue(row, ['Transaction Number', 'Trans. Number', 'Trans Number']));
      const remark = cleanCell(firstValue(row, ['Remark', 'Remarks']));
      const approvedTime = cleanCell(firstValue(row, ['Approved Time', 'Approve Time']));
      const dateCreated = cleanCell(firstValue(row, ['Date Created', 'Created Time']));
      const rowDate = parseBoDate(approvedTime) || parseBoDate(dateCreated);
      const bonusDate = parseBonusDateFromRemark(`${transactionNumber} ${remark}`, rowDate) || gmt7DateInput(approvedTime || dateCreated);
      return {
        loginId,
        loginKey: normalizeLoginId(loginId),
        memberId,
        amount: parseNumber(firstValue(row, ['Adjustment Amt', 'Adjustment Amount', 'Adj Amount', 'Amount'])),
        status,
        transactionNumber,
        remark,
        approvedTime,
        dateCreated,
        bonusDate
      };
    }).filter(row => row.loginKey);
  }

  const lines = text.split(/\r?\n/).map(line => cleanCell(line)).filter(Boolean);
  const records = [];

  for (let i = 0; i < lines.length - 10; i++) {
    if (!/^\d+@\d+$/i.test(lines[i + 1] || '')) continue;
    if (!/^\d{4,}$/.test(lines[i + 2] || '')) continue;
    if (String(lines[i + 3] || '').toUpperCase() !== 'IDR') continue;

    const loginId = lines[i];
    const memberId = lines[i + 1];
    const adjustmentId = lines[i + 2];
    const amount = parseNumber(lines[i + 7]);
    let statusIndex = -1;

    for (let cursor = i + 8; cursor < Math.min(lines.length, i + 24); cursor++) {
      if (isBoStatusLine(lines[cursor])) {
        statusIndex = cursor;
        break;
      }
    }
    if (statusIndex === -1) continue;

    let dateCreatedIndex = -1;
    for (let cursor = statusIndex + 1; cursor < Math.min(lines.length, statusIndex + 8); cursor++) {
      if (parseBoDate(lines[cursor])) {
        dateCreatedIndex = cursor;
        break;
      }
    }

    let approvedTimeIndex = -1;
    if (dateCreatedIndex !== -1) {
      for (let cursor = dateCreatedIndex + 1; cursor < Math.min(lines.length, dateCreatedIndex + 8); cursor++) {
        if (parseBoDate(lines[cursor])) {
          approvedTimeIndex = cursor;
          break;
        }
      }
    }

    const transactionNumber = lines.slice(i + 8, statusIndex).join(' ').trim();
    const remarkEnd = dateCreatedIndex === -1 ? Math.min(lines.length, statusIndex + 4) : dateCreatedIndex;
    const remark = lines.slice(statusIndex + 1, remarkEnd).join(' ').trim() || transactionNumber;
    const dateCreated = dateCreatedIndex !== -1 ? lines[dateCreatedIndex] : '';
    const approvedTime = approvedTimeIndex !== -1 ? lines[approvedTimeIndex] : '';
    const rowDate = parseBoDate(approvedTime) || parseBoDate(dateCreated);
    const bonusDate = parseBonusDateFromRemark(`${transactionNumber} ${remark}`, rowDate) || gmt7DateInput(approvedTime || dateCreated);

    records.push({
      loginId,
      loginKey: normalizeLoginId(loginId),
      memberId,
      adjustmentId,
      amount,
      status: lines[statusIndex],
      transactionNumber,
      remark,
      dateCreated,
      approvedTime,
      bonusDate
    });
  }

  return records;
}

function validateBatchItems(rows, dateValue) {
  const items = [];
  const skipped = [];
  const warnings = [];
  const note = `Bonus Harian ${displayLongDate(dateValue)}`;
  const summary = {
    total_items: 0,
    missing_login_id: 0,
    missing_member_id: 0,
    missing_amount: 0,
    duplicate_login_id_same_date: 0,
    duplicate_member_id_same_date: 0,
    total_amount_raw: 0,
    total_amount_bo: 0,
    skipped_items: 0,
    missing_member_name: 0,
    short_login_id_warning: 0,
    similar_login_id_warning: 0
  };

  rows.forEach((row, index) => {
    const loginId = cleanCell(row.loginId || row.login_id);
    const memberId = cleanCell(row.memberId || row.member_id);
    const memberName = cleanCell(row.memberName || row.member_name);
    const amountBo = Number(row.bonus || row.bonus_amount || 0);
    const amountRaw = Math.round(amountBo * 1000);
    const baseSkipped = { index: index + 1, login_id: loginId, reason: '' };

    if (!loginId) {
      summary.missing_login_id += 1;
      skipped.push({ ...baseSkipped, reason: 'LOGIN_ID_EMPTY' });
      return;
    }
    if (!Number.isFinite(amountBo) || amountBo <= 0 || !Number.isFinite(amountRaw) || amountRaw <= 0) {
      summary.missing_amount += 1;
      skipped.push({ ...baseSkipped, reason: 'AMOUNT_INVALID' });
      return;
    }

    const itemWarnings = [];
    if (!memberId) {
      summary.missing_member_id += 1;
      itemWarnings.push('Member ID kosong');
      warnings.push({ type: 'MISSING_MEMBER_ID', login_id: loginId, message: `Member ID kosong untuk ${loginId}.` });
    }
    if (!memberName) {
      summary.missing_member_name += 1;
      warnings.push({ type: 'MISSING_MEMBER_NAME', login_id: loginId, message: `Member Name kosong untuk ${loginId}.` });
    }
    if (loginId.length <= 5) {
      summary.short_login_id_warning += 1;
      warnings.push({ type: 'SHORT_LOGIN_ID', login_id: loginId, message: `Login ID pendek: ${loginId}.` });
    }

    items.push({
      login_id: normalizeLoginId(loginId),
      member_id: memberId,
      member_name: memberName,
      amount_raw: amountRaw,
      amount_bo: amountBo,
      bonus_date: dateValue,
      bonus_type: 'BONUS_HARIAN',
      trans_no: note,
      note,
      warning: itemWarnings.join(' | ')
    });
  });

  const loginDateCounts = new Map();
  const memberDateCounts = new Map();
  items.forEach(item => {
    const loginKey = `${item.bonus_date}|${normalizeLoginId(item.login_id)}`;
    loginDateCounts.set(loginKey, (loginDateCounts.get(loginKey) || 0) + 1);
    if (item.member_id) {
      const memberKey = `${item.bonus_date}|${item.member_id.toUpperCase()}`;
      memberDateCounts.set(memberKey, (memberDateCounts.get(memberKey) || 0) + 1);
    }
  });

  items.forEach(item => {
    const itemWarnings = item.warning ? item.warning.split(' | ').filter(Boolean) : [];
    const loginKey = `${item.bonus_date}|${normalizeLoginId(item.login_id)}`;
    const memberKey = `${item.bonus_date}|${item.member_id.toUpperCase()}`;
    if (loginDateCounts.get(loginKey) > 1) itemWarnings.push('Duplicate Login ID tanggal sama');
    if (item.member_id && memberDateCounts.get(memberKey) > 1) itemWarnings.push('Duplicate Member ID tanggal sama');
    item.warning = [...new Set(itemWarnings)].join(' | ');
  });

  summary.duplicate_login_id_same_date = [...loginDateCounts.values()].filter(count => count > 1).length;
  summary.duplicate_member_id_same_date = [...memberDateCounts.values()].filter(count => count > 1).length;
  summary.total_items = items.length;
  summary.total_amount_raw = items.reduce((sum, item) => sum + item.amount_raw, 0);
  summary.total_amount_bo = items.reduce((sum, item) => sum + item.amount_bo, 0);
  summary.skipped_items = skipped.length;

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const left = items[i].login_id.toLowerCase();
      const right = items[j].login_id.toLowerCase();
      if (!left || !right || left === right) continue;
      if (left.includes(right) || right.includes(left)) {
        summary.similar_login_id_warning += 1;
        warnings.push({
          type: 'SIMILAR_LOGIN_ID',
          login_id: items[i].login_id,
          similar_to: items[j].login_id,
          message: `Login ID ${items[i].login_id} mirip dengan ${items[j].login_id}.`
        });
      }
    }
  }

  return { items, skipped, warnings, summary };
}

function applyAdjustmentDuplicateCheck(batchRows, adjustmentRaw, dateValue) {
  const warnings = [];
  const skipped = [];
  if (!adjustmentRaw || !adjustmentRaw.trim()) {
    warnings.push({
      type: 'ADJUSTMENT_FILE_MISSING',
      message: 'Adjustment file tidak diberikan, duplicate check awal dilewati.'
    });
    return { rows: batchRows, skipped, warnings };
  }

  const adjustmentRows = parseAdjustmentRows(adjustmentRaw);
  const approved = adjustmentRows.filter(row => {
    if (!isAdjustmentStatusDone(row.status)) return false;
    if (!isBonusHarianText(`${row.transactionNumber} ${row.remark}`)) return false;
    return row.bonusDate === dateValue;
  });
  const pending = adjustmentRows.filter(row => {
    if (!isAdjustmentStatusPending(row.status)) return false;
    if (!isBonusHarianText(`${row.transactionNumber} ${row.remark}`)) return false;
    return row.bonusDate === dateValue;
  });
  const approvedLoginKeys = new Set(approved.map(row => row.loginKey).filter(Boolean));
  const approvedMemberIds = new Set(approved.map(row => cleanCell(row.memberId).toUpperCase()).filter(Boolean));
  const pendingLoginKeys = new Set(pending.map(row => row.loginKey).filter(Boolean));
  const pendingMemberIds = new Set(pending.map(row => cleanCell(row.memberId).toUpperCase()).filter(Boolean));

  const rows = [];
  batchRows.forEach(row => {
    const loginKey = normalizeLoginId(row.loginId);
    const memberKey = cleanCell(row.memberId).toUpperCase();
    if (approvedLoginKeys.has(loginKey) || (memberKey && approvedMemberIds.has(memberKey))) {
      skipped.push({
        login_id: row.loginId,
        member_id: row.memberId || '',
        reason: 'ALREADY_APPROVED_BONUS_HARIAN'
      });
      return;
    }
    if (pendingLoginKeys.has(loginKey) || (memberKey && pendingMemberIds.has(memberKey))) {
      row.warning = [row.warning, 'Adjustment pending/manual review'].filter(Boolean).join(' | ');
      warnings.push({
        type: 'ADJUSTMENT_PENDING',
        login_id: row.loginId,
        member_id: row.memberId || '',
        message: `Adjustment pending ditemukan untuk ${row.loginId}. Review manual.`
      });
    }
    rows.push(row);
  });

  adjustmentRows
    .filter(row => !row.bonusDate && !isAdjustmentStatusRejected(row.status) && isBonusHarianText(`${row.transactionNumber} ${row.remark}`))
    .slice(0, 20)
    .forEach(row => warnings.push({
      type: 'ADJUSTMENT_DATE_UNPARSED',
      login_id: row.loginId,
      member_id: row.memberId || '',
      message: `Tanggal Bonus Harian tidak terbaca untuk Adjustment ${row.loginId}.`
    }));

  return { rows, skipped, warnings };
}

function buildBonusBatch({ depositRaw, adjustmentRaw, bonusDate, source }) {
  const targetDate = isValidDate(bonusDate) ? bonusDate : getTodayJakartaInput();
  const parsed = parseDepositRows(depositRaw);
  const deposits = parsed.records
    .filter(row => (!row.status || /^APPROVED$/i.test(row.status)) && gmt7DateInput(row.applicationTime) === targetDate)
    .map(row => ({
      ...row,
      total: (parseNumber(row.amount) + parseNumber(row.fee)) * 1000,
      timestamp: parseBoDate(row.applicationTime)?.getTime() || 0
    }));

  const byLogin = new Map();
  deposits.forEach(row => {
    if (!row.loginKey) return;
    const current = byLogin.get(row.loginKey);
    if (!current || row.total > current.maxDeposit || (row.total === current.maxDeposit && row.timestamp > current.timestamp)) {
      byLogin.set(row.loginKey, {
        loginId: row.loginId,
        memberId: row.memberId,
        memberName: row.memberName,
        maxDeposit: row.total,
        timestamp: row.timestamp
      });
    }
  });

  const candidateRows = [...byLogin.values()]
    .map(row => ({
      ...row,
      bonus: row.maxDeposit >= 100000 ? 10 : row.maxDeposit >= 50000 ? 5 : 0,
      warning: ''
    }))
    .filter(row => row.bonus > 0);

  const duplicateCheck = applyAdjustmentDuplicateCheck(candidateRows, adjustmentRaw, targetDate);
  const validation = validateBatchItems(duplicateCheck.rows, targetDate);
  validation.skipped.push(...duplicateCheck.skipped);
  validation.warnings.push(...duplicateCheck.warnings);
  validation.summary.skipped_items = validation.skipped.length;

  return {
    batch_code: `BH-${compactDate(targetDate)}-001`,
    mode: 'BONUS_HARIAN',
    created_at: new Date().toISOString(),
    source: source || FIXED_SOURCE,
    summary: validation.summary,
    items: validation.items,
    skipped: validation.skipped,
    warnings: validation.warnings
  };
}

async function expireOldBonusPending() {
  if (!supabase) throw supabaseError(null, 'Konfigurasi Supabase belum lengkap.');

  const { data, error } = await supabase.rpc('expire_old_bonus_pending');
  if (!error) {
    return {
      ok: true,
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
  if (bonusFetchError) throw supabaseError(bonusFetchError);

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
    if (retry.error) throw supabaseError(retry.error);
  } else if (bonusUpdateError) {
    throw supabaseError(bonusUpdateError);
  }

  const { data: lockRows, error: lockFetchError } = await supabase
    .from('bonus_process_locks')
    .select('id')
    .eq('lock_status', 'PENDING')
    .lt('pending_expires_at', now);
  if (lockFetchError) throw supabaseError(lockFetchError);

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
    if (retry.error) throw supabaseError(retry.error);
  } else if (lockUpdateError) {
    throw supabaseError(lockUpdateError);
  }

  return {
    ok: true,
    expired_bonus_rows: bonusRows?.length || 0,
    expired_lock_rows: lockRows?.length || 0
  };
}

async function fetchBonusStatusRows(dateValue, loginKeys = []) {
  const baseSelect = 'id, bonus_date, login_id, login_key, bonus_type, bonus_amount, remark, source, operator_name, bonus_status, claim_owner, claim_batch_id, claimed_at, pending_expires_at, created_at, done_at';
  const uniqueLoginKeys = [...new Set((loginKeys || []).map(normalizeLoginId).filter(Boolean))];
  let query = supabase
    .from('bonus_done_daily')
    .select(`${baseSelect}, member_id`)
    .eq('bonus_date', dateValue)
    .eq('bonus_type', 'BONUS_HARIAN')
    .order('created_at', { ascending: true });
  if (uniqueLoginKeys.length) query = query.in('login_key', uniqueLoginKeys);
  let { data, error } = await query;
  if (error && error.code === '42703') {
    let fallbackQuery = supabase
      .from('bonus_done_daily')
      .select(baseSelect)
      .eq('bonus_date', dateValue)
      .eq('bonus_type', 'BONUS_HARIAN')
      .order('created_at', { ascending: true });
    if (uniqueLoginKeys.length) fallbackQuery = fallbackQuery.in('login_key', uniqueLoginKeys);
    const fallback = await fallbackQuery;
    data = fallback.data;
    error = fallback.error;
  }
  if (error) throw supabaseError(error);
  return data || [];
}

async function fetchActivePendingLock(dateValue) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('bonus_process_locks')
    .select('*')
    .eq('bonus_date', dateValue)
    .eq('lock_status', 'PENDING')
    .gte('pending_expires_at', now)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw supabaseError(error);
  return data || null;
}

function classifyReadyItems(items, existingRows, activeLock) {
  const nowMs = Date.now();
  const doneKeys = new Set();
  const pendingKeys = new Set();
  const doneMemberIds = new Set();
  const pendingMemberIds = new Set();
  let expiredReleased = 0;

  (existingRows || []).forEach(row => {
    const loginKey = normalizeLoginId(row.login_key || row.login_id);
    const memberId = cleanCell(row.member_id || '').toUpperCase();
    const status = String(row.bonus_status || '').toUpperCase();
    const pendingMs = row.pending_expires_at ? new Date(row.pending_expires_at).getTime() : 0;
    if (status === 'DONE') {
      if (loginKey) doneKeys.add(loginKey);
      if (memberId) doneMemberIds.add(memberId);
    } else if (status === 'PENDING' && pendingMs >= nowMs) {
      if (loginKey) pendingKeys.add(loginKey);
      if (memberId) pendingMemberIds.add(memberId);
    } else if (status === 'EXPIRED' || (status === 'PENDING' && pendingMs && pendingMs < nowMs)) {
      expiredReleased += 1;
    }
  });

  const ready = [];
  const skipped = [];
  const manualReview = [];

  items.forEach(item => {
    const loginKey = normalizeLoginId(item.login_id);
    const memberKey = cleanCell(item.member_id).toUpperCase();
    if (doneKeys.has(loginKey) || (memberKey && doneMemberIds.has(memberKey))) {
      skipped.push({
        ...item,
        status: 'SKIPPED_ALREADY_GIVEN',
        reason: 'SKIPPED_ALREADY_GIVEN'
      });
      return;
    }
    if (pendingKeys.has(loginKey) || (memberKey && pendingMemberIds.has(memberKey)) || activeLock) {
      skipped.push({
        ...item,
        status: 'PENDING_OTHER_BATCH',
        reason: 'PENDING_OTHER_BATCH',
        claim_batch_id: activeLock?.claim_batch_id || ''
      });
      return;
    }
    if (item.warning) {
      manualReview.push({
        ...item,
        status: 'MANUAL_REVIEW',
        reason: item.warning
      });
    }
    ready.push(item);
  });

  return { ready, skipped, manualReview, expiredReleased };
}

function logReserveStep(step, meta = {}) {
  console.info('generate-json reserve', {
    step,
    ...meta,
    at: new Date().toISOString()
  });
}

function missingColumnName(error) {
  if (error?.code !== '42703') return '';
  const message = String(error.message || error.details || '');
  return message.match(/column "([^"]+)"/i)?.[1] || '';
}

async function writeBonusDoneWithColumnFallback(payload, writeFn) {
  const current = { ...payload };
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, error } = await writeFn(current);
    if (!error) return data;
    const column = missingColumnName(error);
    if (!column || !(column in current)) throw supabaseError(error);
    delete current[column];
  }
  throw supabaseError(null, 'Gagal menulis bonus_done_daily setelah fallback kolom.');
}

async function writeBonusDoneBulkWithColumnFallback(payloads, writeFn) {
  let current = payloads.map(payload => ({ ...payload }));
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, error } = await writeFn(current);
    if (!error) return data || [];
    const column = missingColumnName(error);
    if (!column || !current.some(payload => column in payload)) throw supabaseError(error);
    current = current.map(({ [column]: _removed, ...payload }) => payload);
  }
  throw supabaseError(null, 'Gagal bulk write bonus_done_daily setelah fallback kolom.');
}

function pendingRowPayload({ item, dateValue, batchCode, source, claimOwner, operatorName, now, pendingExpiresAt, expiresAt, finalizedNote }) {
  return {
    bonus_date: dateValue,
    login_id: item.login_id,
    login_key: normalizeLoginId(item.login_key || item.login_id),
    member_id: item.member_id || '',
    member_name: item.member_name || '',
    bonus_type: 'BONUS_HARIAN',
    bonus_amount: item.amount_bo,
    remark: item.note || item.remark || '',
    source: source || 'hermes_telegram',
    operator_name: operatorName,
    bonus_status: 'PENDING',
    claim_owner: claimOwner,
    claim_batch_id: batchCode,
    claimed_at: now,
    updated_at: now,
    pending_expires_at: pendingExpiresAt,
    expires_at: expiresAt,
    done_at: null,
    done_by_name: null,
    finalized_note: finalizedNote || null,
    reason: null,
    warning: item.warning || null
  };
}

async function fetchExistingBonusDoneRows(items, dateValue) {
  const loginKeys = [...new Set((items || [])
    .map(item => normalizeLoginId(item.login_key || item.login_id))
    .filter(Boolean))];
  if (!loginKeys.length) return new Map();
  const { data, error } = await supabase
    .from('bonus_done_daily')
    .select('id, bonus_date, login_key, bonus_type, bonus_status, claim_batch_id, pending_expires_at')
    .eq('bonus_date', dateValue)
    .eq('bonus_type', 'BONUS_HARIAN')
    .in('login_key', loginKeys);
  if (error) throw supabaseError(error);
  const map = new Map();
  (data || []).forEach(row => {
    const key = normalizeLoginId(row.login_key);
    if (!map.has(key)) map.set(key, row);
  });
  return map;
}

async function expirePendingBonusDoneRow(row, now) {
  await writeBonusDoneWithColumnFallback(
    {
      bonus_status: 'EXPIRED',
      updated_at: now,
      finalized_note: 'Auto expired sebelum reuse Hermes preview'
    },
    payload => supabase
      .from('bonus_done_daily')
      .update(payload)
      .eq('id', row.id)
      .eq('bonus_status', 'PENDING')
      .select('id')
      .maybeSingle()
  );
}

async function reuseExpiredBonusDoneRow(row, payload) {
  return writeBonusDoneWithColumnFallback(
    {
      ...payload,
      finalized_note: 'Reused expired row for new Hermes preview'
    },
    updatePayload => supabase
      .from('bonus_done_daily')
      .update(updatePayload)
      .eq('id', row.id)
      .eq('bonus_status', 'EXPIRED')
      .select('id, login_key, bonus_status, claim_batch_id, pending_expires_at')
      .maybeSingle()
  );
}

async function insertNewPendingBonusDoneRow(payload) {
  return writeBonusDoneWithColumnFallback(
    payload,
    insertPayload => supabase
      .from('bonus_done_daily')
      .insert(insertPayload)
      .select('id, login_key, bonus_status, claim_batch_id, pending_expires_at')
      .maybeSingle()
  );
}

async function insertNewPendingBonusDoneRows(payloads) {
  if (!payloads.length) return [];
  return writeBonusDoneBulkWithColumnFallback(
    payloads,
    insertPayloads => supabase
      .from('bonus_done_daily')
      .insert(insertPayloads)
      .select('id, login_key, bonus_status, claim_batch_id, pending_expires_at')
  );
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function reserveReadyItems({ items, dateValue, batchCode, source, ctx, existingRows = [] }) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = addDays(nowDate, 2);
  const pendingExpiresAt = isHermesSource(source) ? expiresAt : addMinutes(nowDate, 5);
  const claimOwner = 'HERMES-TELEGRAM';
  const operatorName = 'Hermes Telegram';

  const lockPayload = {
    bonus_date: dateValue,
    lock_status: 'PENDING',
    claim_owner: claimOwner,
    claim_batch_id: batchCode,
    operator_name: operatorName,
    started_at: now,
    updated_at: now,
    pending_expires_at: pendingExpiresAt,
    expires_at: expiresAt
  };
  const { error: lockError } = await supabase
    .from('bonus_process_locks')
    .insert(lockPayload);
  if (lockError) throw supabaseError(lockError);

  let existingByLoginKey = new Map();
  (existingRows || []).forEach(row => {
    const key = normalizeLoginId(row.login_key || row.login_id);
    if (key && !existingByLoginKey.has(key)) existingByLoginKey.set(key, row);
  });
  if (!existingByLoginKey.size && items.length) {
    const fetchStarted = Date.now();
    existingByLoginKey = await fetchExistingBonusDoneRows(items, dateValue);
    markTime(ctx, 'TIME_FETCH_EXISTING_MS', fetchStarted, {
      candidate_items: items.length,
      existing_rows: existingByLoginKey.size
    });
  }

  const classifyStarted = Date.now();
  const skipped = [];
  const reusable = [];
  const insertable = [];
  const seenReadyLoginKeys = new Set();
  for (const item of items) {
    const loginKey = normalizeLoginId(item.login_key || item.login_id);
    if (seenReadyLoginKeys.has(loginKey)) {
      skipped.push({
        ...item,
        status: 'FAILED',
        reason: 'DUPLICATE_LOGIN_IN_PREVIEW'
      });
      continue;
    }
    seenReadyLoginKeys.add(loginKey);
    const payload = pendingRowPayload({
      item,
      dateValue,
      batchCode,
      source,
      claimOwner,
      operatorName,
      now,
      pendingExpiresAt,
      expiresAt,
      finalizedNote: null
    });
    const existing = existingByLoginKey.get(loginKey);

    if (existing) {
      const status = String(existing.bonus_status || '').toUpperCase();
      const pendingMs = existing.pending_expires_at ? new Date(existing.pending_expires_at).getTime() : 0;
      if (status === 'DONE') {
        logReserveStep('SKIP_DONE', { login_key: loginKey, existing_id: existing.id });
        skipped.push({ ...item, status: 'SKIPPED_ALREADY_GIVEN', reason: 'SKIPPED_ALREADY_GIVEN' });
        continue;
      }
      if (status === 'PENDING' && pendingMs >= Date.now()) {
        logReserveStep('SKIP_PENDING_ACTIVE', {
          login_key: loginKey,
          existing_id: existing.id,
          source_claim_batch_id: existing.claim_batch_id || ''
        });
        skipped.push({
          ...item,
          status: 'PENDING_OTHER_BATCH',
          reason: 'PENDING_OTHER_BATCH',
          claim_batch_id: existing.claim_batch_id || ''
        });
        continue;
      }
      if (status === 'PENDING') {
        reusable.push({ item, existing: { ...existing, bonus_status: 'EXPIRED' }, payload, expiredPendingFirst: true });
        continue;
      } else if (status !== 'EXPIRED') {
        logReserveStep('SKIP_UNKNOWN_EXISTING_STATUS', {
          login_key: loginKey,
          existing_id: existing.id,
          existing_status: status
        });
        skipped.push({
          ...item,
          status: 'FAILED',
          reason: `EXISTING_STATUS_${status || 'EMPTY'}`
        });
        continue;
      }
      reusable.push({ item, existing, payload, expiredPendingFirst: false });
      continue;
    }

    insertable.push({ item, payload });
  }
  markTime(ctx, 'TIME_CLASSIFY_MS', classifyStarted, {
    reusable_rows: reusable.length,
    insert_rows: insertable.length,
    skipped_rows: skipped.length
  });

  const writeStarted = Date.now();
  const rows = [];
  const readyItems = [];

  const updatedRows = await mapWithConcurrency(reusable, RESERVE_UPDATE_CONCURRENCY, async entry => {
    const loginKey = normalizeLoginId(entry.item.login_key || entry.item.login_id);
    if (entry.expiredPendingFirst) await expirePendingBonusDoneRow(entry.existing, now);
    logReserveStep('REUSE_EXPIRED_ROW', { login_key: loginKey, existing_id: entry.existing.id, claim_batch_id: batchCode });
    const row = await reuseExpiredBonusDoneRow({ ...entry.existing, bonus_status: 'EXPIRED' }, entry.payload);
    return row ? { row, item: entry.item } : null;
  });
  updatedRows.filter(Boolean).forEach(entry => {
    rows.push(entry.row);
    readyItems.push(entry.item);
  });

  if (insertable.length) {
    insertable.forEach(entry => logReserveStep('INSERT_NEW_PENDING_ROW', {
      login_key: normalizeLoginId(entry.item.login_key || entry.item.login_id),
      claim_batch_id: batchCode
    }));
    const insertedRows = await insertNewPendingBonusDoneRows(insertable.map(entry => entry.payload));
    insertedRows.forEach((row, index) => {
      rows.push(row);
      if (insertable[index]) readyItems.push(insertable[index].item);
    });
  }
  markTime(ctx, 'TIME_RESERVE_UPDATE_MS', writeStarted, {
    updated_rows: updatedRows.filter(Boolean).length,
    inserted_rows: insertable.length,
    reserved_rows: rows.length
  });

  return { rows, readyItems, skipped, lock: lockPayload, pending_expires_at: pendingExpiresAt };
}

async function reserveEmptyHermesPreview({ dateValue, batchCode }) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = addDays(nowDate, 2);
  const { error } = await supabase
    .from('bonus_process_locks')
    .insert({
      bonus_date: dateValue,
      lock_status: 'EMPTY',
      claim_owner: 'HERMES-TELEGRAM',
      claim_batch_id: batchCode,
      operator_name: 'Hermes Telegram',
      started_at: now,
      updated_at: now,
      pending_expires_at: expiresAt,
      expires_at: expiresAt
    });
  if (error && error.code !== '23505') throw supabaseError(error);
  return {
    claim_batch_id: batchCode,
    pending_expires_at: expiresAt
  };
}

function previewStatusCounts(items) {
  return (items || []).reduce((acc, item) => {
    const key = String(item.status || 'EMPTY').toUpperCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizePreviewItem(item, status, reason, { batchCode, dateValue }) {
  const warning = item.warning || (status === 'MANUAL_REVIEW' ? reason : '');
  return {
    batch_code: batchCode,
    claim_batch_id: batchCode,
    bonus_date: item.bonus_date || dateValue,
    login_id: item.login_id || '',
    login_key: normalizeLoginId(item.login_key || item.login_id || ''),
    member_id: item.member_id || '',
    member_name: item.member_name || '',
    bonus_type: item.bonus_type || 'BONUS_HARIAN',
    amount_raw: Number(item.amount_raw || 0),
    amount_bo: Number(item.amount_bo || 0),
    remark: item.remark || item.note || '',
    note: item.note || item.remark || '',
    status,
    reason: reason || '',
    warning: warning || '',
    source_claim_batch_id: status === 'PENDING_OTHER_BATCH' ? (item.claim_batch_id || '') : '',
    raw_item: item
  };
}

function buildHermesPreviewItems({ readyItems, skippedItems, manualReviewItems, batchCode, dateValue }) {
  const manualKeys = new Set((manualReviewItems || []).map(item => normalizeLoginId(item.login_id)));
  const readyRows = (readyItems || [])
    .filter(item => !manualKeys.has(normalizeLoginId(item.login_id)))
    .map(item => normalizePreviewItem(item, 'READY', '', { batchCode, dateValue }));
  const skippedRows = (skippedItems || []).map(item => {
    const status = String(item.status || item.reason || 'SKIPPED').toUpperCase();
    return normalizePreviewItem(item, status, item.reason || status, { batchCode, dateValue });
  });
  const manualRows = (manualReviewItems || []).map(item => normalizePreviewItem(
    item,
    'MANUAL_REVIEW',
    item.reason || item.warning || 'MANUAL_REVIEW',
    { batchCode, dateValue }
  ));
  return [...readyRows, ...skippedRows, ...manualRows];
}

async function saveHermesPreviewSnapshot({ batch, dateValue, batchCode, previewItems, previewStatus }) {
  if (!isHermesSource(batch.source)) return null;
  const now = new Date().toISOString();
  const counts = previewStatusCounts(previewItems);
  const batchPayload = {
    batch_code: batchCode,
    claim_batch_id: batchCode,
    bonus_date: dateValue,
    source: FIXED_SOURCE,
    preview_status: previewStatus || 'WAITING_SUPERADMIN_APPROVAL',
    total_items: previewItems.length,
    ready_items: counts.READY || 0,
    skipped_already_given: counts.SKIPPED_ALREADY_GIVEN || 0,
    pending_other_batch: counts.PENDING_OTHER_BATCH || 0,
    manual_review_items: counts.MANUAL_REVIEW || 0,
    failed_items: counts.FAILED || 0,
    total_amount_bo: previewItems
      .filter(item => String(item.status || '').toUpperCase() === 'READY')
      .reduce((sum, item) => sum + Number(item.amount_bo || 0), 0),
    summary: batch.summary || {},
    updated_at: now
  };

  const { error: batchError } = await supabase
    .from('hermes_preview_batches')
    .upsert(batchPayload, { onConflict: 'claim_batch_id' });
  if (batchError) throw supabaseError(batchError, 'Gagal menyimpan header preview Hermes.');

  const { error: deleteError } = await supabase
    .from('hermes_preview_items')
    .delete()
    .eq('claim_batch_id', batchCode);
  if (deleteError) throw supabaseError(deleteError, 'Gagal membersihkan item preview Hermes lama.');

  if (previewItems.length) {
    const { error: itemError } = await supabase
      .from('hermes_preview_items')
      .insert(previewItems.map(item => ({ ...item, updated_at: now })));
    if (itemError) throw supabaseError(itemError, 'Gagal menyimpan item preview Hermes.');
  }

  return batchPayload;
}

async function buildAndReserveBonusBatch({ depositRaw, adjustmentRaw, bonusDate, source, ctx }) {
  if (!supabase) throw supabaseError(null, 'Konfigurasi Supabase belum lengkap.');
  const batch = buildBonusBatch({ depositRaw, adjustmentRaw, bonusDate, source });
  if (ctx.parse_started_ms) {
    markTime(ctx, 'TIME_PARSE_FILE_MS', ctx.parse_started_ms, {
      parsed_items: batch.items.length,
      skipped_items: batch.skipped.length
    });
    ctx.parse_started_ms = 0;
  }
  logStep(ctx, 'FILE_PARSED', {
    parsed_items: batch.items.length,
    skipped_items: batch.skipped.length,
    warnings: batch.warnings.length
  });
  const dateValue = batch.items[0]?.bonus_date || (isValidDate(bonusDate) ? bonusDate : getTodayJakartaInput());
  const batchCode = createBatchCode(dateValue);
  batch.batch_code = batchCode;

  ensureWithinDeadline(ctx);
  logStep(ctx, 'EXPIRE_PENDING_STARTED', { bonus_date: dateValue });
  const expireResult = await expireOldBonusPending();
  logStep(ctx, 'EXPIRE_PENDING_DONE', {
    expired_bonus_rows: expireResult.expired_bonus_rows || 0,
    expired_lock_rows: expireResult.expired_lock_rows || 0
  });
  ensureWithinDeadline(ctx);
  logStep(ctx, 'SUPABASE_HISTORY_STARTED', { bonus_date: dateValue });
  const historyStarted = Date.now();
  const candidateLoginKeys = batch.items.map(item => item.login_key || item.login_id);
  const existingRows = await fetchBonusStatusRows(dateValue, candidateLoginKeys);
  const activeLock = await fetchActivePendingLock(dateValue);
  markTime(ctx, 'TIME_FETCH_EXISTING_MS', historyStarted, {
    candidate_items: batch.items.length,
    existing_rows: existingRows.length
  });
  logStep(ctx, 'SUPABASE_HISTORY_DONE', {
    existing_rows: existingRows.length,
    active_lock: activeLock?.claim_batch_id || ''
  });
  const classifyStarted = Date.now();
  const classified = classifyReadyItems(batch.items, existingRows, activeLock);
  const readyLimited = classified.ready.slice(0, MAX_PREVIEW_ITEMS);
  const limitedItems = classified.ready.slice(MAX_PREVIEW_ITEMS);
  if (limitedItems.length) {
    classified.skipped.push(...limitedItems.map(item => ({
      ...item,
      status: 'SKIPPED_PREVIEW_LIMIT',
      reason: `PREVIEW_LIMIT_${MAX_PREVIEW_ITEMS}`
    })));
  }
  markTime(ctx, 'TIME_CLASSIFY_MS', classifyStarted, {
    ready_items: readyLimited.length,
    ready_before_limit: classified.ready.length,
    skipped_items: classified.skipped.length,
    manual_review_items: classified.manualReview.length
  });
  logStep(ctx, 'ELIGIBLE_CALCULATED', {
    ready_items: readyLimited.length,
    ready_before_limit: classified.ready.length,
    skipped_items: classified.skipped.length,
    manual_review_items: classified.manualReview.length
  });

  ensureWithinDeadline(ctx);
  batch.skipped = [...batch.skipped, ...classified.skipped];
  batch.warnings = [...batch.warnings];
  batch.items = readyLimited;
  batch.summary = {
    ...batch.summary,
    expired_bonus_rows: expireResult.expired_bonus_rows || 0,
    expired_lock_rows: expireResult.expired_lock_rows || 0,
    total_eligible_from_deposit: readyLimited.length + classified.skipped.length,
    ready_items: readyLimited.length,
    ready_items_before_limit: classified.ready.length,
    preview_limit: MAX_PREVIEW_ITEMS,
    preview_limited_items: limitedItems.length,
    skipped_already_given: classified.skipped.filter(item => item.reason === 'SKIPPED_ALREADY_GIVEN').length,
    pending_other_batch: classified.skipped.filter(item => item.reason === 'PENDING_OTHER_BATCH').length,
    expired_released: classified.expiredReleased + (expireResult.expired_bonus_rows || 0),
    manual_review_items: classified.manualReview.length,
    total_amount_bo_ready: readyLimited.reduce((sum, item) => sum + Number(item.amount_bo || 0), 0),
    total_items: readyLimited.length,
    total_amount_raw: readyLimited.reduce((sum, item) => sum + Number(item.amount_raw || 0), 0),
    total_amount_bo: readyLimited.reduce((sum, item) => sum + Number(item.amount_bo || 0), 0),
    skipped_items: batch.skipped.length
  };
  const previewItems = buildHermesPreviewItems({
    readyItems: readyLimited,
    skippedItems: batch.skipped,
    manualReviewItems: classified.manualReview,
    batchCode,
    dateValue
  });

  logStep(ctx, 'PREVIEW_SAVE_STARTED', {
    bonus_date: dateValue,
    claim_batch_id: batchCode,
    ready_items: readyLimited.length,
    preview_items: previewItems.length
  });

  ensureWithinDeadline(ctx);
  if (isHermesSource(source)) {
    const previewSaveStarted = Date.now();
    const snapshot = await saveHermesPreviewSnapshot({
      batch,
      dateValue,
      batchCode,
      previewItems,
      previewStatus: 'WAITING_SUPERADMIN_APPROVAL'
    });
    markTime(ctx, 'TIME_PREVIEW_SAVE_MS', previewSaveStarted, {
      preview_items: previewItems.length
    });
    logStep(ctx, 'PREVIEW_SAVE_DONE', {
      claim_batch_id: batchCode,
      saved_rows: 0,
      preview_items: previewItems.length,
      lock_status: 'PREVIEW_ONLY'
    });
    batch.items = readyLimited.map(item => ({
      ...item,
      status: 'READY',
      claim_batch_id: batchCode
    }));
    return {
      batch,
      should_create_task: false,
      needs_superadmin_approval: true,
      preview_status: 'WAITING_SUPERADMIN_APPROVAL',
      claim_batch_id: batchCode,
      skipped: batch.skipped,
      manual_review: classified.manualReview,
      preview_snapshot: snapshot
    };
  }

  if (readyLimited.length === 0) {
    return {
      batch,
      should_create_task: false,
      needs_superadmin_approval: false,
      preview_status: '',
      claim_batch_id: batchCode,
      skipped: batch.skipped,
      manual_review: classified.manualReview
    };
  }

  const reserve = await reserveReadyItems({
    items: readyLimited,
    dateValue,
    batchCode,
    source: source || 'hermes_telegram',
    ctx,
    existingRows
  });
  if (reserve.skipped.length) {
    batch.skipped = [...batch.skipped, ...reserve.skipped];
  }
  const reservedReadyItems = reserve.readyItems || [];
  batch.summary = {
    ...batch.summary,
    ready_items: reservedReadyItems.length,
    total_amount_bo_ready: reservedReadyItems.reduce((sum, item) => sum + Number(item.amount_bo || 0), 0),
    total_items: reservedReadyItems.length,
    total_amount_raw: reservedReadyItems.reduce((sum, item) => sum + Number(item.amount_raw || 0), 0),
    total_amount_bo: reservedReadyItems.reduce((sum, item) => sum + Number(item.amount_bo || 0), 0),
    skipped_already_given: batch.skipped.filter(item => item.reason === 'SKIPPED_ALREADY_GIVEN').length,
    pending_other_batch: batch.skipped.filter(item => item.reason === 'PENDING_OTHER_BATCH').length,
    skipped_items: batch.skipped.length
  };
  const reservedPreviewItems = buildHermesPreviewItems({
    readyItems: reservedReadyItems,
    skippedItems: batch.skipped,
    manualReviewItems: classified.manualReview,
    batchCode,
    dateValue
  });
  if (reservedReadyItems.length === 0) {
    await supabase
      .from('bonus_process_locks')
      .update({ lock_status: 'EMPTY', updated_at: new Date().toISOString() })
      .eq('claim_batch_id', batchCode);
    const previewSaveStarted = Date.now();
    const snapshot = await saveHermesPreviewSnapshot({
      batch,
      dateValue,
      batchCode,
      previewItems: reservedPreviewItems,
      previewStatus: isHermesSource(source) ? 'WAITING_SUPERADMIN_APPROVAL' : 'PREVIEW'
    });
    markTime(ctx, 'TIME_PREVIEW_SAVE_MS', previewSaveStarted, {
      preview_items: reservedPreviewItems.length
    });
    logStep(ctx, 'PREVIEW_SAVE_DONE', {
      claim_batch_id: batchCode,
      saved_rows: 0,
      preview_items: reservedPreviewItems.length,
      lock_status: 'EMPTY'
    });
    batch.items = [];
    return {
      batch,
      should_create_task: false,
      needs_superadmin_approval: isHermesSource(source),
      preview_status: isHermesSource(source) ? 'WAITING_SUPERADMIN_APPROVAL' : '',
      claim_batch_id: batchCode,
      skipped: batch.skipped,
      manual_review: classified.manualReview,
      preview_snapshot: snapshot,
      reserve
    };
  }
  const previewSaveStarted = Date.now();
  const snapshot = await saveHermesPreviewSnapshot({
    batch,
    dateValue,
    batchCode,
    previewItems: reservedPreviewItems,
    previewStatus: isHermesSource(source) ? 'WAITING_SUPERADMIN_APPROVAL' : 'PREVIEW'
  });
  markTime(ctx, 'TIME_PREVIEW_SAVE_MS', previewSaveStarted, {
    preview_items: reservedPreviewItems.length
  });
  logStep(ctx, 'PREVIEW_SAVE_DONE', {
    claim_batch_id: batchCode,
    saved_rows: reserve.rows.length,
    preview_items: reservedPreviewItems.length,
    lock_status: 'PENDING'
  });

  batch.items = reservedReadyItems.map(item => ({
    ...item,
    status: 'READY',
    claim_batch_id: batchCode,
    pending_expires_at: reserve.pending_expires_at
  }));

  return {
    batch,
    should_create_task: !isHermesSource(source),
    needs_superadmin_approval: isHermesSource(source),
    preview_status: isHermesSource(source) ? 'WAITING_SUPERADMIN_APPROVAL' : '',
    claim_batch_id: batchCode,
    skipped: batch.skipped,
    manual_review: classified.manualReview,
    reserve,
    preview_snapshot: snapshot
  };
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      throw parserError('PAYLOAD_TOO_LARGE', 'Ukuran upload terlalu besar. Maksimal 10MB.', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    parts.push(buffer.slice(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.slice(start));
  return parts;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('Boundary multipart tidak ditemukan.');
  const boundaryValue = String(boundaryMatch[1] || boundaryMatch[2] || '').trim();
  const boundary = Buffer.from(`--${boundaryValue}`);
  const parts = splitBuffer(buffer, boundary);
  const fields = {};
  const files = {};

  parts.forEach(part => {
    let chunk = part;
    if (chunk.length === 0) return;
    if (chunk.slice(0, 2).toString() === '\r\n') chunk = chunk.slice(2);
    if (chunk.slice(0, 1).toString() === '\n') chunk = chunk.slice(1);
    if (chunk.slice(-2).toString() === '\r\n') chunk = chunk.slice(0, -2);
    if (chunk.slice(-1).toString() === '\n') chunk = chunk.slice(0, -1);
    if (chunk.toString() === '--') return;
    if (chunk.slice(-2).toString() === '--') chunk = chunk.slice(0, -2);

    let headerEnd = chunk.indexOf(Buffer.from('\r\n\r\n'));
    let separatorLength = 4;
    if (headerEnd === -1) {
      headerEnd = chunk.indexOf(Buffer.from('\n\n'));
      separatorLength = 2;
    }
    if (headerEnd === -1) return;
    const headerText = chunk.slice(0, headerEnd).toString('utf8');
    let content = chunk.slice(headerEnd + separatorLength);
    if (content.slice(-2).toString() === '\r\n') content = content.slice(0, -2);
    if (content.slice(-1).toString() === '\n') content = content.slice(0, -1);

    const nameMatch = headerText.match(/name=(?:"([^"]+)"|([^;\r\n]+))/i);
    if (!nameMatch) return;
    const filenameMatch = headerText.match(/filename\*?=(?:UTF-8''|)(?:"([^"]*)"|([^;\r\n]*))/i);
    const name = String(nameMatch[1] || nameMatch[2] || '').trim();
    const filename = filenameMatch ? decodeURIComponent(String(filenameMatch[1] || filenameMatch[2] || '').trim()) : '';
    if (filenameMatch) {
      files[name] = {
        filename,
        buffer: content
      };
    } else {
      fields[name] = content.toString('utf8').trim();
    }
  });

  return { fields, files };
}

function multipartPartFromField(files, fields, fieldName) {
  if (files[fieldName] && files[fieldName].buffer && files[fieldName].buffer.length > 0) return files[fieldName];
  if (fields[fieldName]) {
    return {
      filename: `${fieldName}.txt`,
      buffer: Buffer.from(String(fields[fieldName]), 'utf8')
    };
  }
  return null;
}

async function fileBufferToText(file, fieldName) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    if (fieldName === 'deposit_file') {
      throw parserError('DEPOSIT_FILE_REQUIRED', 'deposit_file wajib diisi.', 400);
    }
    return '';
  }
  if (/\.xlsx$/i.test(file.filename || '')) {
    try {
      if (file.buffer.slice(0, 2).toString('utf8') !== 'PK') {
        throw new Error('File bukan format XLSX valid.');
      }
      const xlsx = await import('xlsx');
      const workbook = xlsx.read(file.buffer, { type: 'buffer', cellDates: false });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!firstSheet) throw new Error('Workbook tidak memiliki sheet.');
      const text = xlsx.utils.sheet_to_csv(firstSheet, { FS: ',', blankrows: false });
      if (!String(text || '').trim()) throw new Error('Sheet kosong atau tidak bisa dikonversi.');
      return text;
    } catch (error) {
      throw parserError('XLSX_PARSE_FAILED', `Gagal membaca XLSX: ${safeErrorMessage(error)}`, 400);
    }
  }
  try {
    return file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw parserError('CSV_PARSE_FAILED', `Gagal membaca CSV: ${safeErrorMessage(error)}`, 400);
  }
}

async function processGenerateJson(req, ctx) {
  logStep(ctx, 'REQUEST_RECEIVED', {
    method: req.method,
    url: req.url || ''
  });

  if (req.method !== 'POST') {
    throw parserError('METHOD_NOT_ALLOWED', 'Method harus POST.', 405);
  }

  if (!assertAuth(req)) {
    throw parserError('UNAUTHORIZED', 'Token Hermes Parser tidak valid.', 401);
  }
  logStep(ctx, 'AUTH_OK');

  const contentType = req.headers['content-type'] || req.headers['Content-Type'] || '';
  if (!/multipart\/form-data/i.test(String(contentType))) {
    throw parserError('INVALID_CONTENT_TYPE', 'Gunakan multipart/form-data.', 400);
  }
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    throw parserError('PAYLOAD_TOO_LARGE', 'Ukuran upload terlalu besar. Maksimal 10MB.', 413);
  }

  const bodyBuffer = await readRequestBody(req);
  const { fields, files } = parseMultipart(bodyBuffer, contentType);
  const fileSummary = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, {
    filename: file.filename || '',
    size: file.buffer ? file.buffer.length : 0,
    type: detectUploadType(file)
  }]));
  logStep(ctx, 'MULTIPART_PARSED', {
    content_type: String(contentType || '').split(';')[0],
    file_fields: Object.keys(files),
    text_fields: Object.keys(fields),
    files: fileSummary
  });
  const mode = String(fields.mode || '').trim();
  const source = String(fields.source || FIXED_SOURCE).trim();

  if (mode && mode !== 'BONUS_HARIAN') {
    throw parserError('INVALID_MODE', 'mode harus BONUS_HARIAN.', 400);
  }
  if (source && source !== FIXED_SOURCE) {
    throw parserError('INVALID_SOURCE', 'source harus hermes-telegram.', 400);
  }
  if (isHermesSource(source || FIXED_SOURCE)) {
    throw parserError('HERMES_DISABLED', 'Integrasi Hermes sudah dinonaktifkan.', 410);
  }

  const depositPart = multipartPartFromField(files, fields, 'deposit_file');
  const adjustmentPart = multipartPartFromField(files, fields, 'adjustment_file');
  logStep(ctx, 'FILE_RECEIVED', {
    deposit_filename: depositPart?.filename || '',
    deposit_size: depositPart?.buffer?.length || 0,
    adjustment_filename: adjustmentPart?.filename || '',
    adjustment_size: adjustmentPart?.buffer?.length || 0
  });
  logStep(ctx, 'FILE_TYPE_DETECTED', {
    deposit_type: detectUploadType(depositPart),
    adjustment_type: detectUploadType(adjustmentPart)
  });
  ctx.parse_started_ms = Date.now();
  const depositRaw = await fileBufferToText(depositPart, 'deposit_file');
  const adjustmentRaw = adjustmentPart ? await fileBufferToText(adjustmentPart, 'adjustment_file') : '';
  const bonusDate = String(fields.bonus_date || '').trim();

  if (bonusDate && !isValidDate(bonusDate)) {
    throw parserError('INVALID_BONUS_DATE', 'bonus_date harus YYYY-MM-DD.', 400);
  }

  try {
    const result = await buildAndReserveBonusBatch({
      depositRaw,
      adjustmentRaw,
      bonusDate,
      source,
      ctx
    });
    result.source = source || FIXED_SOURCE;
    return result;
  } catch (error) {
    if (error?.code === 'SUPABASE_ERROR') throw error;
    const fileType = detectUploadType(depositPart);
    if (fileType === 'xlsx') {
      throw parserError('XLSX_PARSE_FAILED', `Gagal membaca XLSX: ${safeErrorMessage(error)}`, 400);
    }
    throw parserError('CSV_PARSE_FAILED', `Gagal membaca CSV: ${safeErrorMessage(error)}`, 400);
  }
}

function buildSuccessResponse(result, source, ctx) {
  const { batch } = result;
  ctx.timings.TIME_TOTAL_MS = Date.now() - ctx.started_ms;

  if (!batch.items.length) {
    logStep(ctx, 'RESPONSE_READY', {
      ok: true,
      ready_items: 0,
      should_create_task: false
    });
    return {
      status: 200,
      body: {
        ok: true,
        source,
        should_create_task: false,
        needs_superadmin_approval: result.needs_superadmin_approval || false,
        preview_status: result.preview_status || '',
        batch_code: batch.batch_code,
        claim_batch_id: result.claim_batch_id || batch.batch_code,
        message: 'Tidak ada item READY untuk diproses.',
        summary: batch.summary,
        batch,
        skipped: result.skipped || batch.skipped || [],
        manual_review: result.manual_review || [],
        timings: ctx.timings
      }
    };
  }

  const batchFile = `batch-adjustment-${batch.batch_code}.json`;
  logStep(ctx, 'RESPONSE_READY', {
    ok: true,
    ready_items: batch.items.length,
    should_create_task: result.should_create_task === true
  });

  return {
    status: 200,
    body: {
      ok: true,
      source,
      should_create_task: result.should_create_task === true,
      needs_superadmin_approval: result.needs_superadmin_approval || false,
      preview_status: result.preview_status || '',
      batch_code: batch.batch_code,
      claim_batch_id: result.claim_batch_id || batch.batch_code,
      batch_file: batchFile,
      summary: batch.summary,
      batch,
      skipped: result.skipped || batch.skipped || [],
      manual_review: result.manual_review || [],
      timings: ctx.timings
    }
  };
}

export default async function handler(req, res) {
  const ctx = createRequestContext();
  let timeoutId = null;
  let responded = false;

  const send = (status, body) => {
    responded = json(res, status, body) || responded;
    return responded;
  };

  timeoutId = setTimeout(() => {
    send(504, {
      ok: false,
      error: 'PARSER_TIMEOUT',
      message: 'Generate preview melebihi batas waktu.',
      last_step: ctx.last_step,
      request_id: ctx.request_id,
      timings: {
        ...ctx.timings,
        TIME_TOTAL_MS: Date.now() - ctx.started_ms
      }
    });
  }, GENERATE_TIMEOUT_MS);

  try {
    const result = await processGenerateJson(req, ctx);
    clearTimeout(timeoutId);
    if (responded) return;
    const response = buildSuccessResponse(result, result.source || FIXED_SOURCE, ctx);
    return send(response.status, response.body);
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('generate-json parser error:', {
      request_id: ctx.request_id,
      last_step: ctx.last_step,
      error: error?.code || 'PARSER_FAILED',
      message: error?.message || '',
      supabase_error: error?.supabase_error || null
    });
    if (responded) return;
    const response = responseFromError(error, ctx);
    return send(response.status, response.body);
  }
}
