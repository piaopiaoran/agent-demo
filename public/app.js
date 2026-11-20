/* ============================================================
   Nova Agent 前端：原生 JS，无构建步骤
   职责：用户输入 → POST /api/chat（SSE）→ 流式渲染 token / 工具轨迹 / 引用
   ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  threadId: localStorage.getItem('nova.threadId') || newThreadId(),
  streaming: false,
  config: null,
  toolNodes: new Map(), // runId -> DOM 节点
};

function newThreadId() {
  const id =
    (crypto.randomUUID && crypto.randomUUID()) ||
    `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  localStorage.setItem('nova.threadId', safe);
  return safe;
}

/* ------------------------------------------------------------ 工具函数 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 极简 Markdown 渲染：标题 / 粗体 / 行内代码 / 代码块 / 列表 / 引用 / 链接 */
function renderMarkdown(src) {
  const codeBlocks = [];

  let text = String(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000BLOCK${index}\u0000`;
  });

  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^>\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  text = text.replace(/^[-*]\s+(.+)$/gm, '<div class="li">• $1</div>');
  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, index) => codeBlocks[Number(index)]);

  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      if (/^<(pre|h3|blockquote|div)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
}

function nearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 160;
}

function scrollToBottom(force = false) {
  const box = $('messages');
  if (force || nearBottom()) box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------------------ 欢迎屏 */

const SUGGESTIONS = [
  {
    title: '本地工具：算数 + 时间',
    desc: '算一下 (128*3+96)/7 的平方根，并告诉我现在上海的日期',
    value: '算一下 (128*3+96)/7 的平方根，并告诉我现在上海的日期',
  },
  {
    title: 'RAG + 技能：读文档写报告',
    desc: '用调研报告技能，把我上传的文档总结成 5 条结论',
    value: '用调研报告技能，把我上传的文档总结成 5 条结论，标注来源',
  },
  {
    title: 'MCP：远程工具调用',
    desc: '用 MCP 的顺序思考工具，帮我拆解一个学习 LangGraph 的 4 周计划',
    value: '用顺序思考工具，帮我拆解一个学习 LangGraph 的 4 周计划，然后存成笔记',
  },
  {
    title: '网页阅读 + 沉淀',
    desc: '读一下 https://example.com 的正文，用三句话概括',
    value: '读一下 https://example.com 的正文，用三句话概括，并存成一条笔记',
  },
];

function renderWelcome() {
  const box = $('messages');
  box.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'welcome';
  wrap.innerHTML = `
    <h2>今天想让它做什么？</h2>
    <p>这是一个单 Agent：一个 LLM + 一张 LangGraph 图 + 四类工具（本地 / RAG / 技能 / MCP）。
       它自己决定先检索、先加载技能，还是直接调工具。</p>
    <div class="welcome-grid">
      ${SUGGESTIONS.map(
        (item, index) => `
        <button class="suggest" data-index="${index}">
          <b>${escapeHtml(item.title)}</b>
          <span>${escapeHtml(item.desc)}</span>
        </button>`,
      ).join('')}
    </div>`;
  box.appendChild(wrap);

  wrap.querySelectorAll('.suggest').forEach((button) => {
    button.addEventListener('click', () => {
      const item = SUGGESTIONS[Number(button.dataset.index)];
      $('input').value = item.value;
      autoResize();
      sendMessage();
    });
  });
}

/* ------------------------------------------------------------ 侧栏渲染 */

function renderStatus(cfg) {
  $('stModel').textContent = cfg.model || '—';
  $('stModel').className = cfg.llmConfigured ? 'ok' : 'err';
  $('stModel').title = cfg.llmConfigured ? `${cfg.baseUrl}` : '未配置 OPENAI_API_KEY';

  const mcp = cfg.mcp || {};
  const okServers = Object.values(mcp.servers || {}).filter((s) => s.state === 'ok').length;
  const totalServers = Object.keys(mcp.servers || {}).length;
  $('stMcp').textContent = `${okServers}/${totalServers}`;
  $('stMcp').className = okServers > 0 ? 'ok' : 'warn';
  $('stMcp').title = Object.entries(mcp.servers || {})
    .map(([name, s]) => `${s.label || name}: ${s.state}${s.error ? ` - ${s.error}` : ''}`)
    .join('\n');

  const rag = cfg.rag || {};
  $('stRag').textContent = `${rag.documents || 0} 篇`;
  $('stRag').className = rag.chunks ? 'ok' : '';
  $('stRag').title = `片段 ${rag.chunks || 0} · 索引 ${rag.backend}${rag.vectorized ? '（向量）' : '（词法）'}`;

  updateMcpPill(mcp);
}

function updateMcpPill(mcp) {
  const pill = $('mcpPill');
  const servers = Object.values(mcp?.servers || {});
  const ok = servers.filter((s) => s.state === 'ok');
  const failed = servers.filter((s) => s.state === 'error');

  if (!servers.length) {
    pill.textContent = 'MCP 未配置';
    pill.className = 'pill';
    return;
  }
  if (mcp.state === 'loading' || servers.some((s) => s.state === 'pending')) {
    pill.textContent = `MCP 连接中 ${ok.length}/${servers.length}`;
    pill.className = 'pill warn';
  } else if (failed.length) {
    pill.textContent = `MCP ${ok.length}/${servers.length}（${failed.length} 个失败）`;
    pill.className = 'pill warn';
    pill.title = failed.map((s) => `${s.label}: ${s.error}`).join('\n');
  } else {
    pill.textContent = `MCP ${servers.length} 个已连接 · ${mcp.toolCount} 工具`;
    pill.className = 'pill ok';
    pill.title = servers
      .map((s) => `${s.label}：${(s.toolNames || []).join(', ') || '无工具'}`)
      .join('\n');
  }
}

const GROUP_LABEL = {
  local: '本地工具',
  rag: 'RAG 检索',
  skill: 'Skill 技能',
  mcp: 'MCP 远程',
};

function toolItem(tool) {
  return `<div class="tool-item" title="${escapeHtml(tool.description || '')}">
    <span class="dot ${tool.group}"></span>
    <span class="name">${escapeHtml(tool.label || tool.name)}</span>
    <span class="code">${escapeHtml(tool.name)}</span>
  </div>`;
}

function renderTools(cfg) {
  const wrap = $('toolGroups');
  wrap.innerHTML = '';

  const total = (cfg.tools || []).length;
  $('toolCount').textContent = total;

  for (const group of ['local', 'rag', 'skill', 'mcp']) {
    const tools = (cfg.tools || []).filter((tool) => tool.group === group);

    if (group === 'skill') {
      const skills = cfg.skills || [];
      const box = document.createElement('div');
      box.className = 'tool-group';
      box.innerHTML = `
        <div class="tool-group-label"><span class="dot skill"></span><b>${GROUP_LABEL[group]}</b>
          <span>${skills.length} 个技能包 + ${tools.length} 个工具</span></div>
        <div class="tool-list">
          ${skills
            .map(
              (skill) => `<div class="tool-item" title="${escapeHtml(skill.description)}">
                <span class="dot skill"></span>
                <span class="name">${escapeHtml(skill.title)}</span>
                <span class="code">${escapeHtml(skill.name)}</span>
              </div>`,
            )
            .join('')}
          ${tools.map(toolItem).join('')}
        </div>`;
      wrap.appendChild(box);
      continue;
    }

    if (group === 'mcp') {
      const servers = Object.entries(cfg.mcp?.servers || {});
      const box = document.createElement('div');
      box.className = 'tool-group';
      box.innerHTML = `
        <div class="tool-group-label"><span class="dot mcp"></span><b>${GROUP_LABEL[group]}</b>
          <span>${servers.length} 个 server · ${tools.length} 个工具</span></div>
        <div class="tool-list">
          ${servers
            .map(([name, server]) => {
              const dotStyle =
                server.state === 'error'
                  ? 'background:#dc2626'
                  : server.state === 'pending'
                    ? 'background:#c9cdd4'
                    : '';
              const detail =
                server.state === 'ok'
                  ? `${server.tools} 个工具`
                  : server.state === 'pending'
                    ? '连接中…'
                    : server.error || server.state;
              return `<div class="tool-item" title="${escapeHtml(detail)}">
                <span class="dot ${server.state === 'ok' ? 'mcp' : ''}" style="${dotStyle}"></span>
                <span class="name">${escapeHtml(server.label || name)}</span>
                <span class="code">${escapeHtml(detail).slice(0, 40)}</span>
              </div>`;
            })
            .join('')}
        </div>`;
      wrap.appendChild(box);
      continue;
    }

    if (!tools.length) continue;
    const box = document.createElement('div');
    box.className = 'tool-group';
    box.innerHTML = `
      <div class="tool-group-label"><span class="dot ${group}"></span><b>${GROUP_LABEL[group]}</b>
        <span>${tools.length} 个</span></div>
      <div class="tool-list">${tools.map(toolItem).join('')}</div>`;
    wrap.appendChild(box);
  }
}

/* ------------------------------------------------------------ 知识库 */

async function loadDocuments() {
  try {
    const response = await fetch('/api/rag/documents');
    const data = await response.json();
    const list = $('docList');
    list.innerHTML = '';

    $('ragCount').textContent = `${data.stats?.documents || 0} 篇`;

    if (!data.documents?.length) {
      list.innerHTML = '<li class="doc-empty" style="border:none;background:none">还没有文档，上传一个试试</li>';
      return;
    }

    for (const doc of data.documents) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="doc-name" title="${escapeHtml(doc.source)}">${escapeHtml(doc.source)}</span>
        <span class="doc-meta">${doc.chunks} 块</span>
        <button class="doc-del" title="删除">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" />
          </svg>
        </button>`;
      li.querySelector('.doc-del').addEventListener('click', async () => {
        await fetch(`/api/rag/documents/${encodeURIComponent(doc.docId)}`, { method: 'DELETE' });
        toast('已删除文档');
        loadDocuments();
      });
      list.appendChild(li);
    }
  } catch (error) {
    console.error(error);
  }
}

async function uploadFile(file) {
  if (!file) return;
  const dropzone = $('dropzone');
  dropzone.classList.add('busy');
  try {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/rag/upload', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '上传失败');
    toast(`已入库：${data.document.source}（${data.document.chunks} 个片段）`);
    await loadDocuments();
    await refreshConfig();
  } catch (error) {
    toast(`上传失败：${error.message}`);
  } finally {
    dropzone.classList.remove('busy');
    $('fileInput').value = '';
  }
}

/* ------------------------------------------------------------ 消息渲染 */

function clearMessages() {
  $('messages').innerHTML = '';
}

function appendUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = '<div class="body"></div>';
  el.querySelector('.body').textContent = text;
  $('messages').appendChild(el);
  scrollToBottom(true);
  return el;
}

function appendAssistantMessage() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `
    <div class="avatar">N</div>
    <div class="body">
      <div class="trace"></div>
      <div class="content"></div>
      <div class="citations"></div>
    </div>`;
  $('messages').appendChild(el);
  scrollToBottom(true);
  return {
    root: el,
    trace: el.querySelector('.trace'),
    content: el.querySelector('.content'),
    citations: el.querySelector('.citations'),
  };
}

function appendError(message) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `
    <div class="avatar" style="background:#f3f4f6;color:#b91c1c">!</div>
    <div class="body"><div class="error-box"><span>${escapeHtml(message)}</span></div></div>`;
  $('messages').appendChild(el);
  scrollToBottom(true);
}

function upsertToolStart(trace, ev) {
  const node = document.createElement('div');
  node.className = 'tool';
  node.dataset.runId = ev.runId;
  node.innerHTML = `
    <div class="tool-head">
      <span class="dot ${ev.group || 'local'}"></span>
      <span class="tool-title">${escapeHtml(ev.label || ev.name)}</span>
      <span class="tool-sub">${escapeHtml(ev.name)}</span>
      <span class="tool-status"><span class="spinner"></span>运行中</span>
    </div>
    <div class="tool-detail">
      <div class="tool-label">入参</div>
      <pre class="args"></pre>
      <div class="tool-label result-label" hidden>结果</div>
      <pre class="result" hidden></pre>
    </div>`;

  node.querySelector('.args').textContent = JSON.stringify(ev.args ?? {}, null, 2);
  node.querySelector('.tool-head').addEventListener('click', () => node.classList.toggle('open'));

  trace.appendChild(node);
  state.toolNodes.set(ev.runId, node);
  scrollToBottom();
}

function upsertToolEnd(ev) {
  const node = state.toolNodes.get(ev.runId);
  if (!node) return;

  const status = node.querySelector('.tool-status');
  status.className = `tool-status ${ev.ok ? 'ok' : 'err'}`;
  status.textContent = `${ev.ok ? '完成' : '失败'} · ${ev.durationMs}ms`;

  const label = node.querySelector('.result-label');
  const result = node.querySelector('.result');
  label.hidden = false;
  result.hidden = false;
  result.textContent = ev.output || '(空)';
  if (/错误|失败|error/i.test(ev.output || '')) node.classList.add('open');
}

function appendSkillBadge(trace, ev) {
  const el = document.createElement('div');
  el.className = 'skill-badge';
  el.innerHTML = `<span class="dot skill"></span>已加载技能：${escapeHtml(ev.title)}`;
  trace.appendChild(el);
  scrollToBottom();
}

function appendCitations(container, items) {
  if (!items?.length) return;
  container.innerHTML = items
    .map(
      (item) =>
        `<span class="citation" title="${escapeHtml(item.preview)}">
          <b>${item.score.toFixed(2)}</b> ${escapeHtml(item.source)} #${item.chunkIndex}
        </span>`,
    )
    .join('');
}

/* ------------------------------------------------------------ 发送 */

let renderTimer = null;

function scheduleContentRender(content, buffer) {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    content.innerHTML = `${renderMarkdown(buffer)}<span class="cursor"></span>`;
    scrollToBottom();
  }, 50);
}

function setBusy(busy) {
  state.streaming = busy;
  $('send').disabled = busy;
  $('input').disabled = busy;
  $('composerHint').textContent = busy
    ? '正在思考…（工具调用会显示在上方轨迹里）'
    : 'Agent 会自己决定：算数 / 查知识库 / 加载技能 / 调 MCP 工具';
}

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.streaming) return;

  if ($('messages').querySelector('.welcome')) clearMessages();

  state.toolNodes.clear();
  input.value = '';
  autoResize();
  $('charCount').textContent = '0';
  appendUserMessage(text);

  const view = appendAssistantMessage();
  let buffer = '';
  setBusy(true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, threadId: state.threadId }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text();
      throw new Error(`请求失败（${response.status}）${detail.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      const frames = pending.split('\n\n');
      pending = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue; // 忽略 ": ping" 心跳
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        handleEvent(event, view, (chunk) => {
          buffer += chunk;
          scheduleContentRender(view.content, buffer);
        });
      }
    }

    view.content.innerHTML = buffer ? renderMarkdown(buffer) : '<p class="doc-empty">（没有返回内容）</p>';
    scrollToBottom();
  } catch (error) {
    appendError(error.message || String(error));
  } finally {
    setBusy(false);
    $('input').focus();
  }
}

function handleEvent(event, view, onToken) {
  switch (event.type) {
    case 'token':
      onToken(event.content);
      break;
    case 'tool_start':
      upsertToolStart(view.trace, event);
      break;
    case 'tool_end':
      upsertToolEnd(event);
      break;
    case 'skill':
      appendSkillBadge(view.trace, event);
      break;
    case 'citations':
      appendCitations(view.citations, event.items);
      break;
    case 'done':
      break;
    case 'error':
      view.root.remove();
      appendError(event.message);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------ 会话操作 */

async function resetThread() {
  if (state.streaming) return;
  try {
    await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: state.threadId }),
    });
  } catch {
    /* 记忆在内存里，重置失败也不影响新会话 */
  }
  state.threadId = newThreadId();
  $('threadTitle').textContent = '新会话';
  $('threadMeta').textContent = `thread: ${state.threadId}`;
  renderWelcome();
  toast('已开始新会话');
}

/* ------------------------------------------------------------ 初始化 */

function autoResize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

async function refreshConfig() {
  const response = await fetch('/api/config');
  const cfg = await response.json();
  state.config = cfg;
  renderStatus(cfg);
  renderTools(cfg);
  return cfg;
}

async function pollStatus() {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts += 1;
    try {
      const status = await fetch('/api/status').then((r) => r.json());
      updateMcpPill(status.mcp);
      const done = !['loading', 'pending'].includes(status.mcp.state);
      if (done || attempts >= 20) {
        clearInterval(timer);
        await refreshConfig(); // MCP 就绪后工具列表会变，重渲染一次
      }
    } catch {
      if (attempts >= 20) clearInterval(timer);
    }
  }, 3000);
}

async function boot() {
  $('threadMeta').textContent = `thread: ${state.threadId}`;

  $('send').addEventListener('click', sendMessage);
  $('newChat').addEventListener('click', resetThread);

  const input = $('input');
  input.addEventListener('input', () => {
    autoResize();
    $('charCount').textContent = String(input.value.length);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

  $('fileInput').addEventListener('change', (event) => uploadFile(event.target.files?.[0]));

  const dropzone = $('dropzone');
  ['dragenter', 'dragover'].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    }),
  );
  ['dragleave', 'drop'].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
    }),
  );
  dropzone.addEventListener('drop', (event) => uploadFile(event.dataTransfer?.files?.[0]));

  renderWelcome();
  try {
    const cfg = await refreshConfig();
    if (!cfg.llmConfigured) {
      appendError(
        '还没配置模型密钥：把 .env.example 复制成 .env，填入 OPENAI_API_KEY 后重启。' +
          '（DeepSeek / 通义千问等兼容端点只需同时改 OPENAI_BASE_URL 和 MODEL_NAME）',
      );
    }
    if (cfg.mcp.state === 'loading' || Object.values(cfg.mcp.servers).some((s) => s.state === 'pending')) {
      pollStatus();
    }
  } catch (error) {
    appendError(`无法连接后端：${error.message}`);
  }

  await loadDocuments();
  input.focus();
}

boot();
