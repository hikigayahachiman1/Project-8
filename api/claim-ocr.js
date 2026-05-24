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

function normalizePgWinToBaseAmount(value) {
  const amount = parseIndonesianMoney(value);
  if (!Number.isFinite(amount)) return NaN;
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

export function extractMoneyCandidates(text, options = {}) {
  const unique = options.unique !== false;
  const normalized = normalizeOcrText(text);
  const matches = normalized.split('\n').flatMap(line => {
    const hasMoneyPrefix = /\b(?:rp|ap|ro|rd|bp)\b/i.test(line);
    const looksLikeDateTime = /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(line) || /\b\d{1,2}[.:]\d{2}(?:[.:]\d{2})?\b/.test(line);
    if (!hasMoneyPrefix && looksLikeDateTime) return [];
    return line.match(/-?\s*(?:(?:Rp|Ap|Ro|RD|Bp)\s*)?\d{1,3}(?:\.\d{3})+(?:[,.]\d+)?|-?\s*(?:(?:Rp|Ap|Ro|RD|Bp)\s*)?\d+(?:[,.]\d+)?/gi) || [];
  });
  const values = matches
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(item => {
      const cleaned = cleanMoneyText(item);
      return /\b(?:rp|ap|ro|rd|bp)\b/i.test(item) || cleaned.includes(',') || /\d{1,3}(?:\.\d{3})+/.test(cleaned);
    });
  return unique ? [...new Set(values)] : values;
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
  const normalized = normalizeOcrText(rawText);
  const hasPgStrongMarker = /(verify\.pgsoft\.com|pgsoft|untung|surplus)/i.test(normalized);
  const hasPgTableShape = /transaksi/i.test(normalized) && /taruhan/i.test(normalized) && !/id sesi bermain|jumlah dimenangkan/i.test(normalized);
  const hasPgHistoryShape = /riwayat permainan/i.test(normalized) && /transaksi/i.test(normalized);
  if (hasPgStrongMarker || hasPgTableShape || hasPgHistoryShape) {
    return 'PG';
  }
  if (/(gates of olympus|sweet bonanza|starlight princess|pragmatic|super scatter|id sesi bermain|jumlah dimenangkan)/i.test(normalized)) {
    return 'PRAGMATIC';
  }
  const requested = String(requestedProvider || '').trim().toUpperCase();
  if (requested === 'PG' || requested === 'PRAGMATIC') return requested;
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
  const moneyValues = extractMoneyCandidates(normalized, { unique: false })
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

function extractPgTicketIds(text) {
  const normalized = normalizeOcrText(text);
  const lines = normalized.split('\n');
  const candidates = [];
  const digitLines = lines
    .map(line => ({ line, digits: line.replace(/\D/g, '') }))
    .filter(item => item.digits.length >= 6 && item.digits.length <= 12)
    .filter(item => !isLikelyNoiseLine(item.line))
    .filter(item => !/(?:rp|ap|ro|rd|bp|,|\.|:|\/|-)/i.test(item.line))
    .filter(item => !/[A-Za-z]/.test(item.line));

  for (let index = 0; index < digitLines.length; index += 1) {
    const current = digitLines[index].digits;
    const next = digitLines[index + 1] ? digitLines[index + 1].digits : '';
    if (next) {
      const combined = `${current}${next}`;
      if (combined.length >= 16 && combined.length <= 20) {
        candidates.push(combined);
        index += 1;
        continue;
      }
    }
    if (current.length >= 16 && current.length <= 20) candidates.push(current);
  }

  const directMatches = normalized.match(/\b\d{16,20}\b/g) || [];
  directMatches.forEach(match => candidates.push(match));

  return [...new Set(candidates)]
    .filter(value => value.length >= 16 && value.length <= 20)
    .filter(value => !/^0+$/.test(value));
}

function isLikelyPgBet(value) {
  const amount = parseIndonesianMoney(value);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return amount <= 100;
}

function extractPgMoneyColumns(text) {
  const normalized = normalizeOcrText(text);
  const moneyValues = extractMoneyCandidates(normalized, { unique: false })
    .map(normalizeMoneyLabel)
    .filter(Boolean);
  const positiveValues = moneyValues.filter(value => parseIndonesianMoney(value) > 0);
  const betCandidates = positiveValues.filter(isLikelyPgBet);
  const bet = betCandidates[0] || positiveValues[0] || '';
  const betAmount = parseIndonesianMoney(bet);

  let winCandidates = positiveValues.filter(value => {
    const amount = parseIndonesianMoney(value);
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (Number.isFinite(betAmount) && Math.abs(amount - betAmount) < 0.0001) return false;
    return !isLikelyPgBet(value) || amount > betAmount;
  });

  if (!winCandidates.length && bet) {
    const betIndex = moneyValues.findIndex(value => moneyAmountKey(value) === moneyAmountKey(bet));
    winCandidates = moneyValues
      .slice(Math.max(0, betIndex + 1))
      .filter(value => parseIndonesianMoney(value) > 0)
      .filter(value => moneyAmountKey(value) !== moneyAmountKey(bet));
  }

  return {
    moneyValues,
    bet,
    betCandidates,
    winCandidates: [...new Set(winCandidates)]
  };
}

function stripPgFooter(rawText) {
  const lines = normalizeOcrText(rawText).split('\n');
  const footerIndex = lines.findIndex(line => (
    /catatan[-\s]*catatan/i.test(line)
    || /klik di bawah/i.test(line)
    || /verify\.pgsoft/i.test(line)
    || /verifikasi permainan pg/i.test(line)
    || /^\s*resmi\s*:?\s*$/i.test(line)
  ));
  if (footerIndex < 0) return lines.join('\n');
  return lines.slice(0, footerIndex).join('\n');
}

function extractMoneyTokensWithLines(text) {
  const normalized = normalizeOcrText(text);
  return normalized.split('\n').flatMap((line, lineIndex) => {
    const hasMoneyPrefix = /\b(?:rp|ap|ro|rd|bp)\b/i.test(line);
    const looksLikeDateTime = /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(line) || /\b\d{1,2}[.:]\d{2}(?:[.:]\d{2})?\b/.test(line);
    if (!hasMoneyPrefix && looksLikeDateTime) return [];
    const matches = line.match(/-?\s*(?:(?:Rp|Ap|Ro|RD|Bp)\s*)?\d{1,3}(?:\.\d{3})+(?:[,.]\d+)?|-?\s*(?:(?:Rp|Ap|Ro|RD|Bp)\s*)?\d+(?:[,.]\d+)?/gi) || [];
    return matches
      .map(raw => normalizeMoneyLabel(raw))
      .filter(Boolean)
      .filter(raw => {
        const cleaned = cleanMoneyText(raw);
        return /\b(?:rp|ap|ro|rd|bp)\b/i.test(raw) || cleaned.includes(',') || /\d{1,3}(?:\.\d{3})+/.test(cleaned);
      })
      .map(raw => ({
        raw,
        lineIndex,
        amount: parseIndonesianMoney(raw),
        base: normalizePgWinToBaseAmount(raw)
      }));
  });
}

function findPgColumnLine(lines, pattern) {
  const index = lines.findIndex(line => pattern.test(line));
  return index >= 0 ? index : -1;
}

function buildPgDetectedRows(ticketIds, betCandidates, winTokens) {
  const rowCount = Math.max(ticketIds.length, betCandidates.length, winTokens.length, 1);
  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const bet = betCandidates[index] || betCandidates[0] || '';
    const winToken = winTokens[index] || null;
    const win = winToken ? winToken.raw : '';
    const baseAmount = normalizePgWinToBaseAmount(win);
    rows.push({
      row_index: index,
      ticket_id: ticketIds[index] || '',
      bet,
      bett_output: parseBetToBettOutput(bet),
      win,
      base_amount: Number.isFinite(baseAmount) ? baseAmount : null
    });
  }
  return rows;
}

function filterPgWinTokens(winTokens, betCandidates) {
  const betKeys = new Set((Array.isArray(betCandidates) ? betCandidates : [])
    .map(value => moneyAmountKey(value))
    .filter(Boolean));
  const positiveNonBet = (Array.isArray(winTokens) ? winTokens : [])
    .filter(token => token && Number.isFinite(token.amount))
    .filter(token => token.amount > 0)
    .filter(token => !betKeys.has(moneyAmountKey(token.raw)));
  const highValue = positiveNonBet.filter(token => normalizePgWinToBaseAmount(token.raw) >= 150);
  return highValue.length ? highValue.concat(positiveNonBet.filter(token => normalizePgWinToBaseAmount(token.raw) < 150)) : positiveNonBet;
}

export function parsePgHistoryOcr(rawText) {
  const normalized = stripPgFooter(rawText);
  const lines = normalized.split('\n');
  const ticketIds = extractPgTicketIds(normalized);
  const tokens = extractMoneyTokensWithLines(normalized);
  const taruhanLine = findPgColumnLine(lines, /taruhan|bet/i);
  const surplusLine = findPgColumnLine(lines, /surplus|untung|win/i);
  const ticketCount = Math.max(ticketIds.length, 1);

  let betCandidates = tokens
    .filter(token => token.amount > 0)
    .filter(token => surplusLine < 0 || token.lineIndex < surplusLine)
    .filter(token => taruhanLine < 0 || token.lineIndex > taruhanLine)
    .filter(token => isLikelyPgBet(token.raw))
    .map(token => token.raw)
    .slice(0, ticketCount);

  const rawWinTokens = tokens
    .filter(token => Number.isFinite(token.amount))
    .filter(token => surplusLine < 0 || token.lineIndex > surplusLine);
  let winTokens = filterPgWinTokens(rawWinTokens, betCandidates).slice(0, ticketCount);

  if (!betCandidates.length || !winTokens.length) {
    const fallback = extractPgMoneyColumns(normalized);
    if (!betCandidates.length) betCandidates = fallback.betCandidates.slice(0, ticketCount);
    if (!winTokens.length) {
      winTokens = filterPgWinTokens(
        fallback.winCandidates.map(raw => ({
          raw,
          amount: parseIndonesianMoney(raw),
          base: normalizePgWinToBaseAmount(raw)
        })),
        betCandidates
      ).slice(0, ticketCount);
    }
  }

  const detectedRows = buildPgDetectedRows(ticketIds, betCandidates, winTokens);
  const selectedRow = detectedRows.find(row => row.ticket_id && Number(row.base_amount) > 0 && parseIndonesianMoney(row.win) > 0)
    || detectedRows.find(row => Number(row.base_amount) > 0 && parseIndonesianMoney(row.win) > 0)
    || detectedRows[0]
    || {};

  const positiveWinCandidates = winTokens.map(token => token.raw);
  const selected_win = selectedRow.win || positiveWinCandidates[0] || pickSmallestPositiveWin(extractWinCandidates(normalized));
  const base_amount = normalizePgWinToBaseAmount(selected_win);
  const highPositiveWin = positiveWinCandidates.find(value => normalizePgWinToBaseAmount(value) >= 150);
  const warning = Number.isFinite(base_amount) && base_amount < 150 && highPositiveWin
    ? 'Nominal kemenangan terdeteksi tidak konsisten. Silakan cek pilihan win.'
    : '';
  const ticket_id = selectedRow.ticket_id || ticketIds[0] || extractTicketId(normalized);
  const bet = selectedRow.bet || betCandidates[0] || '';
  const bett_output = parseBetToBettOutput(bet);

  return {
    provider: 'PG',
    ticket_id,
    bet,
    bett_output,
    win_candidates: positiveWinCandidates,
    selected_win,
    base_amount: Number.isFinite(base_amount) ? base_amount : null,
    warning,
    detected_provider: 'PG',
    parser_used: 'parsePgHistoryOcr',
    selected_row_index: selectedRow.row_index || 0,
    ticket_ids: ticketIds,
    bet_candidates: betCandidates,
    win_list: positiveWinCandidates,
    debug: {
      ticket_list: ticketIds,
      bet_list: betCandidates,
      win_list: positiveWinCandidates
    },
    detected_rows: detectedRows
  };
}

export function parsePgScatterOcr(rawText) {
  const normalized = normalizeOcrText(rawText);
  const patterns = [
    /(?:scatter|scater|skater)\D{0,12}([3-6])/i,
    /([3-6])\D{0,8}(?:scatter|scater|skater)/i,
    /(?:scatter|scater|skater)\s*[:=-]?\s*([3-6])/i,
    /(?:jumlah|total)\D{0,10}(?:scatter|scater|skater)\D{0,10}([3-6])/i,
    /x\s*([3-6])\b/i,
    /\b([3-6])\s*x\b/i,
    /(?:胡|hu)\D{0,8}([3-6])/i,
    /([3-6])\D{0,8}(?:胡|hu)/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      return {
        provider: 'PG',
        ocr_type: 'scatter_pg',
        scatter_count: Number(match[1]),
        confidence: 'ocr',
        detected_provider: 'PG',
        parser_used: 'parsePgScatterOcr'
      };
    }
  }

  return {
    provider: 'PG',
    ocr_type: 'scatter_pg',
    scatter_count: null,
    confidence: 'manual_required',
    detected_provider: 'PG',
    parser_used: 'parsePgScatterOcr'
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

function validateImageFile(file, label = 'Gambar') {
  if (!file) return;
  if (!ALLOWED_MIME_TYPES.has(String(file.mimeType).toLowerCase())) {
    const error = new Error(`${label} harus berupa JPG, PNG, atau WEBP.`);
    error.statusCode = 400;
    throw error;
  }
  if (file.buffer.length > MAX_FILE_BYTES) {
    const error = new Error(`${label} terlalu besar. Maksimal gambar 5MB.`);
    error.statusCode = 413;
    throw error;
  }
}

async function processPgOcrImage(file, type) {
  try {
    validateImageFile(file, type === 'scatter' ? 'Gambar scatter' : 'Gambar history');
    const ocrResponse = await callOcrApi(file.buffer, file.fileName, file.mimeType);
    const rawText = parseOcrResponse(ocrResponse);
    const parsed = type === 'scatter'
      ? parsePgScatterOcr(rawText)
      : parsePgHistoryOcr(rawText);

    const scatterMissing = type === 'scatter' && !Number.isFinite(Number(parsed.scatter_count));
    return {
      ok: !scatterMissing,
      raw_text: rawText,
      parsed,
      ...(scatterMissing ? { message: 'Jumlah scatter belum terbaca. Silakan isi manual.' } : {})
    };
  } catch (error) {
    if (error.code === 'OCR_API_KEY_MISSING') throw error;
    return {
      ok: false,
      raw_text: error.raw || error.raw_text || '',
      parsed: type === 'scatter'
        ? {
            provider: 'PG',
            ocr_type: 'scatter_pg',
            scatter_count: null,
            confidence: 'manual_required',
            detected_provider: 'PG',
            parser_used: 'parsePgScatterOcr'
          }
        : {
            provider: 'PG',
            detected_provider: 'PG',
            parser_used: 'parsePgHistoryOcr'
          },
      message: type === 'scatter'
        ? 'Jumlah scatter belum terbaca. Silakan isi manual.'
        : 'OCR history gagal. Silakan isi manual.'
    };
  }
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
    const mode = String(fields.mode || '').trim();

    if (mode === 'pg_dual_submit') {
      const historyImage = files.history_image;

      if (!historyImage) {
        return json(res, 400, {
          ok: false,
          error: 'HISTORY_REQUIRED',
          message: 'Gambar History PG wajib diupload.'
        });
      }

      const historyResult = await processPgOcrImage(historyImage, 'history');
      return json(res, 200, {
        ok: true,
        history: historyResult,
        scatter: null
      });
    }

    const historyImage = files.ocr_image || files.history_image;

    if (!historyImage) {
      return json(res, 400, {
        ok: false,
        error: 'FILE_REQUIRED',
        message: 'Gambar history wajib diupload.'
      });
    }

    validateImageFile(historyImage, 'Gambar');

    const ocrResponse = await callOcrApi(historyImage.buffer, historyImage.fileName, historyImage.mimeType);
    const rawText = parseOcrResponse(ocrResponse);
    const ocrType = String(fields.ocr_type || fields.ocrType || 'history_pg').trim();
    const parsed = ocrType === 'scatter_pg'
      ? parsePgScatterOcr(rawText)
      : parsePgHistoryOcr(rawText);

    return json(res, 200, {
      ok: true,
      raw_text: rawText,
      ocr_type: ocrType,
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
