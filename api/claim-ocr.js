const OCR_ENDPOINT = 'https://api.ocr.space/parse/image';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const config = {
  api: {
    bodyParser: false
  }
};

function json(res, status, body) {
  return res.status(status).json(body);
}

function getHeader(req, name) {
  const lower = name.toLowerCase();
  return req.headers[lower] || req.headers[name] || '';
}

async function readRequestBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');

  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('File terlalu besar. Maksimal gambar 5MB.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function parseContentDisposition(value) {
  const result = {};
  String(value || '').split(';').forEach(part => {
    const [key, ...rest] = part.trim().split('=');
    if (!key || !rest.length) return;
    result[key.toLowerCase()] = rest.join('=').replace(/^"|"$/g, '');
  });
  return result;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error('Format upload tidak valid.');
    error.statusCode = 400;
    throw error;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const raw = buffer.toString('binary');
  const parts = raw.split(`--${boundary}`);
  const fields = {};
  const files = {};

  for (let part of parts) {
    if (!part || part === '--' || part === '--\r\n') continue;
    if (part.startsWith('\r\n')) part = part.slice(2);
    if (part.endsWith('\r\n')) part = part.slice(0, -2);
    if (part.endsWith('--')) part = part.slice(0, -2);

    const separatorIndex = part.indexOf('\r\n\r\n');
    if (separatorIndex < 0) continue;

    const headerText = part.slice(0, separatorIndex);
    let contentBinary = part.slice(separatorIndex + 4);
    if (contentBinary.endsWith('\r\n')) contentBinary = contentBinary.slice(0, -2);

    const headers = {};
    headerText.split('\r\n').forEach(line => {
      const splitAt = line.indexOf(':');
      if (splitAt < 0) return;
      headers[line.slice(0, splitAt).trim().toLowerCase()] = line.slice(splitAt + 1).trim();
    });

    const disposition = parseContentDisposition(headers['content-disposition']);
    if (!disposition.name) continue;

    const content = Buffer.from(contentBinary, 'binary');
    if (disposition.filename) {
      files[disposition.name] = {
        fieldName: disposition.name,
        fileName: disposition.filename,
        mimeType: headers['content-type'] || 'application/octet-stream',
        buffer: content
      };
    } else {
      fields[disposition.name] = content.toString('utf8');
    }
  }

  return { fields, files };
}

export function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[|]/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function cleanMoneyText(value) {
  return String(value || '')
    .replace(/\b(?:rp|ap|ro|rd|bp)\b/ig, '')
    .replace(/\s+/g, '')
    .replace(/[^\d,.-]/g, '')
    .trim();
}

function hasThousandStyle(value) {
  const raw = String(value || '');
  const cleaned = cleanMoneyText(raw);
  return /\b(?:rp|ap|ro|rd|bp)\b/i.test(raw) || /\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(cleaned);
}

function parseIndonesianMoney(value) {
  let text = cleanMoneyText(value);
  if (!text) return NaN;

  const negative = /^-/.test(text);
  text = text.replace(/^-/, '');
  const hasComma = text.includes(',');
  const hasDot = text.includes('.');

  if (hasComma && hasDot) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    text = text.replace(',', '.');
  } else if (hasDot && /^\d{1,3}(?:\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, '');
  }

  const num = Number(text);
  if (!Number.isFinite(num)) return NaN;
  return negative ? -num : num;
}

export function normalizeWinToBaseAmount(value) {
  const amount = parseIndonesianMoney(value);
  if (!Number.isFinite(amount)) return NaN;
  if (hasThousandStyle(value)) return Math.floor(amount / 1000);
  return Math.floor(amount);
}

function parseBetUnit(value) {
  const amount = parseIndonesianMoney(value);
  if (!Number.isFinite(amount)) return NaN;
  if (hasThousandStyle(value)) return Math.floor(amount / 1000);
  return amount;
}

function formatThousands(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return new Intl.NumberFormat('id-ID').format(Math.round(num));
}

export function parseBetToBettOutput(value) {
  const amount = parseIndonesianMoney(value);
  if (!Number.isFinite(amount)) return '';

  if (hasThousandStyle(value)) return formatThousands(amount);
  if (amount < 1000) return formatThousands(amount * 1000);
  return formatThousands(amount);
}

export function parseMoneyToThousandsBase(value) {
  return normalizeWinToBaseAmount(value);
}

function isLikelyNoiseLine(line) {
  return /(?:kb\/d|chrome|https?:|verify|pilih|klik|tampilkan|baterai|lte|gmt|hari ini|riwayat permainan|saldo baru|tanggal|waktu|transaksi|taruhan|surplus|jumlah dimenangkan|id sesi bermain)/i.test(line);
}

export function extractTicketId(text) {
  const normalized = normalizeOcrText(text);
  const lines = normalized.split('\n');
  const candidates = [];

  const directMatches = normalized.match(/\b\d{10,20}\b/g) || [];
  directMatches.forEach(match => candidates.push(match));

  const digitLines = lines
    .map(line => ({ line, digits: line.replace(/\D/g, '') }))
    .filter(item => item.digits.length >= 5 && item.digits.length <= 20)
    .filter(item => !isLikelyNoiseLine(item.line))
    .filter(item => !/(?:rp|,|\.|:)/i.test(item.line));

  for (let index = 0; index < digitLines.length; index += 1) {
    const current = digitLines[index].digits;
    if (current.length >= 10 && current.length <= 20) candidates.push(current);

    const next = digitLines[index + 1] ? digitLines[index + 1].digits : '';
    if (next) {
      const combined = `${current}${next}`;
      if (combined.length >= 10 && combined.length <= 20) candidates.push(combined);
    }
  }

  const unique = [...new Set(candidates)]
    .filter(value => value.length >= 10 && value.length <= 20)
    .filter(value => !/^0+$/.test(value))
    .sort((a, b) => b.length - a.length);

  return unique[0] || '';
}

export function extractTicketIds(text) {
  const normalized = normalizeOcrText(text);
  const lines = normalized.split('\n');
  const candidates = [];

  lines.forEach(line => {
    if (isLikelyNoiseLine(line)) return;
    if (/[A-Za-z]/.test(line.replace(/\b(?:id|sesi|bermain)\b/ig, ''))) return;
    const matches = line.match(/\b\d{10,20}\b/g) || [];
    matches.forEach(match => candidates.push(match));
  });

  const digitLines = lines
    .map(line => ({ line, digits: line.replace(/\D/g, '') }))
    .filter(item => item.digits.length >= 5 && item.digits.length <= 20)
    .filter(item => !isLikelyNoiseLine(item.line))
    .filter(item => !/(?:rp|ap|ro|rd|bp|,|\.|:)/i.test(item.line))
    .filter(item => !/[A-Za-z]/.test(item.line));

  for (let index = 0; index < digitLines.length; index += 1) {
    const current = digitLines[index].digits;
    if (current.length >= 10 && current.length <= 20) candidates.push(current);
    const next = digitLines[index + 1] ? digitLines[index + 1].digits : '';
    if (next) {
      const combined = `${current}${next}`;
      if (combined.length >= 10 && combined.length <= 20) candidates.push(combined);
    }
  }

  return [...new Set(candidates)]
    .filter(value => value.length >= 10 && value.length <= 20)
    .filter(value => !/^0+$/.test(value));
}

export function extractMoneyCandidates(text) {
  const normalized = normalizeOcrText(text);
  const matches = normalized.split('\n').flatMap(line => {
    const hasMoneyPrefix = /\b(?:rp|ap|ro|rd|bp)\b/i.test(line);
    const looksLikeDateTime = /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(line) || /\b\d{1,2}[.:]\d{2}(?:[.:]\d{2})?\b/.test(line);
    if (!hasMoneyPrefix && looksLikeDateTime) return [];
    return line.match(/-?\s*(?:(?:Rp|Ap|Ro|RD|Bp)\s*)?\d{1,3}(?:\.\d{3})+(?:[,.]\d+)?|-?\s*(?:(?:Rp|Ap|Ro|RD|Bp)\s*)?\d+(?:[,.]\d+)?/gi) || [];
  });
  return [...new Set(matches
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(item => {
      const cleaned = cleanMoneyText(item);
      return /\b(?:rp|ap|ro|rd|bp)\b/i.test(item) || cleaned.includes(',') || /\d{1,3}(?:\.\d{3})+/.test(cleaned);
    }))];
}

function moneyAmountKey(value) {
  const amount = parseIndonesianMoney(value);
  return Number.isFinite(amount) ? String(amount) : '';
}

export function extractBet(text) {
  const normalized = normalizeOcrText(text);
  const lines = normalized.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    if (!/(taruhan|bet)/i.test(lines[index])) continue;
    const windowText = lines.slice(index, index + 4).join('\n');
    const candidates = extractMoneyCandidates(windowText)
      .filter(value => parseIndonesianMoney(value) > 0);
    if (candidates.length) return candidates[0];
  }

  const candidates = extractMoneyCandidates(normalized)
    .filter(value => parseIndonesianMoney(value) > 0)
    .filter(value => {
      const digits = value.replace(/\D/g, '');
      return digits.length < 10;
    })
    .sort((a, b) => parseIndonesianMoney(a) - parseIndonesianMoney(b));

  return candidates[0] || '';
}

export function extractWinCandidates(text) {
  const normalized = normalizeOcrText(text);
  const lines = normalized.split('\n');
  let scoped = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/(surplus|jumlah dimenangkan|dimenangkan|menang|win)/i.test(lines[index])) continue;
    const windowText = lines.slice(index, index + 8).join('\n');
    scoped = scoped.concat(extractMoneyCandidates(windowText));
  }

  const all = (scoped.length ? scoped : extractMoneyCandidates(normalized))
    .filter(value => parseIndonesianMoney(value) > 0)
    .filter(value => {
      const digits = value.replace(/\D/g, '');
      return digits.length < 10;
    });

  const bet = extractBet(normalized);
  const betKey = moneyAmountKey(bet);
  const filtered = all.filter(value => moneyAmountKey(value) !== betKey);
  return [...new Set(filtered.length ? filtered : all)];
}

export function pickSmallestPositiveWin(values) {
  const candidates = (Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .map(value => ({ raw: value, base: normalizeWinToBaseAmount(value) }))
    .filter(item => Number.isFinite(item.base) && item.base > 0)
    .sort((a, b) => a.base - b.base);

  return candidates[0] ? candidates[0].raw : '';
}

function detectProvider(rawText, requestedProvider = '') {
  const requested = String(requestedProvider || '').trim().toUpperCase();
  if (requested === 'PG' || requested === 'PRAGMATIC') return requested;
  const normalized = normalizeOcrText(rawText);
  if (/(gates of olympus|sweet bonanza|starlight princess|pragmatic|super scatter|id sesi bermain|jumlah dimenangkan)/i.test(normalized)) {
    return 'PRAGMATIC';
  }
  return 'PG';
}

function normalizeMoneyLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\b(?:ap|ro|rd|bp)\b/ig, 'Rp').replace(/\s+/g, ' ');
}

function buildPragmaticDetectedRows(ticketIds, balances, bets, wins) {
  const rowCount = Math.max(ticketIds.length, bets.length, wins.length, 1);
  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const bet = bets[index] || '';
    const win = wins[index] || '';
    const baseAmount = normalizeWinToBaseAmount(win);
    rows.push({
      row_index: index,
      ticket_id: ticketIds[index] || '',
      balance: balances[index] || '',
      bet,
      bett_output: parseBetToBettOutput(bet),
      win,
      base_amount: Number.isFinite(baseAmount) ? baseAmount : null
    });
  }
  return rows;
}

export function parsePragmaticHistoryOcr(rawText) {
  const normalized = normalizeOcrText(rawText);
  const ticketIds = extractTicketIds(normalized);
  const moneyValues = extractMoneyCandidates(normalized)
    .map(normalizeMoneyLabel)
    .filter(value => parseIndonesianMoney(value) >= 0);

  const ticketCount = Math.max(ticketIds.length, 1);
  let balances = [];
  let bets = [];
  let wins = [];

  if (moneyValues.length >= ticketCount * 3) {
    balances = moneyValues.slice(0, ticketCount);
    bets = moneyValues.slice(ticketCount, ticketCount * 2);
    wins = moneyValues.slice(ticketCount * 2, ticketCount * 3);
  } else if (moneyValues.length >= 3) {
    balances = [moneyValues[0]];
    bets = [moneyValues[1]];
    wins = moneyValues.slice(2);
  } else if (moneyValues.length >= 2) {
    bets = [moneyValues[0]];
    wins = [moneyValues[1]];
  } else {
    wins = moneyValues;
  }

  wins = wins.filter(value => parseIndonesianMoney(value) > 0);
  bets = bets.filter(value => parseIndonesianMoney(value) > 0);

  const detectedRows = buildPragmaticDetectedRows(ticketIds, balances, bets, wins);
  const selectedRow = detectedRows[0] || {};
  const ticket_id = selectedRow.ticket_id || ticketIds[0] || '';
  const bet = selectedRow.bet || bets[0] || '';
  const selected_win = selectedRow.win || wins[0] || '';
  const base_amount = normalizeWinToBaseAmount(selected_win);

  return {
    provider: 'PRAGMATIC',
    ticket_id,
    bet,
    bett_output: parseBetToBettOutput(bet),
    win_candidates: wins,
    selected_win,
    base_amount: Number.isFinite(base_amount) ? base_amount : null,
    detected_provider: 'PRAGMATIC',
    parser_used: 'parsePragmaticHistoryOcr',
    selected_row_index: selectedRow.row_index || 0,
    ticket_ids: ticketIds,
    bet_candidates: bets,
    win_list: wins,
    debug: {
      ticket_list: ticketIds,
      bet_list: bets,
      win_list: wins
    },
    detected_rows: detectedRows
  };
}

export function parsePgHistoryOcr(rawText) {
  const normalized = normalizeOcrText(rawText);
  const ticket_id = extractTicketId(normalized);
  const bet = extractBet(normalized);
  const bett_output = parseBetToBettOutput(bet);
  const win_candidates = extractWinCandidates(normalized);
  const selected_win = pickSmallestPositiveWin(win_candidates);
  const base_amount = normalizeWinToBaseAmount(selected_win);

  return {
    provider: 'PG',
    ticket_id,
    bet,
    bett_output,
    win_candidates,
    selected_win,
    base_amount: Number.isFinite(base_amount) ? base_amount : null,
    detected_provider: 'PG',
    parser_used: 'parsePgHistoryOcr',
    selected_row_index: 0,
    ticket_ids: extractTicketIds(normalized),
    bet_candidates: bet ? [bet] : [],
    win_list: win_candidates,
    debug: {
      ticket_list: extractTicketIds(normalized),
      bet_list: bet ? [bet] : [],
      win_list: win_candidates
    },
    detected_rows: [{
      row_index: 0,
      ticket_id,
      bet,
      bett_output,
      win: selected_win,
      base_amount: Number.isFinite(base_amount) ? base_amount : null
    }]
  };
}

export function parseGenericHistoryOcr(rawText) {
  return parsePgHistoryOcr(rawText);
}

export function parseHistoryOcr(rawText, provider = '') {
  const normalized = normalizeOcrText(rawText);
  const detectedProvider = detectProvider(normalized, provider);
  if (detectedProvider === 'PRAGMATIC') {
    return parsePragmaticHistoryOcr(normalized);
  }
  if (detectedProvider === 'PG') return parsePgHistoryOcr(normalized);
  return parseGenericHistoryOcr(normalized);
}

async function callOcrApi(fileBuffer, fileName, mimeType) {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    const error = new Error('OCR API key belum dikonfigurasi di server.');
    error.code = 'OCR_API_KEY_MISSING';
    error.statusCode = 500;
    throw error;
  }

  if (typeof fetch !== 'function' || typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    const error = new Error('Runtime server belum mendukung OCR upload.');
    error.code = 'OCR_RUNTIME_UNAVAILABLE';
    error.statusCode = 500;
    throw error;
  }

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeType }), fileName || 'history.png');
  form.append('language', 'eng');
  form.append('isOverlayRequired', 'false');
  form.append('detectOrientation', 'true');
  form.append('scale', 'true');
  form.append('OCREngine', '2');

  const response = await fetch(OCR_ENDPOINT, {
    method: 'POST',
    headers: {
      apikey: apiKey
    },
    body: form
  });

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    const parseError = new Error('OCR gagal membaca history. Silakan isi manual.');
    parseError.code = 'OCR_FAILED';
    parseError.raw = raw;
    throw parseError;
  }

  if (!response.ok || data.IsErroredOnProcessing) {
    const message = Array.isArray(data.ErrorMessage)
      ? data.ErrorMessage.join(' ')
      : data.ErrorMessage || data.ErrorDetails || 'OCR gagal membaca history. Silakan isi manual.';
    const error = new Error(message);
    error.code = 'OCR_FAILED';
    error.raw = raw;
    throw error;
  }

  return data;
}

function parseOcrResponse(response) {
  const text = (response.ParsedResults || [])
    .map(result => result && result.ParsedText ? result.ParsedText : '')
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text) {
    const error = new Error('OCR gagal membaca history. Silakan isi manual.');
    error.code = 'OCR_FAILED';
    throw error;
  }

  return text;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, {
        ok: false,
        error: 'METHOD_NOT_ALLOWED',
        message: 'Method tidak diizinkan.'
      });
    }

    const contentLength = Number(getHeader(req, 'content-length') || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return json(res, 413, {
        ok: false,
        error: 'FILE_TOO_LARGE',
        message: 'File terlalu besar. Maksimal gambar 5MB.'
      });
    }

    const contentType = getHeader(req, 'content-type');
    if (!/multipart\/form-data/i.test(String(contentType))) {
      return json(res, 400, {
        ok: false,
        error: 'INVALID_CONTENT_TYPE',
        message: 'Upload harus memakai multipart/form-data.'
      });
    }

    const bodyBuffer = await readRequestBuffer(req);
    const { fields, files } = parseMultipart(bodyBuffer, contentType);
    const historyImage = files.ocr_image || files.history_image;

    if (!historyImage) {
      return json(res, 400, {
        ok: false,
        error: 'FILE_REQUIRED',
        message: 'Gambar history wajib diupload.'
      });
    }

    if (!ALLOWED_MIME_TYPES.has(String(historyImage.mimeType).toLowerCase())) {
      return json(res, 400, {
        ok: false,
        error: 'INVALID_FILE_TYPE',
        message: 'Format gambar harus JPG, PNG, atau WEBP.'
      });
    }

    if (historyImage.buffer.length > MAX_FILE_BYTES) {
      return json(res, 413, {
        ok: false,
        error: 'FILE_TOO_LARGE',
        message: 'File terlalu besar. Maksimal gambar 5MB.'
      });
    }

    const ocrResponse = await callOcrApi(historyImage.buffer, historyImage.fileName, historyImage.mimeType);
    const rawText = parseOcrResponse(ocrResponse);
    const parsed = parseHistoryOcr(rawText, fields.provider);

    return json(res, 200, {
      ok: true,
      raw_text: rawText,
      parsed
    });
  } catch (error) {
    if (error.code === 'OCR_API_KEY_MISSING') {
      return json(res, 500, {
        ok: false,
        error: 'OCR_API_KEY_MISSING',
        message: 'OCR API key belum dikonfigurasi di server.',
        raw_text: ''
      });
    }

    const status = error.statusCode || 500;
    return json(res, status, {
      ok: false,
      error: error.code || 'OCR_FAILED',
      message: status >= 500 ? 'OCR gagal membaca history. Silakan isi manual.' : error.message,
      raw_text: ''
    });
  }
}
