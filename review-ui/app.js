/**
 * TikTok Symphony RPA - 审核面板前端逻辑
 */
(function () {
  'use strict';

  // ─── 配置 ──────────────────────────────────────
  const API_BASE = `${location.protocol}//${location.hostname}:3000`;
  const WS_URL = `ws://${location.hostname}:3001`;
  const RECONNECT_DELAY = 3000;

  // ─── 状态 ──────────────────────────────────────
  let tasks = new Map();        // taskId -> VideoTask
  let systemStatus = null;
  let ws = null;
  let currentFilter = 'all';
  let reconnectTimer = null;
  let notificationGranted = false;

  // ─── 状态文案映射 ─────────────────────────────
  const STATUS_LABELS = {
    'pending':            '待处理',
    'running':            '运行中',
    'waiting-generation': '生成中',
    'review':             '待审核',
    'approved':           '已通过',
    'completed':          '已完成',
    'rejected':           '已拒绝',
    'failed':             '已失败',
    'downloading':        '下载中',
  };

  const METHOD_LABELS = {
    'template':   '模板模式',
    'agent-mode': 'Agent模式',
  };

  const FILTER_OPTIONS = [
    { key: 'all',      label: '全部' },
    { key: 'review',   label: '待审核' },
    { key: 'running',  label: '进行中' },
    { key: 'pending',  label: '待处理' },
    { key: 'completed',label: '已完成' },
    { key: 'failed',   label: '已失败' },
  ];

  // ─── DOM 引用 ───────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ─── 初始化 ─────────────────────────────────────
  function init() {
    renderFilterBar();
    connectWebSocket();
    requestNotificationPermission();
    setupCountryAutoDetect();

    // 模态框关闭
    $('.modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
    $('#create-modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeCreateModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        closeCreateModal();
      }
    });
  }

  // ═══════════════════════════════════════════
  // WebSocket
  // ═══════════════════════════════════════════
  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    updateWsIndicator(false, '连接中…');
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[WS] 已连接');
      updateWsIndicator(true, '已连接');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (err) {
        console.error('[WS] 消息解析失败:', err);
      }
    };

    ws.onclose = () => {
      console.log('[WS] 连接断开，将在3秒后重连');
      updateWsIndicator(false, '已断开');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[WS] 错误:', err);
      updateWsIndicator(false, '连接错误');
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, RECONNECT_DELAY);
  }

  function updateWsIndicator(connected, text) {
    const el = $('.ws-indicator');
    if (!el) return;
    el.classList.toggle('connected', connected);
    const label = el.querySelector('.ws-label');
    if (label) label.textContent = text;
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'init':
        handleInit(msg.data);
        break;
      case 'task:created':
        // 去重：同一 task.id 已在本地 tasks 里，不再弹 toast（避免 WS 重连后重复上报）
        if (!tasks.has(msg.data.id)) {
          showToast('📋 新任务创建', msg.data.input?.productName || msg.data.id.slice(0, 8));
        }
        handleTaskUpdate(msg.data);
        break;
      case 'task:statusChanged':
        handleTaskUpdate(msg.data);
        if (msg.data.status === 'review') {
          showToast('🔔 任务待审核', msg.data.input?.productName || msg.data.id.slice(0, 8));
          sendBrowserNotification('有任务需要审核', msg.data.input?.productName || '');
          playNotificationSound();
        }
        break;
      case 'task:completed':
        handleTaskUpdate(msg.data);
        showToast('✅ 任务完成', msg.data.input?.productName || msg.data.id.slice(0, 8));
        break;
      case 'task:failed':
        handleTaskUpdate(msg.data);
        showToast('❌ 任务失败', msg.data.error || msg.data.id.slice(0, 8));
        break;
      case 'system:status':
        systemStatus = msg.data;
        renderSystemStatus(msg.data);
        break;
    }
  }

  function handleInit(data) {
    tasks.clear();
    if (data.tasks && Array.isArray(data.tasks)) {
      data.tasks.forEach((t) => tasks.set(t.id, t));
    }
    if (data.status) {
      systemStatus = data.status;
      renderSystemStatus(data.status);
    }
    renderTasks();
  }

  function handleTaskUpdate(task) {
    tasks.set(task.id, task);
    const existingCard = document.getElementById(`card-${task.id}`);
    if (existingCard) {
      if (shouldShowTask(task)) {
        updateTaskCard(task, existingCard);
      } else {
        existingCard.remove();
      }
    } else if (shouldShowTask(task)) {
      renderTasks();
    }
    updateFilterCounts();
    // 更新模态框（如果正在显示此任务）
    const modal = $('.modal-overlay');
    if (modal && modal.classList.contains('open') && modal.dataset.taskId === task.id) {
      renderModalContent(task);
    }
  }

  // ═══════════════════════════════════════════
  // Rendering
  // ═══════════════════════════════════════════
  function renderSystemStatus(status) {
    setText('#stat-browser', status.browserConnected ? '已连接' : '未连接');
    const dot = $('#stat-browser-dot');
    if (dot) {
      dot.className = 'status-item-dot ' + (status.browserConnected ? 'green' : 'red');
    }
    setText('#stat-active', String(status.activeTasks ?? 0));
    setText('#stat-pending', String(status.pendingTasks ?? 0));
    setText('#stat-waiting', String(status.waitingTasks ?? 0));
    setText('#stat-pages', `${status.availablePages ?? 0} / ${status.totalPages ?? 0}`);
    // 登录态
    if ('loginHealthy' in status) {
      setText('#stat-login', status.loginHealthy ? '有效' : '失效');
      const ld = $('#stat-login-dot');
      if (ld) ld.className = 'status-item-dot ' + (status.loginHealthy ? 'green' : 'red');
    }
    // 近 24h 失败
    if ('failedRecent' in status) {
      setText('#stat-failed-recent', String(status.failedRecent || 0));
      const fd = $('#stat-fail-dot');
      if (fd) fd.className = 'status-item-dot ' + ((status.failedRecent || 0) > 5 ? 'red' : 'gray');
    }
  }

  function setText(sel, text) {
    const el = $(sel);
    if (el) el.textContent = text;
  }

  function renderFilterBar() {
    const group = $('.filter-group');
    if (!group) return;
    group.innerHTML = '';
    FILTER_OPTIONS.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'filter-btn' + (currentFilter === opt.key ? ' active' : '');
      btn.dataset.filter = opt.key;
      btn.innerHTML = `${opt.label}<span class="count" id="filter-count-${opt.key}">0</span>`;
      btn.addEventListener('click', () => setFilter(opt.key));
      group.appendChild(btn);
    });
    updateFilterCounts();
  }

  function setFilter(filter) {
    currentFilter = filter;
    $$('.filter-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderTasks();
  }

  function updateFilterCounts() {
    const all = Array.from(tasks.values());
    const counts = { all: all.length };
    all.forEach((t) => { counts[t.status] = (counts[t.status] || 0) + 1; });
    // 进行中 = running + waiting-generation + downloading
    counts['running'] = (counts['running'] || 0) + (counts['waiting-generation'] || 0) + (counts['downloading'] || 0);

    FILTER_OPTIONS.forEach((opt) => {
      const el = $(`#filter-count-${opt.key}`);
      if (el) el.textContent = String(counts[opt.key] || 0);
    });

    // 更新摘要
    const summary = $('.task-summary');
    if (summary) {
      summary.textContent = `共 ${all.length} 个任务`;
    }
  }

  function shouldShowTask(task) {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'running') {
      return ['running', 'waiting-generation', 'downloading'].includes(task.status);
    }
    if (currentFilter === 'completed') {
      return ['approved', 'completed'].includes(task.status);
    }
    if (currentFilter === 'failed') {
      return ['failed', 'rejected'].includes(task.status);
    }
    return task.status === currentFilter;
  }

  function renderTasks() {
    const grid = $('.task-grid');
    if (!grid) return;

    const sorted = Array.from(tasks.values())
      .filter(shouldShowTask)
      .sort((a, b) => {
        // review 状态置顶
        if (a.status === 'review' && b.status !== 'review') return -1;
        if (b.status === 'review' && a.status !== 'review') return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    if (sorted.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <div class="empty-state-text">暂无${currentFilter === 'all' ? '' : '匹配的'}任务</div>
          <div class="empty-state-hint">${currentFilter === 'review' ? '当有任务需要审核时会在此显示' : '任务创建后会在此显示'}</div>
        </div>`;
      return;
    }

    grid.innerHTML = '';
    sorted.forEach((task) => {
      grid.appendChild(createTaskCard(task));
    });

    updateFilterCounts();
  }

  function createTaskCard(task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.id = `card-${task.id}`;
    card.dataset.status = task.status;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) return;
      showTaskDetail(task.id);
    });
    fillCardContent(card, task);
    return card;
  }

  function fillCardContent(card, task) {
    const shortId = task.id.slice(0, 8);
    const statusLabel = STATUS_LABELS[task.status] || task.status;
    const methodLabel = METHOD_LABELS[task.method] || task.method;
    const timeStr = formatTime(task.createdAt);
    // 需人工介入标记：位于状态 badge 旁边，提醒用户该任务需要人工点幾下才能继续
    const manualBadge = task.needsManualIntervention
      ? `<span class="badge badge-needs-manual" title="流程在中段卡住，需人工介入"><span class="badge-dot"></span>需人工介入</span>`
      : '';

    card.innerHTML = `
      <div class="card-header">
        <span class="card-id">#${shortId}</span>
        <span class="card-method ${task.method}">${methodLabel}</span>
      </div>
      <div class="card-product-name">${escapeHtml(task.input?.productName || '未命名')}</div>
      <div class="card-footer">
        <span class="badge badge-${task.status}">
          <span class="badge-dot"></span>
          ${statusLabel}
        </span>
        ${manualBadge}
        <span class="card-time">${timeStr}</span>
      </div>
      ${renderCardActions(task)}`;
  }

  function updateTaskCard(task, card) {
    card.dataset.status = task.status;
    fillCardContent(card, task);
    // 重新绑定点击
    card.onclick = (e) => {
      if (e.target.closest('.btn')) return;
      showTaskDetail(task.id);
    };
  }

  function renderCardActions(task) {
    const actions = [];
    if (task.status === 'review') {
      actions.push(`<button class="btn btn-approve" onclick="event.stopPropagation(); window.__app.approveTask('${task.id}', this)">✓ 通过</button>`);
      actions.push(`<button class="btn btn-reject" onclick="event.stopPropagation(); window.__app.rejectTask('${task.id}', this)">✗ 拒绝</button>`);
    }
    // 需人工介入的失败任务：提供「我已处理→继续」按钮（复用 retry 接口，后端会清理 needsManualIntervention 标记）
    if (task.status === 'failed' && task.needsManualIntervention) {
      actions.push(`<button class="btn btn-retry" onclick="event.stopPropagation(); window.__app.retryTask('${task.id}', this)">✋ 我已处理，继续</button>`);
    } else if (task.status === 'failed' || task.status === 'rejected') {
      actions.push(`<button class="btn btn-retry" onclick="event.stopPropagation(); window.__app.retryTask('${task.id}', this)">↻ 重试</button>`);
    }
    if (actions.length === 0) return '';
    return `<div class="card-actions">${actions.join('')}</div>`;
  }

  // ═══════════════════════════════════════════
  // Modal
  // ═══════════════════════════════════════════
  function showTaskDetail(taskId) {
    const task = tasks.get(taskId);
    if (!task) return;
    const overlay = $('.modal-overlay');
    overlay.dataset.taskId = taskId;
    renderModalContent(task);
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function renderModalContent(task) {
    const shortId = task.id.slice(0, 8);
    const statusLabel = STATUS_LABELS[task.status] || task.status;
    const methodLabel = METHOD_LABELS[task.method] || task.method;

    $('.modal-title').textContent = `任务详情 #${shortId}`;

    const body = $('.modal-body');
    let html = `
      <div class="modal-section">
        <div class="modal-section-title">基本信息</div>
        <div class="modal-info-grid">
          <div class="modal-info-item">
            <div class="modal-info-label">任务ID</div>
            <div class="modal-info-value">${escapeHtml(task.id)}</div>
          </div>
          <div class="modal-info-item">
            <div class="modal-info-label">状态</div>
            <div class="modal-info-value"><span class="badge badge-${task.status}"><span class="badge-dot"></span>${statusLabel}</span></div>
          </div>
          <div class="modal-info-item">
            <div class="modal-info-label">生成方式</div>
            <div class="modal-info-value">${methodLabel}</div>
          </div>
          <div class="modal-info-item">
            <div class="modal-info-label">商品名称</div>
            <div class="modal-info-value">${escapeHtml(task.input?.productName || '-')}</div>
          </div>
          <div class="modal-info-item">
            <div class="modal-info-label">创建时间</div>
            <div class="modal-info-value">${formatTimeFull(task.createdAt)}</div>
          </div>
          <div class="modal-info-item">
            <div class="modal-info-label">更新时间</div>
            <div class="modal-info-value">${formatTimeFull(task.updatedAt)}</div>
          </div>
          <div class="modal-info-item">
            <div class="modal-info-label">重试次数</div>
            <div class="modal-info-value">${task.retryCount ?? 0}</div>
          </div>
          ${task.input?.templateId ? `<div class="modal-info-item"><div class="modal-info-label">模板ID</div><div class="modal-info-value">${escapeHtml(task.input.templateId)}</div></div>` : ''}
        </div>
      </div>`;

    // 卖点
    if (task.input?.sellingPoints) {
      html += `
      <div class="modal-section">
        <div class="modal-section-title">商品卖点</div>
        <div class="modal-prompt">${escapeHtml(task.input.sellingPoints)}</div>
      </div>`;
    }

    // Prompt
    if (task.input?.prompt) {
      html += `
      <div class="modal-section">
        <div class="modal-section-title">Prompt</div>
        <div class="modal-prompt">${escapeHtml(task.input.prompt)}</div>
      </div>`;
    }

    // 商品URL
    if (task.input?.productUrl) {
      html += `
      <div class="modal-section">
        <div class="modal-section-title">商品链接</div>
        <div class="modal-prompt"><a href="${escapeHtml(task.input.productUrl)}" target="_blank" style="color:var(--accent);word-break:break-all">${escapeHtml(task.input.productUrl)}</a></div>
      </div>`;
    }

    // AI 补全标记
    if (task.input?.aiMeta?.enriched) {
      html += `
      <div class="modal-section">
        <div class="modal-section-title" style="display:flex;align-items:center;gap:6px">
          <span class="bp-ai-badge">✨ AI 补全</span>
          <span style="font-size:11px;color:var(--text-secondary)">本任务的卖点 / 产品图 / 商品名称由 AI 前置 Agent 自动填充</span>
        </div>
      </div>`;
    }

    // 视频
    if (task.result?.videoUrl) {
      html += `
      <div class="modal-section">
        <div class="modal-section-title">生成视频</div>
        <div class="modal-video">
          <video controls preload="metadata" src="${escapeHtml(task.result.videoUrl)}"></video>
        </div>
      </div>`;
    }

    // 错误
    if (task.error) {
      html += `
      <div class="modal-section">
        <div class="modal-section-title">错误信息</div>
        <div class="modal-error">${escapeHtml(task.error)}</div>
      </div>`;
    }

    body.innerHTML = html;

    // 底部按钮
    const footer = $('.modal-footer');
    let footerHtml = '';
    if (task.status === 'review') {
      footerHtml += `<button class="btn btn-approve" onclick="window.__app.approveTask('${task.id}', this)">✓ 审核通过</button>`;
      footerHtml += `<button class="btn btn-reject" onclick="window.__app.rejectTask('${task.id}', this)">✗ 审核拒绝</button>`;
    }
    if (task.status === 'failed' && task.needsManualIntervention) {
      // 需人工介入的任务在 modal 里提供「我已处理」按钮，复用 retry 接口
      footerHtml += `<button class="btn btn-retry" onclick="window.__app.retryTask('${task.id}', this)">✋ 我已处理，继续</button>`;
    } else if (task.status === 'failed' || task.status === 'rejected') {
      footerHtml += `<button class="btn btn-retry" onclick="window.__app.retryTask('${task.id}', this)">↻ 重试</button>`;
    }
    if (task.status === 'failed' && Array.isArray(task.failureSnapshots) && task.failureSnapshots.length > 0) {
      footerHtml += `<button class="btn btn-cancel" onclick="window.__app.openDiagModal('${task.id}')">🔍 诊断</button>`;
    }
    footer.innerHTML = footerHtml;
  }

  function closeModal() {
    const overlay = $('.modal-overlay');
    overlay.classList.remove('open');
    overlay.dataset.taskId = '';
    document.body.style.overflow = '';
  }

  // ═══════════════════════════════════════════
  // API Actions
  // ═══════════════════════════════════════════
  // 统一的 POST 请求封装：可选传入 btn，自动 disable + loading，避免重复点击
  async function apiPost(path, btn) {
    const originalLabel = btn ? btn.textContent : null;
    if (btn) {
      if (btn.disabled) return null; // 已锁定，必是重复点击
      btn.disabled = true;
      btn.dataset._origLabel = originalLabel;
      btn.textContent = '⏳ 处理中…';
    }
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) {
        showToast('⚠️ 操作失败', data.error || '未知错误');
        return null;
      }
      return data;
    } catch (err) {
      showToast('⚠️ 网络错误', err.message);
      return null;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset._origLabel || originalLabel || '';
        delete btn.dataset._origLabel;
      }
    }
  }

  async function approveTask(taskId, btn) {
    const data = await apiPost(`/api/tasks/${taskId}/approve`, btn);
    if (data && data.task) {
      handleTaskUpdate(data.task);
      showToast('✅ 已通过', data.task.input?.productName || '');
    }
  }

  async function rejectTask(taskId, btn) {
    const data = await apiPost(`/api/tasks/${taskId}/reject`, btn);
    if (data && data.task) {
      handleTaskUpdate(data.task);
      showToast('🚫 已拒绝', data.task.input?.productName || '');
    }
  }

  async function retryTask(taskId, btn) {
    const data = await apiPost(`/api/tasks/${taskId}/retry`, btn);
    if (data && data.task) {
      handleTaskUpdate(data.task);
      showToast('🔄 已重试', data.task.input?.productName || '');
    }
  }

  // ═══════════════════════════════════════════
  // Create Task Modal
  // ═══════════════════════════════════════════
  function showCreateModal() {
    const overlay = $('#create-modal-overlay');
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeCreateModal() {
    const overlay = $('#create-modal-overlay');
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    // 重置表单
    const form = document.getElementById('create-task-form');
    if (form) form.reset();
    // 重置产品图拽取面板
    resetImagePicker();
    // 重置国家识别字段
    const countryInput = document.getElementById('input-country');
    const personaInput = document.getElementById('input-persona');
    const langInput = document.getElementById('input-video-language');
    if (countryInput) countryInput.value = '';
    if (personaInput) personaInput.value = '';
    if (langInput) langInput.value = '';
  }

  // ============================================================
  // 【前置 Agent】拽取产品图 + Qwen-VL 质量打分 + 勾选面板
  // ============================================================
  // 仅在窗口作用域中保存当前拽取结果，提交后由 download-product-images 转为本地路径
  let _scrapedCandidates = []; // [{url, thumbUrl, score, reason, selected}]

  // ============================================================
  // 国家自动识别：商品链接变更时自动检测目标国家并填充 persona/language
  // ============================================================
  let _countryDetectDebounce = null;

  function setupCountryAutoDetect() {
    const urlInput = document.getElementById('input-product-url');
    if (!urlInput) return;
    urlInput.addEventListener('input', () => {
      clearTimeout(_countryDetectDebounce);
      _countryDetectDebounce = setTimeout(() => autoDetectCountry(urlInput.value.trim()), 600);
    });
    // 粘贴时也触发
    urlInput.addEventListener('paste', () => {
      setTimeout(() => autoDetectCountry(urlInput.value.trim()), 100);
    });
  }

  async function autoDetectCountry(productUrl) {
    if (!productUrl || !/^https?:\/\//i.test(productUrl)) return;
    const countryInput = document.getElementById('input-country');
    const personaInput = document.getElementById('input-persona');
    const langInput = document.getElementById('input-video-language');
    if (!countryInput) return;

    try {
      const res = await fetch(`${API_BASE}/api/detect-country`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productUrl }),
      });
      const data = await res.json();
      if (data.success && data.detected) {
        // 仅在用户未手动填写时自动填充
        if (!countryInput.value.trim()) countryInput.value = data.country;
        if (personaInput && !personaInput.value.trim()) personaInput.value = data.persona;
        if (langInput && !langInput.value.trim()) langInput.value = data.videoLanguage;
        showToast('🌏 国家识别', `已识别为 ${data.country}，视频语言: ${data.videoLanguage}`);
      }
    } catch (err) {
      // 静默失败，不影响主流程
      console.warn('[country-detect] 识别失败:', err.message);
    }
  }

  function resetImagePicker() {
    _scrapedCandidates = [];
    const grid = document.getElementById('image-picker-grid');
    const status = document.getElementById('image-picker-status');
    const hidden = document.getElementById('input-product-images');
    if (grid) { grid.innerHTML = ''; grid.style.display = 'none'; }
    if (status) { status.textContent = ''; status.style.display = 'none'; status.classList.remove('error'); }
    if (hidden) hidden.value = '';
  }

  // 仅在表单中 productName 为空时才回填拽取到的页面标题
  function maybeFillProductName(title) {
    if (!title || typeof title !== 'string') return;
    const input = document.querySelector('#create-task-form input[name="productName"]');
    if (!input) return;
    if (input.value.trim()) return; // 用户已填，不覆盖
    // 手动去个常见尾巴 "| Lazada" / " - Buy ..."跟多余空白
    const cleaned = title
      .replace(/\s*[|\-–—]\s*Lazada.*$/i, '')
      .replace(/\s*-\s*Buy.*$/i, '')
      .trim()
      .slice(0, 80);
    if (!cleaned) return;
    input.value = cleaned;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setImagePickerStatus(text, isError) {
    const status = document.getElementById('image-picker-status');
    if (!status) return;
    status.textContent = text;
    status.style.display = text ? 'block' : 'none';
    status.classList.toggle('error', !!isError);
  }

  function renderImagePickerGrid() {
    const grid = document.getElementById('image-picker-grid');
    if (!grid) return;
    if (_scrapedCandidates.length === 0) {
      grid.style.display = 'none';
      grid.innerHTML = '';
      return;
    }
    grid.style.display = 'grid';
    grid.innerHTML = _scrapedCandidates
      .map((c, i) => {
        const sc = Number(c.score) || 0;
        const cls = sc >= 80 ? 'high' : sc >= 60 ? 'mid' : 'low';
        const dim = c.width && c.height ? `${c.width}×${c.height}` : '';
        const reason = c.reason ? ` · ${c.reason}` : '';
        return `
          <div class="image-picker-card${c.selected ? ' selected' : ''}" data-idx="${i}" title="得分 ${sc}${reason}">
            <img class="ipc-thumb" src="${c.thumbUrl}" referrerpolicy="no-referrer" loading="lazy" alt="img${i + 1}">
            <div class="ipc-meta">
              <span class="ipc-score ${cls}">${sc}</span>
              <span>${dim}</span>
            </div>
            <div class="ipc-checkmark">✓</div>
          </div>`;
      })
      .join('');
    // 点击切换 selected
    grid.querySelectorAll('.image-picker-card').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-idx'));
        if (!Number.isInteger(idx)) return;
        _scrapedCandidates[idx].selected = !_scrapedCandidates[idx].selected;
        el.classList.toggle('selected', _scrapedCandidates[idx].selected);
        updateSelectionTip();
      });
    });
    updateSelectionTip();
  }

  function updateSelectionTip() {
    const total = _scrapedCandidates.length;
    const picked = _scrapedCandidates.filter((c) => c.selected).length;
    setImagePickerStatus(
      `共 ${total} 张候选·已选中 ${picked} 张（提交任务时才会下载到本地）`,
      false
    );
  }

  async function scrapeProductImages() {
    const urlInput = document.getElementById('input-product-url');
    const btn = document.getElementById('btn-scrape-images');
    if (!urlInput || !btn) return;

    const productUrl = urlInput.value.trim();
    if (!productUrl) {
      showToast('⚠️', '请先填写商品链接后再点拽取产品图');
      urlInput.focus();
      return;
    }
    if (!/^https?:\/\//i.test(productUrl)) {
      showToast('⚠️', '商品链接需以 http:// 或 https:// 开头');
      urlInput.focus();
      return;
    }

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ 拽取中…';
    setImagePickerStatus('正在拽取页面主图并调 Qwen-VL 打分，预计 15-40 秒…', false);
    showToast('🖼 拽取产品图', '正在打开页面拽取候选图并打分…');

    try {
      const res = await fetch(`${API_BASE}/api/scrape-product-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productUrl }),
      });
      const data = await res.json();

      if (!data.success) {
        setImagePickerStatus(data.error || '拽取失败', true);
        showToast('⚠️ 拽取失败', data.error || '未返回任何产品图');
        return;
      }
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      if (candidates.length === 0) {
        setImagePickerStatus('未拽取到产品图，该页面可能不含 gallery 或需要登录', true);
        showToast('⚠️ 未找到产品图', '请检查链接是否为有效产品页');
        return;
      }

      // 默认选中前 8 张高分的
      _scrapedCandidates = candidates.map((c, i) => ({
        url: c.url,
        thumbUrl: c.thumbUrl || c.url,
        width: c.width || 0,
        height: c.height || 0,
        score: c.score ?? 0,
        reason: c.reason || '',
        selected: i < 8,
      }));
      renderImagePickerGrid();
      // 顺便回填商品名称（仅在用户未填时）
      maybeFillProductName(data.title);
      showToast('✅ 候选已生成', `共 ${candidates.length} 张，默认选中前 8 张高分项`);
    } catch (err) {
      setImagePickerStatus('网络错误: ' + err.message, true);
      showToast('⚠️ 网络错误', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // ============================================================
  // 【前置 Agent】AI 分析卖点
  // 取当前表单里的商品链接 + 商品名称，调用后端接口后追加到 sellingPoints
  // 追加逻辑：不覆盖现有内容，在原文本末尾插入一个空行 + AI 提炼内容
  // ============================================================
  async function analyzeSellingPoints() {
    const urlInput = document.getElementById('input-product-url');
    const spTextarea = document.getElementById('input-selling-points');
    const btn = document.getElementById('btn-ai-analyze');
    if (!urlInput || !spTextarea || !btn) return;

    const productUrl = urlInput.value.trim();
    if (!productUrl) {
      showToast('⚠️', '请先填写商品链接后再点 AI 分析卖点');
      urlInput.focus();
      return;
    }
    if (!/^https?:\/\//i.test(productUrl)) {
      showToast('⚠️', '商品链接需以 http:// 或 https:// 开头');
      urlInput.focus();
      return;
    }

    const productNameInput = document.querySelector('#create-task-form input[name="productName"]');
    const productName = productNameInput?.value.trim() || '';

    // 进入 loading
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ 分析中…';
    showToast('🤖 AI 卖点分析', '正在抓取产品页并提炼卖点，预计 10-30 秒…');

    try {
      const res = await fetch(`${API_BASE}/api/analyze-selling-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productUrl, productName }),
      });
      const data = await res.json();

      if (!data.success || !data.sellingPoints) {
        showToast('⚠️ 分析失败', data.error || '未返回卖点内容');
        return;
      }

      // 追加逻辑：不覆盖原内容
      const existing = spTextarea.value.replace(/\s+$/, ''); // 去尾部空白
      const aiPart = data.sellingPoints.trim();
      spTextarea.value = existing
        ? `${existing}\n${aiPart}`
        : aiPart;

      // 触发 input 事件，让下游可能绑定的逻辑能感知
      spTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      // 光标置于末尾 + 滚到底
      spTextarea.focus();
      spTextarea.setSelectionRange(spTextarea.value.length, spTextarea.value.length);
      spTextarea.scrollTop = spTextarea.scrollHeight;

      const meta = data.meta || {};
      const metaTip = meta.title ? `（拽取成功：${meta.title.slice(0, 30)}…）` : '';
      // 顺便回填商品名称（仅在用户未填时）
      maybeFillProductName(meta.title);
      showToast('✅ 卖点已追加', metaTip || '已拼接到现有内容后');
    } catch (err) {
      showToast('⚠️ 网络错误', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // ============================================================
  // AI 受众分析
  // 调用后端 /api/analyze-audience，将结果填写到 audience 输入框
  // ============================================================
  async function analyzeAudience() {
    const urlInput = document.getElementById('input-product-url');
    const audienceTextarea = document.getElementById('input-audience');
    const btn = document.getElementById('btn-ai-audience');
    if (!urlInput || !audienceTextarea || !btn) return;

    const productUrl = urlInput.value.trim();
    if (!productUrl) {
      showToast('⚠️', '请先填写商品链接后再点 AI 受众分析');
      urlInput.focus();
      return;
    }
    if (!/^https?:\/\//i.test(productUrl)) {
      showToast('⚠️', '商品链接需以 http:// 或 https:// 开头');
      urlInput.focus();
      return;
    }

    const productNameInput = document.querySelector('#create-task-form input[name="productName"]');
    const productName = productNameInput?.value.trim() || '';
    const spTextarea = document.getElementById('input-selling-points');
    const sellingPoints = spTextarea?.value.trim() || '';

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ 分析中…';
    showToast('🎯 AI 受众分析', '正在分析商品目标受众，预计 10-30 秒…');

    try {
      const res = await fetch(`${API_BASE}/api/analyze-audience`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productUrl, productName, sellingPoints }),
      });
      const data = await res.json();

      if (!data.success || !data.audience) {
        showToast('⚠️ 分析失败', data.error || '未返回受众分析结果');
        return;
      }

      audienceTextarea.value = data.audience;
      audienceTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      audienceTextarea.focus();

      // 顺便回填商品名称（仅在用户未填时）
      maybeFillProductName(data.meta?.title);
      showToast('✅ 受众分析完成', '已填入受众描述，将自动融入 Prompt 提交');
    } catch (err) {
      showToast('⚠️ 网络错误', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  async function submitCreateTask(submitBtnArg) {
    const form = document.getElementById('create-task-form');
    if (!form) return;
    // 整个提交期间锁定创建按钮，避免用户重复点击导致后端连发多个 POST /api/tasks
    const submitBtn =
      submitBtnArg ||
      document.getElementById('btn-create-submit') ||
      document.querySelector('.create-modal .modal-footer .btn-approve');
    if (submitBtn) {
      if (submitBtn.disabled) return; // 已在提交中，拒绝重复进入
      submitBtn.disabled = true;
      submitBtn.dataset._origLabel = submitBtn.textContent;
      submitBtn.textContent = '⏳ 创建中…';
    }
    const restoreBtn = () => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset._origLabel || '创建任务';
        delete submitBtn.dataset._origLabel;
      }
    };
    try {
      await _doSubmitCreateTask(form, submitBtn);
    } finally {
      restoreBtn();
    }
  }

  async function _doSubmitCreateTask(form, submitBtn) {
    const formData = new FormData(form);
    const method = formData.get('method');
    let productName = formData.get('productName')?.toString().trim();
    const prompt = formData.get('prompt')?.toString().trim();
    let sellingPoints = formData.get('sellingPoints')?.toString().trim();
    const audience = formData.get('audience')?.toString().trim();
    const country = formData.get('country')?.toString().trim();
    const persona = formData.get('persona')?.toString().trim();
    const videoLanguage = formData.get('videoLanguage')?.toString().trim();
    const productUrl = formData.get('productUrl')?.toString().trim();
    const templateId = formData.get('templateId')?.toString().trim();

    // 商品链接现为必填
    if (!productUrl) {
      showToast('⚠️', '请填写商品链接');
      document.getElementById('input-product-url')?.focus();
      return;
    }
    if (!/^https?:\/\//i.test(productUrl)) {
      showToast('⚠️', '商品链接需以 http:// 或 https:// 开头');
      document.getElementById('input-product-url')?.focus();
      return;
    }
    if (!prompt) {
      showToast('⚠️', '请输入 Prompt');
      return;
    }

    // 商品名称为空：调后端从链接提取页面标题，顺便补全卖点（追加不覆盖）
    if (!productName) {
      const submitBtn = document.querySelector('.create-modal .modal-footer .btn-approve');
      const originalLabel = submitBtn?.textContent;
      try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ 从链接提取商品名称…'; }
        showToast('🤖', '商品名称为空，正在从链接自动提取…');
        const res = await fetch(`${API_BASE}/api/analyze-selling-points`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productUrl }),
        });
        const data = await res.json();
        const title = data?.meta?.title;
        if (data?.success && title) {
          productName = String(title)
            .replace(/\s*[|\-–—]\s*Lazada.*$/i, '')
            .replace(/\s*-\s*Buy.*$/i, '')
            .trim()
            .slice(0, 80);
          // 同步回填到表单，便于用户看到
          const productNameInput = document.querySelector('#create-task-form input[name="productName"]');
          if (productNameInput) productNameInput.value = productName;

          // 卖点顺便补全：原内容 + \n + AI 内容（不覆盖）
          if (data.sellingPoints) {
            const spTextarea = document.getElementById('input-selling-points');
            const existing = (spTextarea?.value || '').replace(/\s+$/, '');
            const aiPart = String(data.sellingPoints).trim();
            if (aiPart) {
              const merged = existing ? `${existing}\n${aiPart}` : aiPart;
              if (spTextarea) {
                spTextarea.value = merged;
                spTextarea.dispatchEvent(new Event('input', { bubbles: true }));
              }
              sellingPoints = merged;
            }
          }
          showToast('✅ 已提取商品名称', productName);
        } else {
          showToast('⚠️', '从链接提取商品名称失败，请手动填写');
          return;
        }
      } catch (err) {
        showToast('⚠️ 网络错误', err.message || '提取商品名称失败');
        return;
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel || '创建任务'; }
      }
    }

    if (!productName) {
      showToast('⚠️', '商品名称为空，请手动填写');
      return;
    }

    const body = {
      method,
      input: { productName, prompt },
    };
    if (sellingPoints) body.input.sellingPoints = sellingPoints;
    if (audience) body.input.audience = audience;
    if (country) body.input.country = country;
    if (persona) body.input.persona = persona;
    if (videoLanguage) body.input.videoLanguage = videoLanguage;
    if (productUrl) body.input.productUrl = productUrl;
    if (templateId) body.input.templateId = templateId;

    // 【前置 Agent】若用户勾选了拽取的产品图，先下载到本地再提交任务
    const pickedUrls = (_scrapedCandidates || [])
      .filter((c) => c.selected)
      .map((c) => c.url);
    if (pickedUrls.length > 0) {
      if (!productUrl) {
        showToast('⚠️', '下载产品图需要商品链接，请先填入');
        return;
      }
      try {
        showToast('⬇ 下载产品图', `正在下载 ${pickedUrls.length} 张到本地…`);
        const dlRes = await fetch(`${API_BASE}/api/download-product-images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productUrl, urls: pickedUrls }),
        });
        const dlData = await dlRes.json();
        if (!dlData.success || !Array.isArray(dlData.paths) || dlData.paths.length === 0) {
          showToast('⚠️ 下载失败', dlData.error || '未返回本地路径');
          return;
        }
        body.input.productImages = dlData.paths;
      } catch (err) {
        showToast('⚠️ 下载产品图失败', err.message);
        return;
      }
    }

    try {
      const res = await fetch(`${API_BASE}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        // 后端检测到同一 productUrl + method 已有进行中任务时返回 duplicate=true。
        // 不幂等拦截 → 会重复生成任务、浪费 quota。这里提示用户以免疑惑「我点了没反应」。
        if (data.duplicate) {
          showToast('⚠️ 该商品已有进行中任务', `复用原任务 #${(data.task?.id || '').slice(0, 8)}，未重复创建`);
        } else {
          showToast('✅ 任务已创建', productName);
        }
        closeCreateModal();
      } else {
        showToast('⚠️ 创建失败', data.error || '未知错误');
      }
    } catch (err) {
      showToast('⚠️ 网络错误', err.message);
    }
  }

  // ═══════════════════════════════════════════
  // Batch Upload
  // ═══════════════════════════════════════════
  async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // 重置 input 以便重复上传同一文件
    event.target.value = '';

    try {
      let items;
      const ext = file.name.split('.').pop().toLowerCase();

      if (ext === 'json') {
        // JSON 解析
        const text = await file.text();
        try {
          items = JSON.parse(text);
        } catch {
          showToast('⚠️ 解析失败', 'JSON 格式不正确');
          return;
        }
      } else if (ext === 'xlsx' || ext === 'xls') {
        // Excel 解析
        if (typeof XLSX === 'undefined') {
          showToast('⚠️', 'Excel 解析库未加载，请检查网络');
          return;
        }
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        items = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      } else {
        showToast('⚠️', '不支持的文件格式，请使用 .xlsx 或 .json');
        return;
      }

      if (!Array.isArray(items)) {
        showToast('⚠️ 格式错误', '解析结果必须是数组');
        return;
      }

      if (items.length === 0) {
        showToast('⚠️', '文件中没有任务数据');
        return;
      }

      // 验证必填字段
      const validMethods = ['template', 'agent-mode'];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        // 【前置 Agent】缺 productName 但有 productUrl 的行不报错，后续 AI 补全会回填页面标题
        if (!item.productName && !item.productUrl) {
          showToast('⚠️ 校验失败', `第 ${i + 1} 行: 缺 productName（且无 productUrl 供 AI 回填）`);
          return;
        }
        // prompt 为空时：如果有 productUrl 则允许后续 AI 自动生成；否则报错
        if (!item.prompt && !item.productUrl) {
          showToast('⚠️ 校验失败', `第 ${i + 1} 行: 缺少 prompt（且无 productUrl 供 AI 生成）`);
          return;
        }
        if (!item.method || !validMethods.includes(item.method)) {
          items[i].method = 'template'; // 默认模板模式
        }
      }

      // 【前置 Agent】批量 AI 补全：检测以哪些行需要补，弹框确认后跑
      const aiTargets = items
        .map((it, idx) => ({ it, idx }))
        .filter(({ it }) => {
          if (!it.productUrl) return false;
          const noSP = !it.sellingPoints || !String(it.sellingPoints).trim();
          const noAud = !it.audience || !String(it.audience).trim();
          const noPrompt = !it.prompt || !String(it.prompt).trim();
          const noImg =
            !it.productImages ||
            !String(it.productImages).trim();
          return noSP || noAud || noPrompt || noImg;
        });

      let runAI = false;
      if (aiTargets.length > 0) {
        const msg =
          `检测到 ${aiTargets.length}/${items.length} 行有商品链接但缺卖点或产品图。\n\n` +
          `是否跑 AI 自动补全？\n` +
          `· 缺卖点的 → 调 Qwen 提炼后填入\n` +
          `· 缺受众分析的 → 调 AI 识别目标受众\n` +
          `· 缺产品图的 → 调 Qwen-VL 打分后下载 Top 5 高分图\n` +
          `· productName 为空的 → 用页面标题回填\n\n` +
          `并发 3，预计耗时约 ${Math.ceil((aiTargets.length / 3) * 35)} 秒。`;
        runAI = confirm(msg);
      }

      if (runAI) {
        showToast('🤖 批量 AI 补全', `开始处理 ${aiTargets.length} 行…`);
        await enrichItemsWithAI(items, aiTargets.map((t) => t.idx));
      }

      // 给每行打上 AI 标记（用于预览和入库）
      for (const { idx } of aiTargets) {
        items[idx]._aiEnriched = true;
      }

      // 弹预览 modal，用户编辑确认后才创建任务
      showBatchPreview(items);

    } catch (err) {
      showToast('⚠️ 读取失败', err.message);
    }
  }

  // ============================================================
  // 【批量预览面板】显示 / 编辑 / 确认创建
  // ============================================================
  let _batchItems = [];

  function showBatchPreview(items) {
    _batchItems = items;
    document.getElementById('batch-preview-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    renderPreviewTable();
  }

  function closeBatchPreview() {
    document.getElementById('batch-preview-overlay').classList.remove('open');
    document.body.style.overflow = '';
    _batchItems = [];
  }

  function selectAllBatchRows(val) {
    const tbody = document.getElementById('batch-preview-tbody');
    tbody?.querySelectorAll('tr').forEach((tr) => {
      const cb = tr.querySelector('input[type="checkbox"]');
      if (cb) { cb.checked = val; tr.classList.toggle('row-deselected', !val); }
    });
    updatePreviewSummary();
  }

  function updatePreviewSummary() {
    const tbody = document.getElementById('batch-preview-tbody');
    const total = tbody?.querySelectorAll('tr').length || 0;
    const checked = tbody?.querySelectorAll('input[type="checkbox"]:checked').length || 0;
    const el = document.getElementById('batch-preview-summary');
    if (el) el.textContent = `共 ${total} 行，已勾选 ${checked} 行将被创建为任务`;
  }

  function _onBatchRowCheck(cb) {
    const tr = cb.closest('tr');
    if (tr) tr.classList.toggle('row-deselected', !cb.checked);
    updatePreviewSummary();
  }

  function renderPreviewTable() {
    const tbody = document.getElementById('batch-preview-tbody');
    if (!tbody) return;
    tbody.innerHTML = _batchItems.map((item, i) => {
      const isAI = !!item._aiEnriched;
      const badge = isAI
        ? '<span class="bp-ai-badge">✨ AI</span>'
        : '<span class="bp-manual-badge">手动</span>';
      let imgPaths = [];
      if (Array.isArray(item.productImages)) imgPaths = item.productImages;
      else if (typeof item.productImages === 'string' && item.productImages.trim())
        imgPaths = item.productImages.split(',').map((s) => s.trim()).filter(Boolean);
      const imgCells = imgPaths.length > 0
        ? imgPaths.map((p, imgIdx) => {
            const isUrl = /^https?:\/\//i.test(p);
            const label = p.split('/').pop() || `img${imgIdx + 1}`;
            const inner = isUrl
              ? `<img src="${p}" referrerpolicy="no-referrer" loading="lazy">`
              : `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:9px;text-align:center;padding:2px;word-break:break-all;color:var(--text-secondary)">${escapeHtml(label)}</div>`;
            return `<div class="bp-img-thumb" data-row="${i}" data-img="${imgIdx}" title="${escapeHtml(label)}">${inner}<div class="bp-img-del">×</div></div>`;
          }).join('')
        : '<span style="color:var(--text-secondary);font-size:11px">无</span>';
      return `<tr data-row="${i}"><td class="col-check"><input type="checkbox" checked onchange="window.__app._onBatchRowCheck(this)"></td><td class="col-idx">${i + 1}</td><td class="col-name" contenteditable="true">${escapeHtml(String(item.productName || ''))}</td><td class="col-sp" contenteditable="true">${escapeHtml(String(item.sellingPoints || '')).replace(/\n/g, '<br>')}</td><td class="col-prompt" contenteditable="true">${escapeHtml(String(item.prompt || ''))}</td><td class="col-images"><div class="bp-img-grid">${imgCells}</div></td><td class="col-src">${badge}</td></tr>`;
    }).join('');
    tbody.querySelectorAll('.bp-img-thumb').forEach((el) => {
      el.addEventListener('click', () => el.classList.toggle('deleted'));
    });
    updatePreviewSummary();
  }

  function exportBatchExcel() {
    if (typeof XLSX === 'undefined') { showToast('⚠️', 'XLSX 库未加载'); return; }
    const collected = collectPreviewData();
    const rows = collected.map((c) => ({
      method: c.method, productName: c.productName, prompt: c.prompt,
      sellingPoints: c.sellingPoints, productUrl: c.productUrl || '',
      productImages: Array.isArray(c.productImages) ? c.productImages.join(',') : '',
      aiEnriched: c._aiEnriched ? 'yes' : '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'tasks');
    XLSX.writeFile(wb, `batch_preview_${Date.now()}.xlsx`);
    showToast('⬇ 已导出', 'Excel 文件已下载');
  }

  function collectPreviewData() {
    const tbody = document.getElementById('batch-preview-tbody');
    if (!tbody) return [];
    const result = [];
    tbody.querySelectorAll('tr').forEach((tr, i) => {
      const cb = tr.querySelector('input[type="checkbox"]');
      if (!cb || !cb.checked) return;
      const cells = tr.querySelectorAll('td');
      const productName = (cells[2]?.innerText || '').trim();
      const sellingPoints = (cells[3]?.innerText || '').trim();
      const prompt = (cells[4]?.innerText || '').trim();
      const origItem = _batchItems[i] || {};
      let imgPaths = Array.isArray(origItem.productImages)
        ? [...origItem.productImages]
        : typeof origItem.productImages === 'string'
          ? origItem.productImages.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
      const activeThumbs = cells[5]?.querySelectorAll('.bp-img-thumb:not(.deleted)') || [];
      const kept = [];
      activeThumbs.forEach((el) => {
        const idx = parseInt(el.getAttribute('data-img'));
        if (!isNaN(idx) && imgPaths[idx]) kept.push(imgPaths[idx]);
      });
      result.push({ method: origItem.method || 'template', productName, prompt, sellingPoints,
        audience: origItem.audience || '',
        productUrl: origItem.productUrl || '', productImages: kept,
        templateId: origItem.templateId || '', trendType: origItem.trendType || '',
        trendCategory: origItem.trendCategory || '', trendIndex: origItem.trendIndex || '',
        referenceVideo: origItem.referenceVideo || '', _aiEnriched: !!origItem._aiEnriched });
    });
    return result;
  }

  async function confirmBatchCreate() {
    const items = collectPreviewData();
    if (items.length === 0) { showToast('⚠️', '没有勾选任何行'); return; }
    const btn = document.getElementById('btn-batch-confirm');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 创建中…'; }
    
    // 限速：每个任务间隔 30 秒创建，避免短时间内大量任务涌入
    // 导致页面池快速轮转引发 TikTok 端网络拥塞（ERR_HTTP2_PING_FAILED）
    const CREATE_INTERVAL_MS = 30_000;
    let success = 0, failed = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.productName) { failed++; continue; }
      // prompt 为空或非模板格式时，使用标准 {{variable}} 模板（后端 buildCombinedPrompt 会解析）
      const hasTemplate = item.prompt && item.prompt.includes('{{');
      const effectivePrompt = hasTemplate ? item.prompt : [
        'Based on the latest TikTok content trends, generate a ready-to-run video prompt for this product, designed to maximize GMV performance. High-end smartphone, UGC aesthetic, handheld shake, natural light, raw footage, no filter, subtle camera noise, organic texture, amateur style, vertical format. imperfections, micro-movements, realistic live-action, natural skin texture, natural facial movement, physically plausible motion, documentary-style lighting, handheld camera feel. No subtitles, no text overlays.',
        'Use TikTok trending video style to generate a video ad for "{{productName}}",',
        'featuring {{persona}} speaking in {{videoLanguage}}.',
        'Target audience: {{audience}}.',
        'Highlight these key features: {{sellingPoints}}.',
      ].join('\n');
      const body = { method: item.method, input: { productName: item.productName, prompt: effectivePrompt } };
      if (item.sellingPoints) body.input.sellingPoints = item.sellingPoints;
      if (item.audience) body.input.audience = item.audience;
      if (item.country) body.input.country = item.country;
      if (item.persona) body.input.persona = item.persona;
      if (item.videoLanguage) body.input.videoLanguage = item.videoLanguage;
      if (item.productUrl) body.input.productUrl = item.productUrl;
      if (item.templateId) body.input.templateId = item.templateId;
      if (item.trendType) body.input.trendType = item.trendType;
      if (item.trendCategory) body.input.trendCategory = item.trendCategory;
      if (item.trendIndex) body.input.trendIndex = parseInt(item.trendIndex) || 1;
      if (item.referenceVideo) body.input.referenceVideo = item.referenceVideo;
      if (item.productImages && item.productImages.length > 0) body.input.productImages = item.productImages;
      if (item._aiEnriched) body.input.aiMeta = { enriched: true };
      try {
        const res = await fetch(`${API_BASE}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        data.success ? success++ : failed++;
      } catch { failed++; }
      // 限速：除最后一个外，每个任务创建后等待 30 秒再创建下一个
      if (i < items.length - 1) {
        if (btn) { btn.textContent = `⏳ 创建中… (${i + 1}/${items.length}) 下一个 30s 后创建`; }
        await new Promise(r => setTimeout(r, CREATE_INTERVAL_MS));
      }
    }
    showToast('✅ 批量创建完成', `成功 ${success} 个，失败 ${failed} 个`);
    if (btn) { btn.disabled = false; btn.textContent = '✅ 确认创建任务'; }
    closeBatchPreview();
  }

  // ============================================================
  // 【前置 Agent / 批量】为多行并发 AI 补全（并发 3，429 退避重试一次）
  // 原位修改 items[idx]：sellingPoints / productImages / productName
  // 单行失败仅 console.warn，不造成整体中断
  // ============================================================
  async function enrichItemsWithAI(items, targetIndexes) {
    const CONCURRENCY = 3;
    const total = targetIndexes.length;
    let done = 0;
    let okCount = 0;
    let failCount = 0;

    // 简易 promise pool：三个 worker 从队列拿 index 消费
    const queue = [...targetIndexes];
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      while (queue.length > 0) {
        const idx = queue.shift();
        if (idx == null) break;
        try {
          await enrichOneItem(items[idx]);
          okCount++;
        } catch (err) {
          failCount++;
          console.warn(`[batch-ai] 行 #${idx + 1} 补全失败:`, err);
        } finally {
          done++;
          // 每 3 个推一次进度（避免 toast 满屏）
          if (done === total || done % 3 === 0) {
            showToast('⏳ AI 补全', `进度 ${done}/${total}、成功 ${okCount}、失败 ${failCount}`);
          }
        }
      }
    });
    await Promise.all(workers);
    showToast('✅ AI 补全完成', `成功 ${okCount}/${total}，失败 ${failCount}`);
  }

  /** 对单个 item 补齐卖点 / 产品图 / 商品名。原位修改 item。 */
  async function enrichOneItem(item) {
    if (!item || !item.productUrl) return;
    const productUrl = String(item.productUrl).trim();

    const noSP = !item.sellingPoints || !String(item.sellingPoints).trim();
    const noAud = !item.audience || !String(item.audience).trim();
    const noCountry = !item.country || !String(item.country).trim();
    const noImg =
      !item.productImages ||
      (Array.isArray(item.productImages) && item.productImages.length === 0) ||
      (typeof item.productImages === 'string' && !item.productImages.trim());
    const noName = !item.productName || !String(item.productName).trim();

    // 0) 国家识别：仅域名解析，不调 LLM，很快
    if (noCountry) {
      try {
        const data = await fetchWithRetry(`${API_BASE}/api/detect-country`, { productUrl });
        if (data?.success && data.detected) {
          item.country = data.country;
          if (!item.persona || !String(item.persona).trim()) item.persona = data.persona;
          if (!item.videoLanguage || !String(item.videoLanguage).trim()) item.videoLanguage = data.videoLanguage;
        }
      } catch (err) {
        console.warn('[batch-ai] country-detect 失败，跳过:', err.message);
      }
    }

    // 1) 卖点分析：analyze-selling-points 会顺便返回 meta.title。
    //    使用需要卖点、或需要名称时调用。
    if (noSP || noName) {
      try {
        const data = await fetchWithRetry(`${API_BASE}/api/analyze-selling-points`, {
          productUrl,
          productName: item.productName || '',
        });
        if (data?.success) {
          if (noSP && data.sellingPoints) {
            // 追加逻辑：原内容 + \n + AI 内容（批量场景下可能 noSP 已为真则 existing 为空）
            const existing = String(item.sellingPoints || '').replace(/\s+$/, '');
            item.sellingPoints = existing
              ? `${existing}\n${data.sellingPoints.trim()}`
              : data.sellingPoints.trim();
          }
          if (noName && data.meta?.title) {
            item.productName = String(data.meta.title)
              .replace(/\s*[|\-\u2013\u2014]\s*Lazada.*$/i, '')
              .replace(/\s*-\s*Buy.*$/i, '')
              .trim()
              .slice(0, 80);
          }
        }
      } catch (err) {
        console.warn('[batch-ai] selling-points 失败，跳过:', err.message);
      }
    }
    
    // 1.5) 受众分析：仅在没有受众描述时调用
    if (noAud) {
      try {
        const data = await fetchWithRetry(`${API_BASE}/api/analyze-audience`, {
          productUrl,
          productName: item.productName || '',
          sellingPoints: item.sellingPoints || '',
        });
        if (data?.success && data.audience) {
          item.audience = data.audience.trim();
        }
      } catch (err) {
        console.warn('[batch-ai] audience 失败，跳过:', err.message);
      }
    }

    // 1.8) Prompt 强制使用模板格式：无论原 prompt 是否存在，只要不含 {{variable}} 就替换为标准模板
    //    确保 country/persona/videoLanguage 等字段能被 buildCombinedPrompt 正确注入
    const currentPrompt = String(item.prompt || '').trim();
    const hasTemplateVars = currentPrompt.includes('{{');
    if (!currentPrompt || !hasTemplateVars) {
      // 使用 {{variable}} 模板语法，后端会自动替换为实际值
      item.prompt = [
        'Based on the latest TikTok content trends, generate a ready-to-run video prompt for this product, designed to maximize GMV performance. High-end smartphone, UGC aesthetic, handheld shake, natural light, raw footage, no filter, subtle camera noise, organic texture, amateur style, vertical format. imperfections, micro-movements, realistic live-action, natural skin texture, natural facial movement, physically plausible motion, documentary-style lighting, handheld camera feel. No subtitles, no text overlays.',
        'Use TikTok trending video style to generate a video ad for "{{productName}}",',
        'featuring {{persona}} speaking in {{videoLanguage}}.',
        'Target audience: {{audience}}.',
        'Highlight these key features: {{sellingPoints}}.',
      ].join('\n');
    }

    // 2) 产品图：调 Qwen-VL 打分后取 Top 5 高分下载
    if (noImg) {
      try {
        const data = await fetchWithRetry(`${API_BASE}/api/scrape-product-images`, {
          productUrl,
        });
        if (data?.success && Array.isArray(data.candidates) && data.candidates.length > 0) {
          // 后端已按分数倒序返回，取前 5 张
          const top5 = data.candidates.slice(0, 5).map((c) => c.url);
          const dl = await fetchWithRetry(`${API_BASE}/api/download-product-images`, {
            productUrl,
            urls: top5,
          });
          if (dl?.success && Array.isArray(dl.paths) && dl.paths.length > 0) {
            item.productImages = dl.paths;
          }
          // productName 补填（如果之前 selling-points 失败了但这里拿到了 title）
          if (noName && data.title && (!item.productName || !String(item.productName).trim())) {
            item.productName = String(data.title)
              .replace(/\s*[|\-–—]\s*Lazada.*$/i, '')
              .replace(/\s*-\s*Buy.*$/i, '')
              .trim()
              .slice(0, 80);
          }
        }
      } catch (err) {
        console.warn('[batch-ai] product-images 失败，跳过:', err.message);
      }
    }
  }

  /** 带 429/5xx 退避重试的 fetch（重试最多 1 次） */
  async function fetchWithRetry(url, payload) {
    const doFetch = async () => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    let { status, json } = await doFetch();
    // 429 限流 / 503 服务不可用 退避后重试
    if (status === 429 || status === 503 || (status >= 500 && status < 600)) {
      await new Promise((r) => setTimeout(r, 5000));
      const retry = await doFetch();
      status = retry.status;
      json = retry.json;
    }
    if (status >= 400) {
      throw new Error(json?.error || `HTTP ${status}`);
    }
    return json;
  }

  // ═══════════════════════════════════════════
  // Notifications
  // ═══════════════════════════════════════════
  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        notificationGranted = perm === 'granted';
      });
    } else {
      notificationGranted = Notification.permission === 'granted';
    }
  }

  function sendBrowserNotification(title, body) {
    if (!notificationGranted) return;
    try {
      new Notification(title, { body, icon: '🔔' });
    } catch { /* ignore */ }
  }

  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch { /* audio context not available */ }
  }

  // ─── Toast ─────────────────────────────────
  function showToast(icon, text) {
    const container = $('.toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeHtml(text)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, 3500);
  }

  // ═══════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function formatTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatTimeFull(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // ═══════════════════════════════════════════
  // Selector Manager Modal
  // ═══════════════════════════════════════════
  let _selectorState = null; // { defaults, current, overrides, stats }

  async function openSelectorsModal() {
    try {
      const res = await fetch(`${API_BASE}/api/selectors`);
      const data = await res.json();
      if (!data.success) {
        showToast('⚠️ 加载失败', data.error || '');
        return;
      }
      _selectorState = data;
      renderSelectorTable();
      const ov = $('#selectors-modal-overlay');
      if (ov) {
        ov.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
    } catch (err) {
      showToast('⚠️ 网络错误', err.message);
    }
  }

  function closeSelectorsModal() {
    const ov = $('#selectors-modal-overlay');
    if (ov) {
      ov.classList.remove('open');
      document.body.style.overflow = '';
    }
  }

  function renderSelectorTable() {
    const wrap = $('#selector-table-wrap');
    if (!wrap || !_selectorState) return;
    const { defaults, overrides, stats } = _selectorState;
    const keys = Object.keys(defaults).sort();
    const rows = keys.map((k) => {
      const def = defaults[k] || '';
      const overridden = !!(overrides && overrides[k]);
      const cur = overridden ? overrides[k] : '';
      const st = (stats && stats[k]) || { hits: 0, misses: 0 };
      return `
        <tr data-key="${escapeHtml(k)}">
          <td class="sel-path">${escapeHtml(k)}
            ${overridden ? '<span class="sel-tag sel-tag-override">override</span>' : ''}
          </td>
          <td><textarea class="sel-input" rows="2" data-key="${escapeHtml(k)}" placeholder="${escapeHtml(def)}">${escapeHtml(cur)}</textarea></td>
          <td class="sel-stats">✓ ${st.hits || 0} / ✗ ${st.misses || 0}</td>
          <td><button class="btn-link" data-default="${encodeURIComponent(def)}" data-key="${escapeHtml(k)}" onclick="window.__app._fillSelectorDefault(this)">填入默认</button></td>
        </tr>`;
    }).join('');
    wrap.innerHTML = `
      <table class="selector-table">
        <thead><tr><th>选择器路径</th><th>当前覆盖值（留空走默认）</th><th>命中/未命中</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function _fillSelectorDefault(btn) {
    const key = btn.getAttribute('data-key');
    const def = decodeURIComponent(btn.getAttribute('data-default') || '');
    const ta = document.querySelector(`textarea.sel-input[data-key="${CSS.escape(key)}"]`);
    if (ta) ta.value = def;
  }

  async function saveSelectorOverrides() {
    const tas = document.querySelectorAll('textarea.sel-input');
    const newOverrides = {};
    const defaults = (_selectorState && _selectorState.defaults) || {};
    tas.forEach((ta) => {
      const k = ta.getAttribute('data-key');
      const v = (ta.value || '').trim();
      if (v && v !== (defaults[k] || '')) {
        newOverrides[k] = v;
      }
    });
    try {
      const res = await fetch(`${API_BASE}/api/selectors`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: newOverrides }),
      });
      const data = await res.json();
      if (!data.success) {
        showToast('⚠️ 保存失败', data.error || '');
        return;
      }
      showToast('✅ 已保存并生效', `${Object.keys(newOverrides).length} 项覆盖`);
      closeSelectorsModal();
    } catch (err) {
      showToast('⚠️ 网络错误', err.message);
    }
  }

  async function resetAllSelectorOverrides() {
    if (!confirm('确认清除所有选择器覆盖、恢复出厂默认？')) return;
    try {
      const res = await fetch(`${API_BASE}/api/selectors`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: {} }),
      });
      const data = await res.json();
      if (!data.success) {
        showToast('⚠️ 重置失败', data.error || '');
        return;
      }
      showToast('✅ 已恢复默认', '');
      closeSelectorsModal();
    } catch (err) {
      showToast('⚠️ 网络错误', err.message);
    }
  }

  // ═══════════════════════════════════════════
  // Failure Diagnostic Modal
  // ═══════════════════════════════════════════
  function openDiagModal(taskId) {
    const task = tasks.get(taskId);
    if (!task) return;
    const snaps = Array.isArray(task.failureSnapshots) ? task.failureSnapshots : [];
    const errInfo = task.errorInfo || {};
    const body = $('#diag-modal-body');
    if (!body) return;
    let html = `
      <div class="modal-section">
        <div class="modal-section-title">错误归因</div>
        <div class="modal-info-grid">
          <div class="modal-info-item"><div class="modal-info-label">错误码</div><div class="modal-info-value"><span class="badge badge-failed">${escapeHtml(errInfo.code || 'UNKNOWN')}</span></div></div>
          <div class="modal-info-item"><div class="modal-info-label">发生时间</div><div class="modal-info-value">${escapeHtml(formatTimeFull(errInfo.occurredAt || task.updatedAt))}</div></div>
          <div class="modal-info-item" style="grid-column:span 2"><div class="modal-info-label">错误信息</div><div class="modal-info-value modal-error">${escapeHtml(errInfo.message || task.error || '无')}</div></div>
        </div>
      </div>`;
    if (snaps.length === 0) {
      html += `<div class="modal-section"><div class="modal-section-title">现场快照</div><div class="empty-state-hint">本次失败未生成快照（可能是启动阶段错误）</div></div>`;
    } else {
      html += `<div class="modal-section"><div class="modal-section-title">现场快照（最近 ${snaps.length} 次）</div>`;
      snaps.slice().reverse().forEach((s, idx) => {
        const dirParam = encodeURIComponent(s.dir);
        html += `
          <div class="diag-snapshot">
            <div class="diag-snapshot-meta">
              <span class="badge badge-failed">${escapeHtml(s.errorCode || '?')}</span>
              <span style="color:var(--text-secondary)">${escapeHtml(formatTimeFull(s.timestamp))}</span>
              <a href="${escapeHtml(s.url || '#')}" target="_blank" style="color:var(--accent);font-size:11px;word-break:break-all">${escapeHtml((s.url || '').slice(0, 80))}</a>
            </div>
            ${s.hasScreenshot ? `<img class="diag-screenshot" src="${API_BASE}/api/snapshots/file?dir=${dirParam}&name=screenshot.png" alt="snapshot ${idx}" loading="lazy" />` : '<div class="empty-state-hint">无截图</div>'}
            <div class="diag-links">
              ${s.hasHtml ? `<a target="_blank" href="${API_BASE}/api/snapshots/file?dir=${dirParam}&name=page.html">查看DOM快照</a>` : ''}
              <a target="_blank" href="${API_BASE}/api/snapshots/meta?dir=${dirParam}">meta.json</a>
            </div>
          </div>`;
      });
      html += `</div>`;
    }
    body.innerHTML = html;
    const ov = $('#diag-modal-overlay');
    if (ov) {
      ov.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeDiagModal() {
    const ov = $('#diag-modal-overlay');
    if (ov) {
      ov.classList.remove('open');
      document.body.style.overflow = '';
    }
  }

  // ─── 暴露给 HTML onclick 的接口 ──────────────
  window.__app = {
    approveTask,
    rejectTask,
    retryTask,
    showTaskDetail,
    closeModal,
    showCreateModal,
    closeCreateModal,
    submitCreateTask,
    handleFileUpload,
    analyzeSellingPoints,
    analyzeAudience,
    scrapeProductImages,
    // 选择器管理
    openSelectorsModal,
    closeSelectorsModal,
    saveSelectorOverrides,
    resetAllSelectorOverrides,
    _fillSelectorDefault,
    // 诊断模态框
    openDiagModal,
    closeDiagModal,
    // 批量预览面板
    closeBatchPreview,
    selectAllBatchRows,
    exportBatchExcel,
    confirmBatchCreate,
    _onBatchRowCheck,
  };

  // ─── 启动 ──────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
