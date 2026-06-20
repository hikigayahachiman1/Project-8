import {
  TELEGRAM_PARSER_SOURCE,
  TELEGRAM_PREVIEW_STATUS,
  apiError,
  batchCode,
  buildTelegramPreview,
  fetchBatchDetail,
  parseDepositText,
  requireIngestActor,
  requireOperator,
  requireSupabase,
  sha256,
  telegramParserSupabase,
  todayWib
} from './_lib/telegram-parser-qris.js';

export const config = { api: { bodyParser: false } };

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function readRequestBuffer(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_UPLOAD_BYTES) {
      const error = new Error('Ukuran input maksimal 10MB.');
      error.statusCode = 413;
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw Object.assign(new Error('Boundary multipart tidak ditemukan.'), { statusCode: 400, code: 'INVALID_MULTIPART' });
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const fields = {};
  const files = {};
  const binary = buffer.toString('latin1');
  binary.split(boundary).slice(1, -1).forEach(part => {
    const clean = part.replace(/^\r?\n/, '').replace(/\r?\n--?$/, '');
    const separator = clean.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
    const index = clean.indexOf(separator);
    if (index < 0) return;
    const headers = clean.slice(0, index);
    const body = clean.slice(index + separator.length).replace(/\r?\n$/, '');
    const name = headers.match(/name="([^"]+)"/i)?.[1];
    if (!name) return;
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];
    if (filename !== undefined) {
      files[name] = {
        filename,
        contentType: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || '',
        buffer: Buffer.from(body, 'latin1')
      };
    } else {
      fields[name] = Buffer.from(body, 'latin1').toString('utf8');
    }
  });
  return { fields, files };
}

async function uploadText(file) {
  if (!file) return '';
  if (/\.xlsx$/i.test(file.filename || '')) {
    if (file.buffer.slice(0, 2).toString('utf8') !== 'PK') throw Object.assign(new Error('File XLSX tidak valid.'), { statusCode: 400, code: 'XLSX_PARSE_FAILED' });
    const xlsx = await import('xlsx');
    const workbook = xlsx.read(file.buffer, { type: 'buffer', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw Object.assign(new Error('Workbook tidak memiliki sheet.'), { statusCode: 400, code: 'XLSX_PARSE_FAILED' });
    return xlsx.utils.sheet_to_csv(sheet, { FS: ',', blankrows: false });
  }
  return file.buffer.toString('utf8').replace(/^\uFEFF/, '');
}

async function parseIngestInput(req) {
  const contentType = String(req.headers['content-type'] || '');
  const buffer = await readRequestBuffer(req);
  if (/multipart\/form-data/i.test(contentType)) {
    const { fields, files } = parseMultipart(buffer, contentType);
    const file = files.deposit_file || files.file || null;
    const rawText = String(fields.raw_text || '') || await uploadText(file);
    return {
      fields,
      rawText,
      inputType: file ? (/\.xlsx$/i.test(file.filename) ? 'XLSX' : 'FILE') : 'RAW_TEXT',
      filename: file?.filename || '',
      mimeType: file?.contentType || ''
    };
  }
  if (!/application\/json/i.test(contentType)) throw Object.assign(new Error('Gunakan application/json atau multipart/form-data.'), { statusCode: 400, code: 'INVALID_CONTENT_TYPE' });
  let fields;
  try {
    fields = JSON.parse(buffer.toString('utf8') || '{}');
  } catch (error) {
    throw Object.assign(new Error('Body JSON tidak valid.'), { statusCode: 400, code: 'INVALID_JSON' });
  }
  return { fields, rawText: String(fields.raw_text || ''), inputType: 'RAW_TEXT', filename: '', mimeType: 'text/plain' };
}

async function parseRouterJson(req) {
  const buffer = await readRequestBuffer(req);
  try {
    return JSON.parse(buffer.toString('utf8') || '{}');
  } catch (error) {
    throw Object.assign(new Error('Body JSON tidak valid.'), { statusCode: 400, code: 'INVALID_JSON' });
  }
}

async function insertChunks(table, rows, select = '') {
  const output = [];
  for (let index = 0; index < rows.length; index += 500) {
    let query = telegramParserSupabase.from(table).insert(rows.slice(index, index + 500));
    if (select) query = query.select(select);
    const { data, error } = await query;
    if (error) throw error;
    if (data) output.push(...data);
  }
  return output;
}

async function handleIngest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  let createdBatch = null;
  try {
    requireSupabase();
    const actor = await requireIngestActor(req);
    const input = await parseIngestInput(req);
    if (!input.rawText.trim()) throw Object.assign(new Error('raw_text atau deposit_file wajib diisi.'), { statusCode: 400, code: 'DEPOSIT_INPUT_REQUIRED' });
    const bonusDate = String(input.fields.bonus_date || todayWib()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bonusDate)) throw Object.assign(new Error('bonus_date harus YYYY-MM-DD.'), { statusCode: 400, code: 'INVALID_BONUS_DATE' });

    const parsed = parseDepositText(input.rawText);
    const preview = buildTelegramPreview(parsed.records, bonusDate);
    const inputHash = sha256(input.rawText);
    const requestedKey = String(input.fields.idempotency_key || input.fields.telegram_update_id || '').trim();
    const ingestKey = sha256(`${TELEGRAM_PARSER_SOURCE}|${requestedKey || inputHash}|${bonusDate}`);
    const { data: existing, error: existingError } = await telegramParserSupabase
      .from('telegram_parser_batches')
      .select('id, batch_code')
      .eq('ingest_key', ingestKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      const detail = await fetchBatchDetail(existing.id);
      return res.status(200).json({ success: true, duplicate: true, ...detail });
    }

    const code = batchCode(bonusDate);
    const summary = { ...preview.summary, parser_skipped_rows: parsed.skipped };
    const { data: batch, error: batchError } = await telegramParserSupabase
      .from('telegram_parser_batches')
      .insert({
        batch_code: code,
        ingest_key: ingestKey,
        source: TELEGRAM_PARSER_SOURCE,
        input_type: input.inputType,
        original_filename: input.filename || null,
        mime_type: input.mimeType || null,
        telegram_update_id: input.fields.telegram_update_id || null,
        telegram_chat_id: input.fields.telegram_chat_id || null,
        telegram_message_id: input.fields.telegram_message_id || null,
        telegram_file_id: input.fields.telegram_file_id || null,
        telegram_file_unique_id: input.fields.telegram_file_unique_id || null,
        bonus_date: bonusDate,
        parser_status: 'PARSED',
        preview_status: TELEGRAM_PREVIEW_STATUS,
        total_parsed: summary.total_parsed,
        ready_items: summary.ready_items,
        skipped_items: summary.skipped_items + parsed.skipped,
        manual_review_items: summary.manual_review_items,
        total_amount: summary.total_amount,
        total_bonus_bo: summary.total_bonus_bo,
        summary
      })
      .select('*')
      .single();
    if (batchError) throw batchError;
    createdBatch = batch;

    const depositRows = parsed.records.map(row => ({
      batch_id: batch.id,
      row_number: row.rowNumber,
      source: TELEGRAM_PARSER_SOURCE,
      login_id: row.loginId,
      login_key: row.loginKey,
      member_id: row.memberId || null,
      member_name: row.memberName || null,
      application_time_raw: row.applicationTime,
      bonus_date: row.bonusDate || null,
      amount: row.amount,
      fee: row.fee,
      total_amount: Math.round((row.amount + row.fee) * 1000),
      deposit_status: row.status || null,
      raw_item: row.rawItem || {}
    }));
    const insertedDeposits = await insertChunks('telegram_parser_deposit_items', depositRows, 'id, row_number');
    const depositIdByRow = new Map(insertedDeposits.map(row => [row.row_number, row.id]));

    const previewRows = preview.items.map(item => ({
      batch_id: batch.id,
      deposit_item_id: depositIdByRow.get(item.rowNumber) || null,
      source: TELEGRAM_PARSER_SOURCE,
      bonus_date: bonusDate,
      login_id: item.loginId,
      login_key: item.loginKey,
      member_id: item.memberId || null,
      member_name: item.memberName || null,
      max_deposit: item.totalAmount,
      amount_raw: item.amountRaw,
      amount_bo: item.amountBo,
      status: item.previewStatus,
      reason: item.previewStatus === 'SKIPPED_BELOW_THRESHOLD' ? 'BELOW_MINIMUM_DEPOSIT' : null,
      warning: item.warning || null
    }));
    await insertChunks('telegram_bonus_preview_items', previewRows);
    const { error: eventError } = await telegramParserSupabase.from('telegram_parser_batch_events').insert({
      batch_id: batch.id,
      source: TELEGRAM_PARSER_SOURCE,
      event_type: 'INGESTED',
      actor_type: actor.type,
      actor_id: actor.id || null,
      actor_name: actor.name,
      detail: { input_type: input.inputType, filename: input.filename || '', input_sha256: inputHash }
    });
    if (eventError) throw eventError;
    const detail = await fetchBatchDetail(batch.id);
    return res.status(201).json({ success: true, duplicate: false, ...detail });
  } catch (error) {
    if (createdBatch?.id) {
      await telegramParserSupabase.from('telegram_parser_batches').update({
        parser_status: 'FAILED',
        last_error: String(error.message || 'Ingest gagal').slice(0, 500),
        updated_at: new Date().toISOString()
      }).eq('id', createdBatch.id);
    }
    return apiError(res, error, 'Ingest Telegram Parser QRIS gagal.');
  }
}

async function handleBatches(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    requireSupabase();
    await requireOperator(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    let query = telegramParserSupabase.from('telegram_parser_batches').select('*')
      .eq('source', TELEGRAM_PARSER_SOURCE).order('created_at', { ascending: false }).limit(limit);
    const bonusDate = String(req.query.bonus_date || '').trim();
    if (bonusDate) query = query.eq('bonus_date', bonusDate);
    const { data, error } = await query;
    if (error) throw error;
    return res.status(200).json({ success: true, source: TELEGRAM_PARSER_SOURCE, batches: data || [] });
  } catch (error) {
    return apiError(res, error, 'Daftar batch Telegram gagal dimuat.');
  }
}

async function handleBatchDetail(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    requireSupabase();
    await requireOperator(req);
    const identifier = String(req.query.id || req.query.batch_code || '').trim();
    if (!identifier) return res.status(400).json({ success: false, error: 'BATCH_ID_REQUIRED', message: 'id atau batch_code wajib diisi.' });
    const detail = await fetchBatchDetail(identifier);
    if (!detail) return res.status(404).json({ success: false, error: 'BATCH_NOT_FOUND', message: 'Batch tidak ditemukan.' });
    return res.status(200).json({ success: true, ...detail });
  } catch (error) {
    return apiError(res, error, 'Detail batch Telegram gagal dimuat.');
  }
}

async function handleCancel(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  try {
    requireSupabase();
    const operator = await requireOperator(req, ['superadmin']);
    const body = await parseRouterJson(req);
    const identifier = String(body.id || body.batch_code || '').trim();
    if (!identifier) return res.status(400).json({ success: false, error: 'BATCH_ID_REQUIRED', message: 'id atau batch_code wajib diisi.' });
    let query = telegramParserSupabase.from('telegram_parser_batches').update({
      preview_status: 'CANCELLED',
      cancelled_by_id: String(operator.id),
      cancelled_by_name: operator.display_name || operator.username,
      cancelled_at: new Date().toISOString(),
      cancel_reason: String(body.reason || '').trim() || 'Dibatalkan oleh Superadmin',
      updated_at: new Date().toISOString()
    }).eq('source', TELEGRAM_PARSER_SOURCE).eq('preview_status', 'WAITING_SUPERADMIN_APPROVAL');
    query = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(identifier) ? query.eq('id', identifier) : query.eq('batch_code', identifier);
    const { data: batch, error } = await query.select('*').maybeSingle();
    if (error) throw error;
    if (!batch) return res.status(409).json({ success: false, error: 'BATCH_NOT_CANCELLABLE', message: 'Batch tidak ditemukan atau sudah tidak menunggu approval.' });
    const { error: eventError } = await telegramParserSupabase.from('telegram_parser_batch_events').insert({
      batch_id: batch.id,
      source: TELEGRAM_PARSER_SOURCE,
      event_type: 'CANCELLED',
      actor_type: 'OPERATOR',
      actor_id: String(operator.id),
      actor_name: operator.display_name || operator.username,
      detail: { reason: batch.cancel_reason }
    });
    if (eventError) throw eventError;
    return res.status(200).json({ success: true, batch });
  } catch (error) {
    return apiError(res, error, 'Cancel batch Telegram gagal.');
  }
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return res.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
}

export default async function handler(req, res) {
  const action = String(req.query.action || '').trim().toLowerCase();
  if (action === 'ingest') return handleIngest(req, res);
  if (action === 'batches') return handleBatches(req, res);
  if (action === 'batch_detail') return handleBatchDetail(req, res);
  if (action === 'cancel') return handleCancel(req, res);
  return res.status(400).json({
    success: false,
    error: 'UNKNOWN_ACTION',
    message: 'action harus ingest, batches, batch_detail, atau cancel.'
  });
}
