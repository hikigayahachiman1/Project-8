(function telegramParserPreviewModule() {
  'use strict';

  const TOKEN_KEY = 'qris_operator_token_v1';
  const PROFILE_KEY = 'qris_operator_profile_v1';
  let selectedBatch = null;
  let selectedDetail = null;
  let loadedParserRows = [];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(Number(value) || 0);
  }

  function excelNumber(value) {
    const number = Number(value) || 0;
    return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
  }

  function normalizedDepositRows(detail) {
    const deposits = Array.isArray(detail?.deposit_items) ? detail.deposit_items : [];
    const previews = Array.isArray(detail?.preview_items) ? detail.preview_items : [];
    const previewByLogin = new Map(previews.map(item => [String(item.login_key || item.login_id || '').toUpperCase(), item]));
    return deposits.map(row => {
      const amount = Number(row.amount) || 0;
      const fee = Number(row.fee) || 0;
      const preview = previewByLogin.get(String(row.login_key || row.login_id || '').toUpperCase());
      const notes = [];
      if (row.deposit_status) notes.push(String(row.deposit_status));
      if (preview?.status && String(preview.status).toUpperCase() !== String(row.deposit_status || '').toUpperCase()) notes.push(String(preview.status));
      if (preview?.warning || preview?.reason) notes.push(String(preview.warning || preview.reason));
      return {
        applicationTime: row.application_time_raw || '',
        loginId: row.login_id || row.login_key || '',
        member: row.member_name || row.member_id || '-',
        amount,
        fee,
        total: amount + fee,
        status: notes.join(' / ') || 'Tidak ada status'
      };
    });
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  function emptyBatchMessage() {
    toast('Batch Telegram tidak memiliki item deposit untuk dimuat.', 'error');
  }

  function loadSelectedBatchToParser() {
    const rows = normalizedDepositRows(selectedDetail);
    if (!rows.length) {
      emptyBatchMessage();
      return;
    }
    loadedParserRows = rows;
    const batchCode = selectedBatch?.batch_code || '-';
    const label = document.getElementById('telegramParserLoadedLabel');
    label.textContent = `Data dimuat dari Telegram Parser QRIS: ${batchCode}`;
    label.style.display = 'block';
    document.getElementById('resultDesc').textContent = `${rows.length} transaksi Telegram dimuat ke hasil parser.`;
    document.getElementById('statCount').textContent = rows.length;
    document.getElementById('statTotal').textContent = formatNumber(rows.reduce((sum, row) => sum + row.total, 0));
    document.getElementById('stats').style.display = 'grid';
    document.getElementById('outputTextWrap').style.display = 'block';
    document.getElementById('outputText').value = rows.map(row =>
      `${row.applicationTime} | ${row.loginId} | ${row.member} | Nominal: ${excelNumber(row.amount)} | Fee: ${excelNumber(row.fee)} | Total: ${excelNumber(row.total)} | ${row.status}`
    ).join('\n');
    document.getElementById('parserTotalHeader').textContent = 'Total';
    document.getElementById('telegramParserStatusHeader').style.display = '';
    document.getElementById('tbody').innerHTML = rows.map((row, index) => `
      <tr>
        <td class="idx">${index + 1}</td>
        <td class="time-cell">${escapeHtml(row.applicationTime)}</td>
        <td class="user-id">${escapeHtml(row.loginId)}</td>
        <td class="nama">${escapeHtml(row.member)}</td>
        <td class="num">${escapeHtml(excelNumber(row.amount))}</td>
        <td class="num">${escapeHtml(excelNumber(row.fee))}</td>
        <td class="num"><strong>${escapeHtml(excelNumber(row.total))}</strong></td>
        <td>${escapeHtml(row.status)}</td>
      </tr>
    `).join('');
    toast(`Batch ${batchCode} dimuat ke Hasil Parser.`, 'success');
  }

  async function copySelectedExcel() {
    const rows = normalizedDepositRows(selectedDetail);
    if (!rows.length) {
      emptyBatchMessage();
      return;
    }
    const header = ['Application Time', 'Login ID', 'Member', 'Nominal', 'Fee', 'Total', 'Status'];
    const lines = rows.map(row => [
      row.applicationTime, row.loginId, row.member, excelNumber(row.amount), excelNumber(row.fee), excelNumber(row.total), row.status
    ].map(value => String(value).replace(/[\t\r\n]+/g, ' ')).join('\t'));
    await copyText([header.join('\t'), ...lines].join('\n'));
    toast(`${rows.length} baris Telegram dicopy untuk Excel.`, 'success');
  }

  async function copyVisibleParserTable() {
    const tbody = document.getElementById('tbody');
    const dataRows = [...tbody.querySelectorAll('tr')].filter(row => !row.querySelector('.empty'));
    if (!dataRows.length) {
      toast('Tabel Hasil masih kosong.', 'error');
      return;
    }
    const headers = [...tbody.closest('table').querySelectorAll('thead th')]
      .filter(cell => getComputedStyle(cell).display !== 'none')
      .map(cell => cell.textContent.trim());
    const rows = dataRows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim().replace(/[\t\r\n]+/g, ' ')).join('\t'));
    await copyText([headers.join('\t'), ...rows].join('\n'));
    toast('Isi Tabel Hasil berhasil dicopy.', 'success');
  }

  function clearTelegramLoadedMarker() {
    loadedParserRows = [];
    const label = document.getElementById('telegramParserLoadedLabel');
    if (label) label.style.display = 'none';
    const statusHeader = document.getElementById('telegramParserStatusHeader');
    if (statusHeader) statusHeader.style.display = 'none';
    const totalHeader = document.getElementById('parserTotalHeader');
    if (totalHeader) totalHeader.textContent = 'Total (×1000)';
  }

  function operatorRole() {
    try {
      return String(JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}').role || localStorage.getItem('operator_role') || '').toLowerCase();
    } catch (error) {
      return String(localStorage.getItem('operator_role') || '').toLowerCase();
    }
  }

  function toast(message, type = '') {
    if (typeof window.showToast === 'function') window.showToast(message, type);
  }

  async function api(path, options = {}) {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true) throw new Error(result.message || result.error || 'Request Telegram Parser QRIS gagal.');
    return result;
  }

  function statusClass(status) {
    if (status === 'WAITING_SUPERADMIN_APPROVAL') return 'pending';
    if (status === 'CANCELLED') return 'inactive';
    return '';
  }

  function renderBatches(batches) {
    const rows = Array.isArray(batches) ? batches : [];
    const parserTable = document.getElementById('telegramParserBatchTable');
    const bonusTable = document.getElementById('telegramBonusPreviewTable');
    if (parserTable) parserTable.innerHTML = rows.map(batch => `
      <tr>
        <td class="user-id">${escapeHtml(batch.batch_code)}</td>
        <td>${escapeHtml(batch.bonus_date)}</td>
        <td><span class="status-badge">Telegram Parser QRIS</span></td>
        <td><span class="status-badge ${statusClass(batch.preview_status)}">${escapeHtml(batch.preview_status)}</span></td>
        <td class="num">${Number(batch.total_parsed || 0)}</td>
        <td class="num">${Number(batch.ready_items || 0)}</td>
        <td class="num">${Number(batch.skipped_items || 0)}</td>
        <td class="num">${Number(batch.manual_review_items || 0)}</td>
        <td><button type="button" data-telegram-batch="${escapeHtml(batch.batch_code)}">Lihat</button></td>
      </tr>
    `).join('') || '<tr><td colspan="9" class="empty">Belum ada batch Telegram Parser QRIS.</td></tr>';
    if (bonusTable) bonusTable.innerHTML = rows.map(batch => `
      <tr>
        <td class="user-id">${escapeHtml(batch.batch_code)}</td>
        <td>${escapeHtml(batch.bonus_date)}</td>
        <td><span class="status-badge">Telegram Parser QRIS</span></td>
        <td><span class="status-badge ${statusClass(batch.preview_status)}">${escapeHtml(batch.preview_status)}</span></td>
        <td class="num">${Number(batch.ready_items || 0)}</td>
        <td class="num">${Number(batch.skipped_items || 0)}</td>
        <td class="num">${Number(batch.manual_review_items || 0)}</td>
        <td class="num">${formatNumber(batch.total_bonus_bo)}</td>
        <td><button type="button" data-telegram-batch="${escapeHtml(batch.batch_code)}">Lihat Preview</button></td>
      </tr>
    `).join('') || '<tr><td colspan="9" class="empty">Belum ada preview Telegram Parser QRIS.</td></tr>';
  }

  async function refresh(silent = false) {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    try {
      const result = await api('/api/telegram-parser-qris?action=batches&limit=20');
      renderBatches(result.batches);
      const message = `${result.batches.length} batch Telegram Parser QRIS dimuat.`;
      ['telegramParserNote', 'telegramBonusPreviewNote'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.textContent = message;
      });
      if (!silent) toast(message, 'success');
    } catch (error) {
      ['telegramParserNote', 'telegramBonusPreviewNote'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.textContent = error.message;
      });
      if (!silent) toast(error.message, 'error');
    }
  }

  async function openBatch(batchCode) {
    try {
      const result = await api(`/api/telegram-parser-qris?action=batch_detail&batch_code=${encodeURIComponent(batchCode)}`);
      selectedBatch = result.batch;
      selectedDetail = result;
      document.getElementById('telegramParserDetail').style.display = 'block';
      document.getElementById('telegramBonusItemWrap').style.display = 'block';
      const note = `${result.batch.batch_code} · ${result.batch.preview_status} · source=${result.batch.source}`;
      document.getElementById('telegramParserDetailNote').textContent = note;
      document.getElementById('telegramBonusItemNote').textContent = note;
      const depositItems = Array.isArray(result.deposit_items) ? result.deposit_items : [];
      const previewItems = Array.isArray(result.preview_items) ? result.preview_items : [];
      document.getElementById('telegramParserDepositDetailTable').innerHTML = depositItems.map((row, index) => `
        <tr><td>${index + 1}</td><td>${escapeHtml(row.application_time_raw)}</td><td class="user-id">${escapeHtml(row.login_id)}</td><td>${escapeHtml(row.member_name || row.member_id || '-')}</td><td class="num">${formatNumber(row.amount)}</td><td class="num">${formatNumber(row.fee)}</td><td class="num">${formatNumber(row.total_amount)}</td><td>${escapeHtml(row.deposit_status || '-')}</td></tr>
      `).join('') || '<tr><td colspan="8" class="empty">Tidak ada item deposit.</td></tr>';
      document.getElementById('telegramBonusItemTable').innerHTML = previewItems.map((row, index) => `
        <tr><td>${index + 1}</td><td class="user-id">${escapeHtml(row.login_id)}</td><td>${escapeHtml(row.member_name || row.member_id || '-')}</td><td class="num">${formatNumber(row.max_deposit)}</td><td class="num">${formatNumber(row.amount_bo)}</td><td><span class="status-badge">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.warning || row.reason || '-')}</td></tr>
      `).join('') || '<tr><td colspan="7" class="empty">Tidak ada item preview bonus.</td></tr>';
      const cancel = document.getElementById('telegramParserCancelBtn');
      cancel.style.display = operatorRole() === 'superadmin' && result.batch.preview_status === 'WAITING_SUPERADMIN_APPROVAL' ? 'inline-flex' : 'none';
      ['telegramLoadParserBtn', 'telegramCopyExcelBtn', 'telegramCopyTableBtn'].forEach(id => {
        document.getElementById(id).style.display = 'inline-flex';
      });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function cancelSelected() {
    if (!selectedBatch || operatorRole() !== 'superadmin') return;
    if (!window.confirm(`Cancel preview Telegram ${selectedBatch.batch_code}?`)) return;
    try {
      await api('/api/telegram-parser-qris?action=cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_code: selectedBatch.batch_code, reason: 'Dibatalkan dari dashboard' })
      });
      selectedBatch = null;
      selectedDetail = null;
      document.getElementById('telegramParserDetail').style.display = 'none';
      document.getElementById('telegramBonusItemWrap').style.display = 'none';
      await refresh(true);
      toast('Preview Telegram dibatalkan.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function init() {
    document.getElementById('telegramParserRefreshBtn')?.addEventListener('click', () => refresh(false));
    document.getElementById('telegramBonusRefreshBtn')?.addEventListener('click', () => refresh(false));
    document.getElementById('telegramParserCancelBtn')?.addEventListener('click', cancelSelected);
    document.getElementById('telegramLoadParserBtn')?.addEventListener('click', loadSelectedBatchToParser);
    document.getElementById('telegramCopyExcelBtn')?.addEventListener('click', () => copySelectedExcel().catch(error => toast(error.message, 'error')));
    document.getElementById('telegramCopyTableBtn')?.addEventListener('click', () => copyVisibleParserTable().catch(error => toast(error.message, 'error')));
    ['parseBtn', 'clearBtn', 'importDepositBtn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => setTimeout(clearTelegramLoadedMarker, 0));
    });
    document.getElementById('sortOrder')?.addEventListener('change', () => setTimeout(clearTelegramLoadedMarker, 0));
    document.addEventListener('click', event => {
      const detailButton = event.target.closest('[data-telegram-batch]');
      if (detailButton) openBatch(detailButton.dataset.telegramBatch);
      const tab = event.target.closest('.tool-tab[data-panel]');
      if (tab && ['parser', 'bonus'].includes(tab.dataset.panel)) refresh(true);
    });
    refresh(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
