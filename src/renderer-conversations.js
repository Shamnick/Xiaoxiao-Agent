'use strict';

function sessionRow(item, primary) {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.dataset.session = item.id;
  primary.classList.add('session-link');
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'session-more';
  more.setAttribute('aria-label', (item.title || '未命名会话') + '的操作');
  more.setAttribute('aria-haspopup', 'menu');
  more.title = '会话操作';
  const icon = document.createElement('span');
  icon.className = 'ui-icon i-more';
  icon.setAttribute('aria-hidden', 'true');
  more.append(icon);
  more.onclick = () => openSessionMenu(item.id, more);
  row.oncontextmenu = event => {
    event.preventDefault();
    openSessionMenu(item.id, more);
  };
  row.onkeydown = event => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      openSessionMenu(item.id, more);
    }
  };
  row.append(primary, more);
  return row;
}
function openSessionMenu(id, anchor) {
  if (locked) return;
  const menu = $('sessionMenu'), item = conversations.find(row => row.id === id);
  if (!item) return;
  if (menu.matches(':popover-open')) menu.hidePopover();
  document.querySelector('.session-anchor')?.classList.remove('session-anchor');
  anchor.classList.add('session-anchor');
  menu.dataset.target = id;
  menu.dataset.header = String(anchor === $('conversationMenu'));
  $('sessionMenuName').textContent = item.title || '未命名会话';
  $('pinLabel').textContent = item.pinned ? '取消置顶' : '置顶会话';
  $('moveConversation').disabled = runs.has(id);
  $('moveConversation').title = runs.has(id) ? '任务结束后可以移动项目' : '';
  $('forkConversation').title = runs.has(id) ? '从已保存的对话记录开始' : '在独立会话里继续';
  menu.showPopover({source:anchor});
  $('renameConversation').focus({preventScroll:true});
}
function forkSession(id, through) {
  return action(async () => {
    const branch = await api.conversations.branch({ id, through });
    upsert(branch);
    changeView(branch, selectedProjectId && selectedProjectId !== branch.projectId ? branch.projectId || '' : selectedProjectId);
  });
}
function installSessionActions() {
  const menu = $('sessionMenu');
  function restoreTrigger(id) {
    if (document.querySelector('dialog[open]')) return;
    const row = [...document.querySelectorAll('.session-row')].find(node => node.dataset.session === id);
    const target = menu.dataset.header === 'true' && current?.id === id ? $('conversationMenu') : row?.querySelector('.session-more');
    if (target?.checkVisibility() && !target.disabled) target.focus({preventScroll:true});
    else focusPrompt();
  }
  for (const id of ['renameDialog', 'moveDialog', 'deleteDialog']) {
    $(id).addEventListener('close', () => {
      if (document.activeElement === document.body || !$('sidebar').contains(document.activeElement)) restoreTrigger($(id).dataset.target);
    });
  }
  $('conversationMenu').onclick = () => current && openSessionMenu(current.id, $('conversationMenu'));
  $('branchSource').onclick = () => selectConversation(current?.branchOf, true);
  menu.addEventListener('beforetoggle', event => {
    if (event.newState === 'closed') document.querySelector('.session-anchor')?.classList.remove('session-anchor');
  });
  menu.onkeydown = event => {
    const buttons = [...menu.querySelectorAll('button:enabled')];
    const index = buttons.indexOf(document.activeElement);
    const next = { ArrowDown:index+1, ArrowUp:index-1, Home:0, End:buttons.length-1 }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      buttons[(next + buttons.length) % buttons.length]?.focus();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const anchor = document.querySelector('.session-anchor');
      menu.hidePopover();
      anchor?.focus({preventScroll:true});
    }
  };
  menu.onclick = event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const item = conversations.find(row => row.id === menu.dataset.target);
    menu.hidePopover();
    if (!item || locked) return;
    const id = item.id, title = item.title || '未命名会话';
    switch (button.id) {
      case 'forkConversation': return forkSession(id);
      case 'exportConversation': return action(() => api.conversations.export(id));
      case 'pinConversation': return action(async () => {
        upsert(await api.conversations.save({id, pinned: !item.pinned}));
        renderHistory();
      }).then(() => restoreTrigger(id));
      case 'renameConversation':
        $('renameDialog').dataset.target = id;
        $('renameInput').value = title;
        $('renameInput').setCustomValidity('');
        $('renameDialog').showModal();
        $('renameInput').select();
        break;
      case 'moveConversation':
        $('moveDialog').dataset.target = id;
        $('moveTarget').replaceChildren(new Option('无项目', ''), ...projects.map(row => new Option(row.name, row.id)));
        $('moveTarget').value = item.projectId || '';
        $('moveDialog').showModal();
        break;
      case 'deleteConversation': {
        const run = runs.get(id);
        $('deleteDialog').dataset.target = id;
        $('deleteDialog').dataset.request = run?.requestId || '';
        $('deleteDetail').textContent = '将删除「' + title + '」的会话记录。已有分支会保留。';
        $('confirmDelete').textContent = run ? '停止并删除' : '删除会话';
        $('deleteDialog').showModal();
        $('cancelDelete').focus();
        break;
      }
    }
  };
  $('cancelRename').onclick = () => $('renameDialog').close();
  $('renameInput').oninput = () => $('renameInput').setCustomValidity('');
  $('renameForm').onsubmit = event => {
    event.preventDefault();
    const id = $('renameDialog').dataset.target, title = $('renameInput').value.trim();
    if (!title) { $('renameInput').setCustomValidity('请输入会话名称'); $('renameInput').reportValidity(); return; }
    action(async () => {
      upsert(await api.conversations.save({id, title}));
      $('renameDialog').close();
      renderConversationHeader();
      renderHistory();
    });
  };
  $('cancelDelete').onclick = () => $('deleteDialog').close();
  $('confirmDelete').onclick = () => action(async () => {
    const {target:id, request:requestId} = $('deleteDialog').dataset;
    await api.conversations.delete({id, requestId});
    const discarded = current?.id === id ? attachments : unsent.get(id)?.attachments || [];
    conversations = conversations.filter(row => row.id !== id);
    $('deleteDialog').close();
    if (current?.id === id) changeView(null, selectedProjectId);
    else { renderConversationHeader(); refreshReplyVersions(); renderHistory(); }
    ProofInstructions.forgetConversation(localStorage, id);
    unsent.delete(id);
    systemEdits.delete(id);
    openInspectors.delete(id);
    scrollPositions.delete(id);
    await Promise.all(discarded.map(item => api.attachment.clear(item.id)));
  });
}

function messageButton(icon, label, click) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'message-action';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(workspaceIcon(icon));
  button.onclick = click;
  return button;
}

function messageActions(conversation, turn, index) {
  const { id, messages } = conversation;
  const user = turn.role === 'user';
  const row = document.createElement('div');
  row.className = 'message-actions';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', user ? '提问操作' : '回复操作');
  const copy = messageButton('copy', user ? '复制提问' : '复制回复', async () => {
    try {
      await api.messages.copy({ id, index });
      copy.replaceChildren(workspaceIcon('check'));
      copy.title = status.textContent = '已复制';
      setTimeout(() => { copy.replaceChildren(workspaceIcon('copy')); copy.title = copy.getAttribute('aria-label'); status.textContent = ''; }, 1500);
    } catch (error) { showError(error); }
  });
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  row.append(copy, status);
  if (!user) {
    for (const [rating, icon, label] of [['up','thumbs-up','有帮助'], ['down','thumbs-down','没有帮助']]) {
      const button = messageButton(icon, label, () => action(async () => {
        const saved = await api.messages.rate({ id, index, rating: button.getAttribute('aria-pressed') === 'true' ? '' : rating });
        upsert(saved);
        for (const choice of row.querySelectorAll('.message-rating')) choice.setAttribute('aria-pressed', String(choice.dataset.rating === saved.messages[index].rating));
      }));
      button.classList.add('message-rating');
      button.dataset.rating = rating;
      button.setAttribute('aria-pressed', String(turn.rating === rating));
      row.append(button);
    }
  }
  const before = user ? index : turn.recovery?.originalUserIndex ?? index - 1;
  if (messages[before]?.role === 'user') {
    const question = messages[before];
    const intent = !user && ConnectionIntent.detect(plain(question.content));
    const button = intent ? messageButton('refresh', '重新检测接口', () => showConnectionCheck(intent)) : messageButton(user ? 'edit' : 'refresh', user ? '编辑并重新发送' : '重新生成', () => {
      if (user || question.attachment || conversation.agent) openRevisionEditor(conversation, before, user);
      else void replayMessage(id, before, plain(question.content), question.media);
    });
    button.classList.add(intent ? 'connection-retry' : 'message-replay');
    row.append(button);
  }
  if (!user) {
    const fork = messageButton('git', '从此处分支', () => forkSession(id, index));
    fork.classList.add('message-fork');
    row.append(fork);
    row.dataset.replyIndex = index;
    appendReplyVersions(row, conversation, index);
  }
  return row;
}

function refreshReplyVersions() {
  for (const row of $('chat').querySelectorAll('[data-reply-index]')) {
    row.querySelector('.reply-versions')?.remove();
    appendReplyVersions(row, current, Number(row.dataset.replyIndex));
  }
}

function appendReplyVersions(row, conversation, replyIndex) {
  const index = replyIndex - 1;
  const rootId = conversation.revision?.index === index ? conversation.revision.sourceId : conversation.id;
  const original = conversations.find(item => item.id === rootId);
  const variants = conversations.filter(item => item.revision?.sourceId === rootId && item.revision.index === index
    && item.messages[replyIndex]?.role === 'assistant').sort((a, b) => a.revision.createdAt - b.revision.createdAt);
  const versions = original ? [original, ...variants] : variants;
  const position = versions.findIndex(item => item.id === conversation.id);
  if (position < 0 || versions.length < 2) return;
  const pager = document.createElement('span');
  pager.className = 'reply-versions';
  const number = document.createElement('span');
  number.textContent = (position + 1) + ' / ' + versions.length;
  number.setAttribute('aria-label', '回复版本 ' + number.textContent);
  function navigate(offset) {
    const id = versions[position + offset]?.id;
    const target = conversations.find(item => item.id === id);
    if (!target || locked) return;
    changeView(target, selectedProjectId && target.projectId !== selectedProjectId ? target.projectId || '' : selectedProjectId, false);
    const article = $('chat').children[replyIndex];
    const control = article?.querySelector('.reply-versions button:enabled');
    control?.focus({ preventScroll: true });
    article?.scrollIntoView({ block: 'nearest' });
  }
  const previous = messageButton('chevron', '上一个版本', () => navigate(-1));
  const next = messageButton('chevron', '下一个版本', () => navigate(1));
  previous.disabled = position === 0;
  next.disabled = position === versions.length - 1;
  pager.append(previous, number, next);
  row.append(pager);
}

async function replayMessage(id, before, text, media, files = []) {
  if (current?.id !== id || currentRun() || locked) return;
  const branch = await action(async () => {
    const branch = await api.conversations.branch({ id, before });
    upsert(branch);
    changeView(branch, selectedProjectId);
    $('prompt').value = text;
    attachments = files;
    return branch;
  });
  if (!branch) return;
  if ($('reviseDialog').open && revision) {
    revision.files = [];
    $('reviseDialog').close();
  }
  await sendMessage(text, false, media);
}

let revision = null;
function openRevisionEditor(conversation, index, edit) {
  const question = conversation.messages[index];
  revision = { id: conversation.id, index, question, files: [] };
  $('reviseTitle').textContent = edit ? '编辑提问' : '重新生成回复';
  $('reviseText').value = plain(question.content);
  $('reviseText').readOnly = !edit;
  $('reviseHint').textContent = conversation.agent ? '将在新分支重新运行任务，并沿用当前工作目录。' : '新版本将保存在独立分支，方便返回原对话。';
  $('reviseFiles').hidden = !question.attachment;
  $('reviseReferences').textContent = '原引用仅保存了名称，可重新添加文件：' + (question.attachment?.name || question.attachment || '');
  $('reviseAttach').disabled = false;
  $('sendRevision').textContent = edit ? '发送新版本' : '重新生成';
  $('reviseDialog').showModal();
  $(edit ? 'reviseText' : 'sendRevision').focus();
}

function installRevisionEditor() {
  $('cancelRevise').onclick = () => { if (!locked) $('reviseDialog').close(); };
  $('reviseDialog').addEventListener('cancel', event => { if (locked) event.preventDefault(); });
  $('reviseDialog').addEventListener('close', () => {
    for (const file of revision?.files || []) void api.attachment.clear(file.id).catch(showError);
    revision = null;
  });
  $('reviseAttach').onclick = async () => {
    const target = revision;
    try {
      const file = await api.attachment.pick();
      if (!file) return;
      if (revision !== target || !$('reviseDialog').open) { await api.attachment.clear(file.id); return; }
      target.files.push(file);
      $('reviseReferences').textContent = '本次引用 · ' + target.files.map(item => item.name).join('、');
      $('reviseAttach').disabled = target.files.length >= 4;
    } catch (error) { $('reviseReferences').textContent = errorMessage(error); }
  };
  $('reviseForm').onsubmit = event => {
    event.preventDefault();
    const text = $('reviseText').value.trim();
    if (revision && text) void replayMessage(revision.id, revision.index, text, revision.question.media, revision.files);
  };
}
