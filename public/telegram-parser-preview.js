(function telegramParserPreviewModule() {
  'use strict';

  const TOKEN_KEY = 'qris_operator_token_v1';
  const PROFILE_KEY = 'qris_operator_profile_v1';
  let selectedBatch = null;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(Number(value) || 0);
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
      document.getElementById('telegramParserDetail').style.display = 'block';
      document.getElementById('telegramBonusItemWrap').style.display = 'block';
      const note = `${result.batch.batch_code} · ${result.batch.preview_status} · source=${result.batch.source}`;
      document.getElementById('telegramParserDetailNote').textContent = note;
      document.getElementById('telegramBonusItemNote').textContent = note;
      document.getElementById('telegramParserDepositDetailTable').innerHTML = result.deposit_items.map((row, index) => `
        <tr><td>${index + 1}</td><td>${escapeHtml(row.application_time_raw)}</td><td class="user-id">${escapeHtml(row.login_id)}</td><td>${escapeHtml(row.member_name || row.member_id || '-')}</td><td class="num">${formatNumber(row.amount)}</td><td class="num">${formatNumber(row.fee)}</td><td class="num">${formatNumber(row.total_amount)}</td><td>${escapeHtml(row.deposit_status || '-')}</td></tr>
      `).join('') || '<tr><td colspan="8" class="empty">Tidak ada item deposit.</td></tr>';
      document.getElementById('telegramBonusItemTable').innerHTML = result.preview_items.map((row, index) => `
        <tr><td>${index + 1}</td><td class="user-id">${escapeHtml(row.login_id)}</td><td>${escapeHtml(row.member_name || row.member_id || '-')}</td><td class="num">${formatNumber(row.max_deposit)}</td><td class="num">${formatNumber(row.amount_bo)}</td><td><span class="status-badge">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.warning || row.reason || '-')}</td></tr>
      `).join('') || '<tr><td colspan="7" class="empty">Tidak ada item preview bonus.</td></tr>';
      const cancel = document.getElementById('telegramParserCancelBtn');
      cancel.style.display = operatorRole() === 'superadmin' && result.batch.preview_status === 'WAITING_SUPERADMIN_APPROVAL' ? 'inline-flex' : 'none';
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
