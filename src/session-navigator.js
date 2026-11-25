'use strict';

function createSessionNavigator({ $, history, projectNames, runs, openSession, icon, platformKey }) {
  const dialog = $('searchDialog');
  const query = $('historyQuery');
  const results = $('historyResults');
  const filters = $('historyFilters');
  const more = $('historyMore');
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month:'short', day:'numeric' });
  const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour:'2-digit', minute:'2-digit' });
  let scope = 'all';
  let limit = 40;
  let trigger;

  function stateFor(row) {
    const run = runs.get(row.id);
    if (run?.stopping) return { label:'正在停止', active:true };
    if (run?.interaction) {
      const label = run.interaction.review ? '待审阅' : run.interaction.kind === 'question' ? '待回答' : '待确认';
      return { label, attention:true, active:true };
    }
    if (run) return { label:'运行中', active:true };
    if (row.messages?.at(-1)?.recovery) return { label:'可继续', attention:true };
    return {};
  }

  function highlight(parent, text, term) {
    const index = term ? text.toLocaleLowerCase().indexOf(term) : -1;
    if (index < 0) { parent.textContent = text; return; }
    const mark = document.createElement('mark');
    mark.textContent = text.slice(index, index + term.length);
    parent.append(text.slice(0, index), mark, text.slice(index + term.length));
  }

  function rowButton({ row, state, title, project, index, preview }, term) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.session = row.id;
    const glyph = icon(row.pinned ? 'pin' : row.agent ? 'task' : 'chat');
    glyph.classList.add('navigator-icon');
    const copy = document.createElement('span');
    copy.className = 'navigator-copy';
    const heading = document.createElement('strong');
    highlight(heading, title, term);
    const detail = document.createElement('small');
    const excerpt = preview.replace(/\s+/g, ' ').trim();
    if (index >= 0) {
      detail.append('第 ' + (index + 1) + ' 条消息 · ');
      highlight(detail, excerpt, term);
    } else {
      highlight(detail, [project, row.agent ? '任务' : '对话', row.pinned ? '已置顶' : ''].filter(Boolean).join(' · '), term);
    }
    copy.append(heading, detail);
    const meta = document.createElement('span');
    meta.className = 'navigator-meta';
    if (state.label) {
      meta.classList.add('navigator-badge');
      if (state.attention) meta.classList.add('attention');
      meta.textContent = state.label;
    } else {
      const date = new Date(row.updatedAt);
      if (row.updatedAt && Number.isFinite(date.getTime())) {
        meta.textContent = date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dateFormat.format(date);
        meta.title = date.toLocaleString('zh-CN');
      }
    }
    button.append(glyph, copy, meta);
    button.onclick = () => {
      dialog.close('select');
      openSession(row.id, index, state.attention);
    };
    return button;
  }

  function refresh() {
    if (!dialog.open) return;
    const term = query.value.trim().toLocaleLowerCase();
    const names = projectNames();
    const found = [];
    const counts = { all:0, attention:0, running:0, pinned:0 };
    for (const row of history()) {
      const title = row.title || '未命名会话';
      const project = names.get(row.projectId) || '';
      const state = stateFor(row);
      let preview = '', index = -1;
      if (term) {
        const messages = row.messages || [];
        index = messages.findLastIndex(message => typeof message.content === 'string' && message.content.toLocaleLowerCase().includes(term));
        if (index < 0 && !title.toLocaleLowerCase().includes(term) && !project.toLocaleLowerCase().includes(term)) continue;
        if (index >= 0) {
          const body = messages[index].content;
          const start = Math.max(0, body.toLocaleLowerCase().indexOf(term) - 15);
          preview = (start ? '…' : '') + body.slice(start, start + Math.max(90, term.length + 25));
        }
      }
      counts.all++;
      if (state.attention) counts.attention++;
      if (state.active) counts.running++;
      if (row.pinned) counts.pinned++;
      if (scope === 'attention' && !state.attention || scope === 'running' && !state.active || scope === 'pinned' && !row.pinned) continue;
      found.push({ row, state, title, project, index, preview });
    }
    const focused = results.contains(document.activeElement) ? document.activeElement.dataset.session : null;
    const wasMore = document.activeElement === more;
    const scroll = results.scrollTop;
    for (const button of filters.children) {
      button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
      button.querySelector('small').textContent = counts[button.dataset.scope];
    }
    const fragment = document.createDocumentFragment();
    for (const match of found.slice(0, limit)) fragment.append(rowButton(match, term));
    results.replaceChildren(fragment);
    results.scrollTop = scroll;
    more.hidden = found.length <= limit;
    $('historyEmpty').hidden = found.length > 0;
    const empty = { all:'还没有会话', attention:'目前没有待处理事项', running:'目前没有运行中的任务', pinned:'还没有置顶会话' };
    $('historyEmptyTitle').textContent = term ? '没有找到匹配的会话' : empty[scope];
    $('historyReset').hidden = !term && scope === 'all';
    const count = found.length > limit ? '显示 ' + limit + ' / ' + found.length + ' 个会话' : found.length + ' 个会话';
    if ($('historyStatus').textContent !== count) $('historyStatus').textContent = count;
    if (focused) {
      const target = [...results.children].find(button => button.dataset.session === focused);
      (target || query).focus({ preventScroll:true });
    } else if (wasMore && more.hidden) query.focus();
  }

  function reset() {
    limit = 40;
    results.scrollTop = 0;
    refresh();
  }

  function open(origin) {
    if (dialog.open) return;
    trigger = origin || document.activeElement;
    scope = 'all';
    query.value = '';
    dialog.returnValue = '';
    dialog.showModal();
    reset();
    query.focus();
  }

  $('findHistory').title = '会话导航 · ' + platformKey + 'K';
  $('findHistory').onclick = () => open($('findHistory'));
  $('historyReset').onclick = () => { scope = 'all'; query.value = ''; reset(); query.focus(); };
  $('closeSearch').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'select' && trigger?.isConnected && trigger.checkVisibility()) trigger.focus({ preventScroll:true });
  });
  query.oninput = reset;
  filters.onclick = event => {
    const button = event.target.closest('button[data-scope]');
    if (!button) return;
    scope = button.dataset.scope;
    reset();
  };
  more.onclick = () => {
    const firstNew = limit;
    limit += 40;
    refresh();
    results.children[firstNew]?.focus();
  };
  dialog.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return; }
    if (event.target === query && event.key === 'Enter') { event.preventDefault(); results.firstElementChild?.click(); return; }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    const index = [...results.children].indexOf(event.target);
    if (index < 0 && (event.target !== query || event.key !== 'ArrowDown')) return;
    event.preventDefault();
    if (index === 0 && event.key === 'ArrowUp') { query.focus(); return; }
    const target = { ArrowDown:Math.min(index + 1, results.childElementCount - 1), ArrowUp:index - 1, Home:0, End:results.childElementCount - 1 }[event.key];
    results.children[target]?.focus();
  };
  return { open, refresh };
}
