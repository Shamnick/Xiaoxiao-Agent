'use strict';
const $ = id => document.getElementById(id);
const api = window.nova;
const mac = api.platform === 'darwin';
document.documentElement.classList.toggle('mac', mac);
let providers = [], conversations = [], current = null, attachments = [];
let planning = false, splitAgent = false, previousRail = false, fileOpened = false;
const desktopSplit = matchMedia('(min-width: 1161px)');
const referencesFull = () => attachments.length >= 4;
let locked = false, settingsBusy = false, editing = null, settingsLoaded = false;
let projects = [], selectedProjectId = '', editingProjectId = '';
let skills = [], skillIds = [];
let taskPaneOpen = false, inspectorTab = 'task', fileScope = null;
let streamContent = null, composing = false, streamTimer = null;
let previewScroll = null;
const runs = new Map();
const unsent = new Map();
const systemEdits = new Map();
const scrollPositions = new Map();
const openInspectors = new Map();
const viewKey = () => current?.id || `home:${selectedProjectId}`;
const currentRun = () => runs.get(current?.id);
const canSteer = run => Boolean(run?.steerable && !run.finishing && !run.stopping && !run.interaction);
const form = $('providerForm');
const errorMessage = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const plain = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
function renderReferences(disabled) {
  const list = $('attachmentLabel');
  list.hidden = !attachments.length;
  const key = JSON.stringify(attachments.map(({ id }) => id));
  if (list.dataset.items !== key) {
    list.dataset.items = key;
    list.replaceChildren(...attachments.map(file => {
      const chip = document.createElement('span');
      chip.className = 'reference-chip';
      const name = document.createElement('span');
      name.textContent = file.name;
      name.title = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除 ${file.name}`);
      remove.title = '移除引用';
      remove.append(workspaceIcon('close'));
      remove.onclick = () => action(async () => {
        await api.attachment.clear(file.id);
        attachments = attachments.filter(item => item.id !== file.id);
        focusPrompt();
      });
      chip.append(workspaceIcon('file'), name, remove);
      return chip;
    }));
  }
  for (const remove of list.querySelectorAll('button')) remove.disabled = disabled;
}
function showError(error) { if (presence.isHome()) presence.showWorkspace(); $('errorText').textContent = errorMessage(error); $('errorBanner').hidden = false; }
function status(text, error = false) { $('settingsStatus').textContent = text; $('settingsStatus').classList.toggle('error', error); }
function selectedProvider() { return providers.find(p => p.id === $('modelSelect').value); }
function runStatus(run) {
  if (run.stopping) return '正在停止';
  if (run.interaction?.review) return '待审阅';
  if (run.interaction?.kind === 'approval') return '待确认';
  if (run.interaction?.kind === 'question') return '待回答';
  return run.status || '正在运行';
}
let prefs = { appearance: 'dark', conversationScene: 'silk', readingFont: 'serif', textSize: 'standard', sendKey: 'enter', defaultModel: '' };
function newChatModel() {
  return providers.find(p => p.id === prefs.defaultModel)?.id || providers[0]?.id || '';
}
const modelPicker = createModelPicker({
  $, list: () => providers, selected: selectedProvider, choose: chooseModel,
  discover: id => api.providers.models(id), manage: () => { setTab('provider'); openSettings(); }, errorMessage
});
function chooseModel(p) {
  if (currentRun() || locked) return;
  return action(async () => {
    const id = p.id || await api.providers.rememberModel({ connectionId: p.connectionId, model: p.model });
    if (!p.id) await refreshProviders($('modelSelect').value);
    if (current) upsert(await api.conversations.save({ id: current.id, providerId: id }));
    workspaceBrowser.clearAssist();
    $('modelSelect').value = id;
    focusPrompt();
  });
}
const workspaceBrowser = createWorkspaceBrowser({ $, api, errorMessage, onPreview: showFilePreview, onAttach: attachWorkspaceFile, onSave: () => gitBrowser.invalidate(), getProvider: selectedProvider });
const terminal = createProjectTerminal({ $, api, errorMessage });
const gitBrowser = createGitBrowser({
  $, api, errorMessage, openFile: path => workspaceBrowser.open(path), onReview: queueGitReview,
  hasUnsaved: () => workspaceBrowser.hasUnsavedHere(),
  onBranchChanged: () => workspaceBrowser.refresh({ allFolders: true })
});
const projectSearch = createProjectSearch({ $, api, errorMessage, open: (...args) => workspaceBrowser.open(...args), attach: attachWorkspaceFile });
const workspaceReview = createWorkspaceReview({ $, answer: answerInteraction, errorMessage });
function update() {
  const run = currentRun();
  const busy = Boolean(run);
  const disabled = busy || locked;
  $('presenceKnot').disabled = $('enterWorkspace').disabled = $('returnPresence').disabled = locked;
  $('dictate').disabled = locked;
  const canCheck = Boolean(ConnectionIntent.detect($('prompt').value));
  $('send').disabled = disabled || (!canCheck && !$('modelSelect').value) || !$('prompt').value.trim();
  $('openConnectionCheck').disabled = disabled;
  $('stop').hidden = !busy;
  $('stop').disabled = !run || run.starting || run.stopping || run.finishing;
  $('stopPending').disabled = $('stop').disabled;
  $('steer').hidden = !canSteer(run);
  $('steer').disabled = locked || Boolean(run?.submittingUpdate) || !$('prompt').value.trim();
  $('steerNow').hidden = !canSteer(run) || !$('prompt').value.trim();
  $('steerNow').disabled = $('steer').disabled;
  $('send').hidden = busy;
  $('returnPresence').dataset.activity = run?.interaction ? 'waiting' : run ? 'responding' : 'idle';
  $('runBadge').hidden = !disabled;
  $('runBadge').classList.toggle('needs-input', Boolean(run?.interaction));
  const label = run ? runStatus(run) : locked ? '正在保存' : '';
  if ($('runStatus').textContent !== label) $('runStatus').textContent = label;
  modelPicker.update(disabled);
  for (const id of ['findHistory', 'newProject', 'openFolder', 'heroOpenFolder', 'editProject', 'newChat', 'settings', 'settingsCompact', 'schedulesButton', 'schedulesCompact', 'connectModel']) $(id).disabled = locked;
  $('resumePanel').hidden = busy || !current?.messages?.at(-1)?.recovery;
  $('resumeTask').disabled = disabled || !$('modelSelect').value || Boolean($('prompt').value.trim());
  for (const id of ['modelSelect','agent','workspace','saveContext','systemPrompt','chatMode','planMode','taskMode']) $(id).disabled = disabled;
  for (const id of ['attach', 'attachPreview', 'attachSelection', 'referenceFile']) $(id).disabled = disabled || referencesFull() || (id !== 'attach' && !fileScope);
  $('referenceFile').hidden = !fileScope;
  $('continuePlan').disabled = disabled;
  $('continuePlan').hidden = !planning || !current?.messages.at(-1)?.planOnly || Boolean(current?.messages.at(-1)?.failed);
  $('attachPreview').title = busy ? '任务结束后可将此文件加入下一条消息' : referencesFull() ? '每条消息最多可引用四个文件' : '把已保存的文件加入消息';
  $('conversationMenu').disabled = locked;
  document.querySelectorAll('.message-fork').forEach(button => { button.disabled = locked; });
  document.querySelectorAll('.message-replay').forEach(button => { button.disabled = disabled || !$('modelSelect').value; });
  document.querySelectorAll('.message-rating').forEach(button => { button.disabled = disabled; });
  document.querySelectorAll('.connection-retry').forEach(button => { button.disabled = disabled; });
  $('skillsButton').disabled = locked;
  $('skillsButton').hidden = !$('agent').checked;
  $('skillsButtonLabel').textContent = skillIds.length ? `技能 ${skillIds.length}` : '技能';
  $('skillsButton').classList.toggle('selected-tool', Boolean(skillIds.length));
  $('composer').classList.toggle('needs-model', providers.length === 0 && !canCheck);
  $('chat').setAttribute('aria-busy', String(busy && !run.interaction));
  $('prompt').placeholder = canSteer(run) ? '补充要求，下一轮送达…' : busy ? '可先起草下一条消息…' : planning ? '描述你想先规划的改动…' : $('agent').checked ? '描述你想完成的任务…' : '输入消息…';
  renderReferences(disabled);
  $('composerHint').textContent = canSteer(run) ? '补充要求会随下一次模型请求送达' : busy ? '任务结束后即可发送' : providers.length ? (prefs.sendKey === 'modifier' ? '⌘ / Ctrl + Enter 发送 · Enter 换行' : 'Enter 发送 · Shift + Enter 换行') : '对话需连接模型，接口检测可直接使用';
  document.querySelectorAll('#history button, #projectList button, #runningList button').forEach(button => { button.disabled = locked; });
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = disabled; });
}
async function action(fn) {
  if (locked) return;
  locked = true; update();
  try { return await fn(); } catch (error) { showError(error); }
  finally { locked = false; update(); }
}
function scrollBottom() { const box = $('scrollArea'); box.scrollTop = box.scrollHeight; }
function nearBottom() {
  const box = $('scrollArea');
  return box.scrollHeight - box.clientHeight - box.scrollTop < 100;
}
function appendMessage(turn, index) {
  const article = document.createElement('article');
  const role = ['user','assistant','system','tool'].includes(turn.role) ? turn.role : 'system';
  article.className = 'message ' + role;
  if (Number.isInteger(index)) article.dataset.messageIndex = index;
  const label = document.createElement('div'); label.className = 'message-label';
  if (role === 'assistant') {
    const avatar = document.createElement('img');
    avatar.src = document.querySelector('.logo').src;
    avatar.className = 'message-avatar';
    avatar.alt = '';
    label.append(avatar);
  }
  label.append(({user:'你',assistant:document.getElementById('brandName')?.textContent || 'Xiaoxiao',system:'系统',tool:'工具'})[role]);
  const body = document.createElement('div'); body.className = 'message-content'; body.textContent = plain(turn.content);
  if (role === 'assistant' && !turn.streaming) {
    body.classList.add('markdown');
    renderMarkdown(body, plain(turn.content));
  }
  article.append(label, body);
  if (role === 'assistant' && Number.isInteger(index)) {
    const id = current.id;
    const files = document.createElement('div');
    files.className = 'reply-files';
    function fileAction(label, method) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.onclick = async () => {
        button.disabled = true;
        try { await method(button); } catch (error) { showError(error); }
        finally { button.disabled = false; }
      };
      files.append(button);
    }
    const openLabel = name => (/\.(?:html?|pdf)$/i.test(name) ? '打开' : '显示文件') + ' · ' + name;
    const savedFiles = turn.artifacts || [];
    savedFiles.forEach((file, item) => {
      fileAction(openLabel(file.name), () => api.messages.openArtifact({ id, index, item }));
    });
    if (!turn.failed && !savedFiles.some(file => file.block === undefined)) replyFiles(plain(turn.content)).forEach((file, block) => {
      if (savedFiles.some(file => file.block === block)) return;
      let saved;
      fileAction('另存为 · ' + file.filename, async button => {
        if (saved) return api.messages.openArtifact({ id, index, item: saved.item });
        saved = await api.messages.saveFile({ id, index, block });
        if (saved) {
          (turn.artifacts ||= [])[saved.item] = { name: saved.name, block };
          button.textContent = openLabel(saved.name);
        }
      });
    });
    if (files.childElementCount) article.insertBefore(files, body);
  }
  for (const { question, answer } of turn.clarifications || turn.recovery?.clarifications || []) {
    const note = document.createElement('div');
    note.className = 'clarification-note';
    const prompt = document.createElement('strong');
    prompt.textContent = question;
    const response = document.createElement('span');
    response.textContent = answer;
    note.append(prompt, response);
    article.append(note);
  }
  if (!turn.streaming) renderUpdates(article, turn.updates || turn.recovery?.updates, false);
  if (turn.attachment) {
    const note = document.createElement('p'); note.className = 'muted message-content';
    note.textContent = '引用 · ' + (turn.attachment.name || plain(turn.attachment)); article.append(note);
  }
  if (turn.media?.length) {
    const media = document.createElement('div');
    media.className = 'message-media';
    for (const frame of turn.media) {
      const image = document.createElement('img');
      image.src = `data:${frame.mimeType};base64,${frame.data}`;
      image.alt = frame.timestamp ? `视频画面 · ${frame.timestamp}` : frame.name || '图片附件';
      media.append(image);
    }
    article.append(media);
  }
  if (turn.failed || turn.error) {
    const note = document.createElement('p'); note.className = 'message-content muted';
    note.textContent = '未完成 / 已停止' + (turn.error ? ' · ' + plain(turn.error) : ''); article.append(note);
  }
  if (Number.isInteger(index) && (role === 'assistant' || role === 'user')) {
    article.append(messageActions(current, turn, index));
  }
  $('chat').append(article); return body;
}
function renderHistory() {
  const rows = sortedHistory().filter(row => !runs.has(row.id) && (!selectedProjectId || row.projectId === selectedProjectId));
  $('history').replaceChildren();
  $('historyCount').textContent = String(rows.length);
  $('historyCount').hidden = rows.length === 0;
  if (!rows.length && !conversations.some(row => runs.has(row.id) && (!selectedProjectId || selectedProjectId === row.projectId))) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '暂无对话记录。'; $('history').append(p); }
  for (const item of rows) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = item.id === current?.id ? 'active' : ''; button.setAttribute('aria-current', item.id === current?.id ? 'page' : 'false');
    const name = document.createElement('span');
    name.className = 'history-title';
    name.textContent = item.title || '未命名对话';
    const icon = document.createElement('span');
    icon.className = `ui-icon ${item.pinned ? 'i-pin' : item.branchOf ? 'i-git' : item.agent ? 'i-task' : 'i-chat'}`;
    icon.setAttribute('aria-hidden', 'true');
    const small = document.createElement('small');
    small.className = 'sr-only';
    const date = new Date(item.updatedAt);
    small.textContent = Number.isNaN(date.getTime()) ? '已保存的对话' : date.toLocaleDateString('zh-CN', {month:'short',day:'numeric'});
    if (item.messages?.at(-1)?.failed) small.textContent += ' · 有未完成消息';
    if (item.pinned) small.textContent = '置顶 · ' + small.textContent;
    button.title = `${name.textContent} · ${small.textContent}`;
    button.append(icon, name, small);
    button.onclick = () => selectConversation(item.id);
    $('history').append(sessionRow(item, button));
  }
  renderRunning();
  update();
}
function renderRunning() {
  navigatorPanel.refresh();
  const list = $('runningList');
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focused?.closest('.session-row')?.dataset.session;
  const ordered = [...runs.values()].sort((a, b) => Number(Boolean(b.interaction)) - Number(Boolean(a.interaction)));
  $('runningSection').hidden = !ordered.length;
  $('runningCount').textContent = String(ordered.length);
  $('toggleSidebar').classList.toggle('has-pending', ordered.some(run => run.interaction));
  list.replaceChildren(...ordered.map(run => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = run.conversationId;
    button.className = 'running-item';
    button.classList.toggle('needs-input', Boolean(run.interaction));
    if (run.conversationId === current?.id) button.setAttribute('aria-current', 'page');
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'history-title';
    label.textContent = conversations.find(row => row.id === run.conversationId)?.title || '新任务';
    const status = document.createElement('small');
    status.textContent = run.interaction || run.stopping ? runStatus(run) : '运行中';
    button.title = `${label.textContent} · ${status.textContent}`;
    button.append(dot, label, status);
    button.onclick = () => selectConversation(run.conversationId, true);
    return sessionRow({id:run.conversationId, title:label.textContent}, button);
  }));
  if (focusedId) [...list.children].find(row => row.dataset.session === focusedId)?.querySelector(focused.matches('.session-more') ? '.session-more' : '.session-link')?.focus({preventScroll:true});
  const menu = $('sessionMenu');
  if (menu.matches(':popover-open') && menu.dataset.header === 'false') {
    const row = [...document.querySelectorAll('.session-row')].find(row => row.dataset.session === menu.dataset.target);
    if (row) row.querySelector('.session-more').classList.add('session-anchor');
    else menu.hidePopover();
    $('moveConversation').disabled = runs.has(menu.dataset.target);
  }
}
function renderProjects() {
  const list = $('projectList');
  list.replaceChildren();
  const items = [{id: '', name: '全部会话'}, ...projects];
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    const label = document.createElement('span');
    label.textContent = item.name;
    const icon = document.createElement('span');
    icon.className = `ui-icon ${item.id ? 'i-folder' : 'i-history'}`;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, label);
    button.title = item.name;
    button.setAttribute('aria-pressed', String(item.id === selectedProjectId));
    button.onclick = () => {
      if (locked) return;
      if (!current && item.id === selectedProjectId) { focusPrompt(); return; }
      changeView(null, item.id);
    };
    list.append(button);
  }
  const scope = projects.find(item => item.id === selectedProjectId);
  $('historyLabel').textContent = scope?.name || '最近会话';
  $('historyLabel').title = scope?.name || '';
  $('editProject').hidden = !scope;
}
function syncProjectDirectory() {
  const row = projects.find(item => item.id === editingProjectId);
  $('projectDirectory').hidden = !row;
  $('projectPath').textContent = row?.workspace || '未设置共享工作目录';
  $('clearProjectWorkspace').hidden = !row?.workspace;
}
function syncProjectSources() {
  const row = projects.find(item => item.id === editingProjectId);
  $('projectSources').hidden = !row;
  const list = $('projectSourceList');
  list.replaceChildren();
  $('projectSourceEmpty').hidden = Boolean(row?.sources?.length);
  for (const source of row?.sources || []) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = source.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', '移除资料 ' + source.name);
    remove.onclick = () => projectSourceAction(() => api.projects.removeSource({ id: row.id, sourceId: source.id }), '资料已移除');
    item.append(name, remove);
    list.append(item);
  }
}
function projectSourceAction(run, successMessage) {
  projectAction(async () => {
    const row = await run();
    if (!row) return;
    updateProject(row);
    syncProjectSources();
    $('projectStatus').textContent = successMessage;
  });
}
$('addProjectSource').onclick = () => projectSourceAction(() => api.projects.addSource(editingProjectId), '资料已添加');
function showProjectDialog(row) {
  editingProjectId = row?.id || '';
  $('projectTitle').textContent = row ? '编辑项目' : '新建项目';
  $('projectName').value = row?.name || '';
  $('projectInstructions').value = row?.instructions || '';
  $('projectStatus').textContent = '';
  syncProjectDirectory();
  syncProjectSources();
  $('projectDialog').showModal();
  $('projectName').focus();
}
function updateProject(row) {
  const existing = projects.findIndex(item => item.id === row.id);
  if (existing < 0) projects.push(row);
  else projects[existing] = row;
}
function openFolder() {
  return action(async () => {
    const row = await api.projects.openFolder();
    if (!row) return;
    updateProject(row);
    changeView(null, row.id, false);
    $('agent').checked = true;
    planning = false;
    updateMode();
    if (!compactInspector.matches) setTaskPane(true, 'files');
    else setTaskPane(false, 'files');
    focusPrompt();
  });
}
$('openFolder').onclick = openFolder;
$('heroOpenFolder').onclick = () => fileScope ? toggleInspector('files') : openFolder();
let projectBusy = false;
async function projectAction(run) {
  if (projectBusy) return;
  projectBusy = true;
  const controls = $('projectForm').querySelectorAll('button, input, textarea');
  for (const control of controls) control.disabled = true;
  $('closeProject').disabled = true;
  $('projectStatus').textContent = '';
  try { await run(); }
  catch (error) { $('projectStatus').textContent = errorMessage(error); }
  finally {
    projectBusy = false;
    for (const control of controls) control.disabled = false;
    $('closeProject').disabled = false;
  }
}
$('newProject').onclick = () => showProjectDialog();
$('editProject').onclick = () => showProjectDialog(projects.find(item => item.id === selectedProjectId));
$('closeProject').onclick = () => $('projectDialog').close();
$('projectDialog').addEventListener('cancel', event => { if (projectBusy) event.preventDefault(); });
$('projectForm').onsubmit = event => {
  event.preventDefault();
  projectAction(async () => {
    const row = await api.projects.save({id: editingProjectId, name: $('projectName').value, instructions: $('projectInstructions').value});
    updateProject(row);
    if (!editingProjectId) {
      changeView(null, row.id, false);
      $('projectTitle').textContent = '编辑项目';
    }
    editingProjectId = row.id;
    $('projectStatus').textContent = '项目已保存';
    syncProjectDirectory();
    syncProjectSources();
    renderCurrent();
  });
};
for (const [id, method] of [['chooseProjectWorkspace', 'pickWorkspace'], ['clearProjectWorkspace', 'clearWorkspace']]) {
  $(id).onclick = () => projectAction(async () => {
    const row = await api.projects[method](editingProjectId);
    if (row) {
      updateProject(row);
      syncProjectDirectory();
      renderCurrent();
    }
  });
}
$('cancelMove').onclick = () => $('moveDialog').close();
$('moveForm').onsubmit = event => {
  event.preventDefault();
  const target = $('moveTarget').value;
  action(async () => {
    const id = $('moveDialog').dataset.target;
    upsert(await api.conversations.save({id, projectId: target}));
    if (current?.id === id && selectedProjectId) selectedProjectId = target;
    $('moveDialog').close();
    if (current?.id === id) renderCurrent(); else renderHistory();
  });
};
function sortedHistory() {
  const timestamp = item => Number(item.updatedAt) || Date.parse(item.updatedAt) || 0;
  return [...conversations].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || timestamp(b) - timestamp(a));
}
function changeView(item, projectId, focus = true) {
  presence.cancelSpeech();
  presence.voiceHint();
  const key = viewKey();
  const text = ConnectionIntent.mask($('prompt').value);
  if (text || attachments.length || (!current && (skillIds.length || systemEdits.has(key)))) {
    unsent.set(key, { text, attachments, skillIds, providerId: $('modelSelect').value, agent: $('agent').checked, planning });
  }
  else unsent.delete(key);
  if (current) scrollPositions.set(key, previewScroll ? previewScroll.top : nearBottom() ? null : $('scrollArea').scrollTop);
  current = item;
  selectedProjectId = projectId;
  const saved = unsent.get(viewKey());
  if (!current) {
    $('modelSelect').value = providers.some(p => p.id === saved?.providerId) ? saved.providerId : newChatModel();
    if (saved) {
      $('agent').checked = saved.agent;
      planning = saved.planning;
    }
  }
  $('prompt').value = saved?.text || '';
  attachments = saved?.attachments || [];
  skillIds = (current?.skillIds || saved?.skillIds || []).filter(id => skills.some(row => row.id === id));
  taskPaneOpen = openInspectors.has(viewKey());
  inspectorTab = openInspectors.get(viewKey()) || 'task';
  $('systemPanel').hidden = true;
  $('toggleSystem').setAttribute('aria-expanded', 'false');
  $('errorBanner').hidden = true;
  renderCurrent({ preserveScroll: false });
  if (current && scrollPositions.get(viewKey()) != null) $('scrollArea').scrollTop = scrollPositions.get(viewKey());
  if (focus) focusPrompt();
}
function focusPrompt() {
  if (document.querySelector('dialog[open]')) return;
  if (presence.isHome()) { presence.focus(); return; }
  if ($('chatColumn').hidden) { $('returnToChat').focus({ preventScroll: true }); return; }
  if (!$('taskPane').hidden && compactInspector.matches) { $('closeTaskPane').focus({ preventScroll: true }); return; }
  const interaction = currentRun()?.interaction;
  const id = interaction?.kind === 'question' ? 'answerText' : interaction?.review ? 'openChangeReview' : interaction ? 'approvalDetail' : 'prompt';
  $(id).focus({ preventScroll: true });
}
function selectConversation(id, review = false) {
  if (locked) return;
  const item = conversations.find(row => row.id === id);
  if (!item) return;
  if (current?.id === id) {
    if (review && !$('filePreview').hidden && $('chatColumn').hidden) workspaceBrowser.close();
    if (review && taskPaneOpen && compactInspector.matches) setTaskPane(false);
    focusPrompt();
    return;
  }
  const scope = selectedProjectId && selectedProjectId !== item.projectId ? item.projectId || '' : selectedProjectId;
  changeView(item, scope);
}
const navigatorPanel = createSessionNavigator({
  $, history: sortedHistory, projectNames: () => new Map(projects.map(project => [project.id, project.name])),
  runs, icon: workspaceIcon, platformKey: mac ? '⌘' : 'Ctrl+',
  openSession(id, index, attention) {
    if (locked) return;
    if (presence.isHome()) presence.showWorkspace();
    selectConversation(id, true);
    if (current?.id !== id) return;
    if ($('chatColumn').hidden) workspaceBrowser.close();
    if (taskPaneOpen && compactInspector.matches) setTaskPane(false);
    if (index >= 0) {
      const message = $('chat').querySelector('[data-message-index="' + index + '"]');
      if (message) {
        message.tabIndex = -1;
        message.focus({ preventScroll:true });
        message.scrollIntoView({ block:'center', behavior:'instant' });
        return;
      }
    }
    if (attention && !$('resumePanel').hidden && !$('resumeTask').disabled) $('resumeTask').focus();
    else focusPrompt();
  }
});
function setRailCollapsed(collapsed) {
  $('sidebar').hidden = collapsed;
  $('toggleSidebar').setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? '显示侧边栏' : '隐藏侧边栏';
  $('toggleSidebar').setAttribute('aria-label', label);
  $('toggleSidebar').title = label;
  presence.syncDrawer();
}
$('toggleSidebar').onclick = () => setRailCollapsed(!$('sidebar').hidden);
const compactInspector = matchMedia('(max-width: 1070px)');
compactInspector.addEventListener('change', () => {
  const focusInCenter = document.activeElement.closest('.chat-column, .file-preview');
  syncTaskPane();
  if (compactInspector.matches && !$('taskPane').hidden && focusInCenter) $('closeTaskPane').focus({ preventScroll: true });
});
function syncTaskPane() {
  const hasPlan = !$('taskPlan').hidden, hasDraft = !$('draftPanel').hidden, hasChanges = !$('changesPanel').hidden;
  const available = hasPlan || hasDraft || hasChanges || !$('activityPanel').hidden;
  const hasFiles = Boolean(fileScope);
  if (inspectorTab !== 'task' && !hasFiles) inspectorTab = 'task';
  if (inspectorTab === 'task' && !available && hasFiles) inspectorTab = 'files';
  const visible = (hasFiles || available) && taskPaneOpen;
  const taskVisible = visible && inspectorTab === 'task';
  const filesVisible = visible && inspectorTab === 'files';
  const gitVisible = visible && inspectorTab === 'git';
  $('taskOutputs').hidden = !(hasPlan || hasDraft || hasChanges || (planning && current?.messages.at(-1)?.planOnly));
  $('taskSummary').hidden = !hasPlan;
  $('changesShortcut').hidden = !hasChanges;
  $('draftShortcut').hidden = !hasDraft;
  $('taskSummary').setAttribute('aria-expanded', String(taskVisible));
  $('changesShortcut').setAttribute('aria-expanded', String(taskVisible));
  $('toggleTaskPane').hidden = !available;
  $('toggleTaskPane').setAttribute('aria-expanded', String(taskVisible));
  $('workspaceBrowserButton').hidden = $('workspaceGitButton').hidden = $('projectSearchButton').hidden = $('openProjectPreview').hidden = !hasFiles;
  $('developmentMode').hidden = !hasFiles || !desktopSplit.matches;
  $('workspaceBrowserButton').setAttribute('aria-expanded', String(filesVisible));
  $('workspaceGitButton').setAttribute('aria-expanded', String(gitVisible));
  const label = taskVisible ? '隐藏任务详情' : '显示任务详情';
  $('toggleTaskPane').setAttribute('aria-label', label);
  $('toggleTaskPane').title = label;
  $('taskPaneTitle').textContent = { files: '文件', git: 'Git 改动', task: '任务详情' }[inspectorTab];
  $('taskPane').hidden = !visible;
  $('taskPaneBackdrop').hidden = !visible || !compactInspector.matches;
  $('chatColumn').inert = $('filePreview').inert = visible && compactInspector.matches;
  $('inspectorFiles').parentElement.hidden = !hasFiles;
  $('taskPaneTitle').classList.toggle('sr-only', hasFiles);
  $('inspectorTask').hidden = !available;
  for (const [id, tab] of [['inspectorFiles', 'files'], ['inspectorGit', 'git'], ['inspectorTask', 'task']]) {
    $(id).setAttribute('aria-pressed', String(inspectorTab === tab));
  }
  $('fileBrowser').hidden = inspectorTab !== 'files';
  $('gitBrowser').hidden = inspectorTab !== 'git';
  $('taskSections').hidden = inspectorTab !== 'task';
  placeInspector();
  if (filesVisible) workspaceBrowser.show();
  if (gitVisible) gitBrowser.show();
}
function setTaskPane(open, tab = inspectorTab) {
  const previousTab = inspectorTab;
  taskPaneOpen = open;
  inspectorTab = tab;
  syncTaskPane();
  if (previousTab !== inspectorTab) $('taskPane').scrollTop = 0;
  if (open) openInspectors.set(viewKey(), inspectorTab);
  else openInspectors.delete(viewKey());
  if (open && compactInspector.matches && !$('taskPane').hidden) $('closeTaskPane').focus({ preventScroll: true });
}
function toggleInspector(tab, section) {
  const fromOutput = section && $('taskOutputs').contains(document.activeElement);
  const follow = nearBottom();
  setTaskPane(!(taskPaneOpen && inspectorTab === tab), tab);
  if (taskPaneOpen && section) $(section).scrollIntoView({ block: 'nearest' });
  if (taskPaneOpen && fromOutput) $('closeTaskPane').focus({ preventScroll: true });
  if (follow) scrollBottom();
}
$('toggleTaskPane').onclick = () => toggleInspector('task');
$('taskSummary').onclick = () => toggleInspector('task', 'taskPlan');
$('changesShortcut').onclick = () => {
  setTaskPane(true, 'task');
  $('changesPanel').scrollIntoView({ block: 'nearest' });
  $('closeTaskPane').focus({ preventScroll: true });
};
$('workspaceBrowserButton').onclick = () => toggleInspector('files');
$('workspaceGitButton').onclick = () => toggleInspector('git');
$('projectSearchButton').onclick = () => projectSearch.show(fileScope?.target);
const projectPreviewDialog = $('projectPreviewDialog');
let openingPreview = false;
$('openProjectPreview').onclick = () => {
  if (!fileScope || projectPreviewDialog.open) return;
  const input = $('projectPreviewUrl');
  input.value ||= 'http://localhost:5173/';
  $('projectPreviewStatus').textContent = '请先在项目终端启动开发服务器。';
  projectPreviewDialog.showModal();
  input.select();
};
$('cancelProjectPreview').onclick = () => { if (!openingPreview) projectPreviewDialog.close(); };
projectPreviewDialog.addEventListener('cancel', event => { if (openingPreview) event.preventDefault(); });
$('projectPreviewForm').onsubmit = async event => {
  event.preventDefault();
  if (!fileScope || openingPreview) return;
  const status = $('projectPreviewStatus');
  openingPreview = $('cancelProjectPreview').disabled = $('startProjectPreview').disabled = true;
  status.textContent = '正在连接开发服务器…';
  try {
    await api.workspace.openPreview({ ...fileScope.target, url: $('projectPreviewUrl').value.trim() });
    projectPreviewDialog.close();
  } catch (error) { status.textContent = errorMessage(error); }
  finally { openingPreview = $('cancelProjectPreview').disabled = $('startProjectPreview').disabled = false; }
};
$('referenceFile').onclick = () => projectSearch.show(fileScope?.target, { attachFile: true });
for (const [id, tab] of [['inspectorFiles', 'files'], ['inspectorGit', 'git'], ['inspectorTask', 'task']]) {
  $(id).onclick = () => {
    setTaskPane(true, tab);
    $(id).focus({ preventScroll: true });
  };
}
$('closeTaskPane').onclick = $('taskPaneBackdrop').onclick = () => {
  setTaskPane(false);
  $(({ files: 'workspaceBrowserButton', git: 'workspaceGitButton', task: 'toggleTaskPane' })[inspectorTab]).focus();
};
function placeInspector() {
  const pane = $('taskPane');
  const preview = $('filePreview');
  const bench = preview.parentElement;
  const left = bench.classList.contains('editor-split');
  bench.classList.toggle('editor-inspector-left', left);
  if (left && pane.nextElementSibling !== preview) bench.insertBefore(pane, preview);
  if (!left && pane !== bench.lastElementChild) bench.append(pane);
}
function syncEditorLayout() {
  const preview = $('filePreview');
  const chat = $('chatColumn');
  const bench = preview.parentElement;
  const split = Boolean(fileScope && splitAgent && desktopSplit.matches);
  if (bench.classList.contains('editor-split') !== split) {
    bench.classList.toggle('editor-split', split);
    if (split) {
      previousRail = $('sidebar').hidden;
      setRailCollapsed(true);
      bench.insertBefore(preview, chat);
    } else {
      setRailCollapsed(previousRail);
      bench.insertBefore(chat, preview);
    }
  }
  preview.hidden = !fileOpened && !split;
  $('editorEmpty').hidden = fileOpened || !split;
  $('filePreviewTools').hidden = !fileOpened;
  if (!fileOpened) $('filePreviewName').textContent = '开发工作台';
  placeInspector();
  workspaceBrowser.setTreeMode(split);
  $('editorAgentBar').hidden = !split;
  chat.hidden = fileOpened && !split;
  $('developmentMode').hidden = !fileScope || !desktopSplit.matches;
  $('developmentMode').setAttribute('aria-pressed', String(split));
  $('returnToChat').hidden = split;
  $('splitAgent').hidden = !fileOpened;
  $('splitAgent').setAttribute('aria-pressed', String(split));
  $('splitAgent').setAttribute('aria-label', split ? '收起 Agent' : '并排显示 Agent');
  $('splitAgent').title = $('splitAgent').getAttribute('aria-label');
}
function toggleDevelopment(show, { keepFile = false } = {}) {
  if (!fileScope || !desktopSplit.matches) return;
  splitAgent = show;
  if (!show && !keepFile) workspaceBrowser.close();
  syncEditorLayout();
  if (show) {
    if ((!taskPaneOpen || inspectorTab === 'task') && fileScope) setTaskPane(true, 'files');
    scrollBottom();
  }
}
$('developmentMode').onclick = () => {
  toggleDevelopment(!splitAgent);
  if (splitAgent && !fileOpened) $('findEditorFile').focus({ preventScroll: true });
  else $('developmentMode').focus({ preventScroll: true });
};
$('findEditorFile').onclick = () => projectSearch.show(fileScope?.target, { names: true });
$('splitAgent').onclick = () => {
  toggleDevelopment(!splitAgent, { keepFile: true });
  $('splitAgent').focus({ preventScroll: true });
};
desktopSplit.addEventListener('change', syncEditorLayout);
function showFilePreview(open, { restoreFocus, previous } = {}) {
  const wasOpen = fileOpened;
  if (open && !wasOpen) previewScroll = { key: viewKey(), top: nearBottom() ? null : $('scrollArea').scrollTop };
  fileOpened = open;
  syncEditorLayout();
  if (open) {
    if (compactInspector.matches && taskPaneOpen) setTaskPane(false);
    if (!$('returnToChat').hidden) $('returnToChat').focus({ preventScroll: true });
  } else if (wasOpen) {
    if (previewScroll?.key === viewKey() && previewScroll.top !== null) $('scrollArea').scrollTop = previewScroll.top;
    else scrollBottom();
    previewScroll = null;
    if (restoreFocus) {
      const row = !$('fileBrowser').hidden && !$('taskPane').hidden && [...$('fileEntries').querySelectorAll('button')].find(item => item.dataset.path === previous);
      if (row) row.focus({ preventScroll: true });
      else focusPrompt();
    }
  }
}
async function attachWorkspaceFile(target) {
  if (locked || currentRun() || !fileScope || referencesFull()) throw Error('当前无法加入文件。每条消息最多引用四个文件。');
  locked = true;
  update();
  try {
    const picked = await api.workspace.attach(target);
    if (!picked) return false;
    addReference(picked);
    if (compactInspector.matches && taskPaneOpen) setTaskPane(false);
    if ($('chatColumn').hidden) workspaceBrowser.close();
    setTimeout(focusPrompt, 0);
    return true;
  } finally { locked = false; update(); }
}
async function queueGitReview(target) {
  if (locked || currentRun() || current?.scheduleId || !fileScope || referencesFull()) throw Error('当前无法加入审查。请检查任务状态和引用数量。');
  locked = true;
  update();
  let picked;
  try {
    picked = await api.workspace.attachGitDiff(target);
    if (!picked) return false;
    await setMode('plan');
    addReference(picked);
    if ($('chatColumn').hidden && desktopSplit.matches) {
      splitAgent = true;
      syncEditorLayout();
    } else if ($('chatColumn').hidden) workspaceBrowser.close();
    if (compactInspector.matches && taskPaneOpen) setTaskPane(false);
    const request = '请审查附加的 Git 差异，指出可复现的问题与缺失测试，并标注文件和行号。保持工作区不变。';
    const text = $('prompt').value;
    if (!text.includes(request)) $('prompt').value = text.trim() ? `${text}\n\n${request}` : request;
    requestAnimationFrame(focusPrompt);
    return true;
  } catch (error) {
    if (picked) await api.attachment.clear(picked.id).catch(() => {});
    throw error;
  } finally { locked = false; update(); }
}
function addReference(file) {
  if (attachments.some(item => item.name === file.name && item.bytes === file.bytes)) {
    const previous = attachments.find(item => item.name === file.name && item.bytes === file.bytes);
    void api.attachment.clear(previous.id);
    attachments = attachments.map(item => item === previous ? file : item);
  } else attachments = [...attachments, file];
}
function syncWorkspace(scope) {
  const workspace = current?.workspace || scope?.workspace;
  const name = workspace ? workspace.split(/[\\/]/).filter(Boolean).at(-1) || workspace : '';
  const target = current ? { conversationId: current.id, workspace } : { projectId: scope?.id, workspace };
  fileScope = workspace ? { key: JSON.stringify(target), target, name } : null;
  workspaceBrowser.setScope(fileScope);
  gitBrowser.setScope(fileScope);
  terminal.setScope(fileScope?.target);
  $('workspaceLabel').textContent = name || '工作目录';
  $('workspace').title = workspace || '选择工作目录';
  $('workspace').classList.toggle('attached-workspace', Boolean(workspace));
  $('heroFolderLabel').textContent = name ? `浏览 ${name}` : '打开文件夹';
  $('heroOpenFolder').title = workspace || '从文件夹打开项目';
  renderWorkspaceChanges(current?.workspaceChanges);
}
function renderWorkspaceChanges(changes = []) {
  const newest = [...changes].reverse();
  const list = $('changesList');
  const focusId = list.contains(document.activeElement) ? document.activeElement.dataset.changeId : null;
  $('changesPanel').hidden = !newest.length;
  $('changesCount').textContent = `${newest.length} 次写入`;
  $('changesShortcutCount').textContent = `${new Set(newest.map(change => JSON.stringify([change.workspace, change.path]))).size} 个文件`;
  list.replaceChildren(...newest.map(change => {
    const row = document.createElement('li');
    const available = change.workspace && change.workspace === fileScope?.target.workspace;
    const actionable = change.hasSnapshot || available;
    const entry = document.createElement(actionable ? 'button' : 'div');
    entry.className = 'change-entry';
    const name = document.createElement('strong');
    name.textContent = change.path;
    name.title = change.path;
    const label = document.createElement('small');
    const status = change.restoration ? '已恢复' : change.created ? '已创建' : '已修改';
    label.textContent = change.id && !change.hasSnapshot ? `${status} · 版本无法保存` : status;
    const file = document.createElement('span');
    file.className = 'change-file';
    file.append(name, label);
    const counts = document.createElement('span');
    counts.className = 'change-counts';
    renderCounts(counts, change.counts);
    entry.append(workspaceIcon('file'), file, counts);
    if (actionable) {
      entry.type = 'button';
      if (change.id) entry.dataset.changeId = change.id;
      entry.title = `${change.hasSnapshot ? '查看写入记录' : '预览当前文件'} · ${change.path}`;
      if (change.hasSnapshot) entry.setAttribute('aria-haspopup', 'dialog');
      entry.onclick = change.hasSnapshot ? () => openSavedChange(change.id) : () => void workspaceBrowser.open(change.path);
    }
    row.append(entry);
    return row;
  }));
  if (focusId) list.querySelector(`button[data-change-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  syncTaskPane();
}
async function openSavedChange(changeId) {
  const conversationId = current?.id;
  if (!conversationId || locked || document.querySelector('dialog[open]')) return;
  try {
    const review = await api.workspace.change({ conversationId, changeId });
    const target = { conversationId, workspace: review.workspace, changeId };
    const inScope = () => current?.id === conversationId && fileScope?.target.workspace === review.workspace;
    function checkRestore() {
      if (!inScope()) throw Error('工作目录已切换，请重新打开记录');
      if (workspaceBrowser.hasPendingChanges(review.path)) throw Error('此文件有未保存的编辑，请先保存或放弃编辑');
    }
    if (current?.id === conversationId && !$('taskPane').hidden && inspectorTab === 'task' && !document.querySelector('dialog[open]')) {
      workspaceReview.showStored(review, {
        openCurrent: inScope() ? () => { if (inScope()) void workspaceBrowser.open(review.path); } : null,
        restore: inScope() && !review.created ? {
          preview() {
            checkRestore();
            return api.workspace.previewRestore(target);
          },
          async apply() {
            checkRestore();
            const result = await api.workspace.restore(target);
            const item = conversations.find(conversation => conversation.id === conversationId);
            if (item) item.workspaceChanges = result.changes;
            if (!inScope()) return;
            current.workspaceChanges = result.changes;
            renderWorkspaceChanges(result.changes);
            gitBrowser.invalidate();
            await workspaceBrowser.reloadFile(review.path);
            if (!result.historySaved) showError('文件已恢复，恢复记录未能保存。');
          }
        } : null,
        restoreFocus() {
          if (current?.id !== conversationId || document.querySelector('dialog[open]')) return;
          const row = !$('taskPane').hidden && inspectorTab === 'task' && $('changesList').querySelector(`button[data-change-id="${CSS.escape(changeId)}"]`);
          if (row) row.focus({ preventScroll: true });
          else focusPrompt();
        }
      });
    }
  } catch (error) {
    if (current?.id === conversationId) showError(error);
  }
}
function updateMode() {
  const task = $('agent').checked;
  $('chatMode').setAttribute('aria-pressed', String(!task));
  $('planMode').setAttribute('aria-pressed', String(task && planning));
  $('taskMode').setAttribute('aria-pressed', String(task && !planning));
  $('newChatLabel').textContent = task ? '新任务' : '新对话';
  $('welcomeTitle').textContent = planning ? '先理一理思路' : task ? '今天，一起做点什么？' : '想聊点什么？';
  $('welcomeHint').textContent = planning ? '写下目标和约束，先拟定方案供你审阅。' : task ? '写下任务，或打开一个项目文件夹。' : '提出问题，也可以附上想一起读的资料。';
  $('workspace').hidden = !task;
  for (const button of document.querySelectorAll('[data-task-only]')) button.hidden = !task;
  syncTaskPane();
}
async function setMode(mode) {
  const agent = mode !== 'chat';
  const planOnly = mode === 'plan';
  if (current?.scheduleId) throw Error('计划任务会话使用只读模式');
  if (current) upsert(await api.conversations.save({ id: current.id, agent, planOnly }));
  $('agent').checked = agent;
  planning = planOnly;
  updateMode();
}
for (const [id, mode] of [['chatMode', 'chat'], ['planMode', 'plan'], ['taskMode', 'task']]) {
  $(id).onclick = () => action(async () => {
    await setMode(mode);
    focusPrompt();
  });
}
$('continuePlan').onclick = () => action(async () => {
  await setMode('task');
  if (!$('prompt').value.trim()) $('prompt').value = '请按上一轮的方案执行，并验证结果。';
  focusPrompt();
});
function renderTaskPlan(steps = []) {
  const visible = steps.length > 0;
  $('taskPlan').hidden = !visible;
  syncTaskPane();
  $('taskSteps').replaceChildren();
  if (!visible) return;
  const completed = steps.filter(step => step.status === 'completed').length;
  $('taskSummaryCount').textContent = $('taskProgress').textContent = `${completed} / ${steps.length} 已完成`;
  $('taskMeter').max = steps.length;
  $('taskMeter').value = completed;
  const labels = {pending: '待处理', in_progress: '进行中', completed: '已完成'};
  for (const step of steps) {
    const item = document.createElement('li');
    item.dataset.status = step.status;
    const name = document.createElement('span');
    name.textContent = step.title;
    const status = document.createElement('small');
    status.textContent = labels[step.status];
    item.append(name, status);
    $('taskSteps').append(item);
  }
}
const draftsFor = item => item?.drafts || (item?.draft ? [{ ...item.draft, id: 'legacy-draft', revision: 1 }] : []);
let draftTarget;
function renderDrafts(drafts) {
  const length = drafts.length;
  $('draftPanel').hidden = !length;
  $('draftCount').textContent = `${length} 份`;
  $('draftShortcutName').textContent = length === 1 ? drafts[0].title : '查看交付物';
  $('draftShortcutMeta').textContent = length === 1 ? 'Markdown 文档' : `${length} 份文档`;
  $('draftShortcut').setAttribute('aria-haspopup', length === 1 ? 'dialog' : 'false');
  $('draftShortcut').title = length === 1 ? drafts[0].title : '查看交付物';
  $('draftList').replaceChildren(...drafts.map((draft, index) => {
    const button = document.createElement('button');
    if (index === 0) button.id = 'openDraft';
    button.className = 'draft-row';
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    const icon = document.createElement('span');
    icon.className = 'ui-icon i-file';
    icon.setAttribute('aria-hidden', 'true');
    const line = document.createElement('span');
    line.className = 'draft-row-text';
    const title = document.createElement('span');
    title.textContent = draft.title;
    const revision = document.createElement('small');
    revision.textContent = `Markdown · 第 ${draft.revision} 版`;
    line.append(title, revision);
    button.append(icon, line);
    button.onclick = () => openDraft(draft);
    return button;
  }));
  syncTaskPane();
}
function openDraft(draft) {
  draftTarget = { conversationId: current.id, draftId: draft.id, revision: draft.revision };
  $('draftName').textContent = draft.title;
  $('draftRevision').textContent = `交付物 · Markdown · 第 ${draft.revision} 版`;
  $('draftPreview').value = draft.markdown;
  renderMarkdown($('renderedDraft'), draft.markdown);
  const heading = $('renderedDraft').firstElementChild;
  if (heading?.matches('h1') && heading.textContent.trim() === draft.title.trim()) heading.remove();
  $('draftStatus').textContent = '';
  showDraftSource(false);
  $('draftDialog').showModal();
  $('renderedDraft').scrollTop = 0;
}
function showDraftSource(show) {
  $('draftPreview').hidden = !show;
  $('renderedDraft').hidden = show;
  $('toggleDraftSource').setAttribute('aria-pressed', String(show));
  $('toggleDraftSource').textContent = show ? '排版预览' : '查看源码';
}
$('draftShortcut').onclick = () => {
  const drafts = draftsFor(current);
  if (drafts.length === 1) openDraft(drafts[0]);
  else if (drafts.length > 1) {
    setTaskPane(true, 'task');
    $('draftList').querySelector('button')?.focus();
  }
};
$('closeDraft').onclick = () => $('draftDialog').close();
$('toggleDraftSource').onclick = () => showDraftSource($('draftPreview').hidden);
const exportOptions = [['exportDraft', 'export', 'Markdown'], ['exportDraftPdf', 'exportPdf', 'PDF'], ['exportDraftDocx', 'exportDocx', 'Word']];
function setExportBusy(busy) { for (const [id] of exportOptions) $(id).disabled = busy; }
for (const [id, method, format] of exportOptions) {
  $(id).onclick = async () => {
    if (!draftTarget) return;
    setExportBusy(true);
    $('draftStatus').textContent = `正在导出 ${format}…`;
    try {
      const saved = await api.draft[method](draftTarget);
      $('draftStatus').textContent = saved ? `${format} 已保存` : '';
    } catch (error) {
      $('draftStatus').textContent = errorMessage(error);
    }
    finally { setExportBusy(false); }
  };
}
const toolLabels = {
  save_artifact: '保存生成的文件',
  ask_user: '向你提问', update_task_plan: '更新任务清单', save_task_draft: '保存交付物', delegate_analysis: '并行分析',
  read_selected_document: '阅读引用', read_project_source: '阅读项目资料', list_files: '浏览工作目录', search_workspace: '搜索项目',
  read_file: '读取文件', write_file: '写入文件', edit_file: '修改代码', run_command: '执行命令', fetch_url: '读取网页'
};
const toolOutcomes = {
  verified: '已写入并核对内容', unconfirmed: '已写入，内容待核对', exited: '退出码为 0', command_failed: '命令未成功',
  skipped: '收到补充，已跳过', canceled: '已取消保存', conflict: '文件有新版本，已保留', denied: '已拒绝', failed: '执行失败', unchanged: '内容一致'
};
function renderActivity() {
  const run = currentRun();
  const last = current?.messages?.at(-1);
  const journal = run?.tools || last?.runTools || last?.recovery?.tools || [];
  $('activityLog').replaceChildren(...journal.map(tool => {
    const item = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = toolLabels[tool.name] || tool.name;
    if (tool.workspaceFile) {
      const file = document.createElement('small');
      file.className = 'activity-file';
      file.textContent = tool.workspaceFile;
      file.title = tool.workspaceFile;
      title.append(file);
    }
    const status = document.createElement('small');
    if (tool.progress) {
      const { finished, total, failed } = tool.progress;
      status.textContent = `${finished}/${total} 项已返回${failed ? ` · ${failed} 项未完成` : ''}${!tool.finished && !run ? ' · 已中断' : ''}`;
    } else {
      const completed = tool.name === 'write_file' && tool.workspaceFile ? '已写入' : '已返回';
      status.textContent = toolOutcomes[tool.outcome] || (tool.finished ? completed : run ? '处理中' : '结果未确认');
    }
    item.dataset.status = tool.outcome || (tool.finished ? 'completed' : run ? 'in_progress' : 'pending');
    item.append(title, status);
    return item;
  }));
  $('activityPanel').hidden = !journal.length;
  $('activityCount').textContent = `${journal.length} 项`;
  const lastConflict = journal.findLast(tool => tool.outcome === 'conflict');
  const conflictDetail = lastConflict ? `${lastConflict.workspaceFile ? `${lastConflict.workspaceFile} 在审阅期间发生变化。` : '工作目录在审阅期间发生变化。'}已保留磁盘上的版本。` : '';
  $('writeConflict').hidden = !lastConflict;
  if ($('writeConflictDetail').textContent !== conflictDetail) $('writeConflictDetail').textContent = conflictDetail;
  syncTaskPane();
}
function renderUpdates(article, updates = [], running = true) {
  article.querySelector('.task-updates')?.remove();
  if (!updates.length) return;
  const list = document.createElement('ul');
  list.className = 'task-updates';
  if (running) list.setAttribute('aria-live', 'polite');
  for (const { text, sent } of updates) {
    const item = document.createElement('li');
    const label = document.createElement('small');
    label.textContent = sent ? '补充要求 · 已发送' : running ? '补充要求 · 等待送达' : '补充要求 · 未送达';
    const content = document.createElement('span');
    content.textContent = text;
    item.append(label, content);
    list.append(item);
  }
  article.append(list);
}
function renderConversationHeader() {
  renderConversationMetrics(current, currentRun());
  const scope = projects.find(item => item.id === (current ? current.projectId : selectedProjectId));
  $('conversationScope').hidden = !scope;
  $('conversationProject').textContent = scope?.name || '';
  $('conversationProject').title = scope?.name || '';
  $('conversationTitle').hidden = !current;
  $('conversationTitle').textContent = current ? current.title || '未命名会话' : '';
  $('conversationTitle').title = current?.title || '';
  $('conversationMenu').hidden = !current;
  const origin = current?.branchOf && conversations.find(row => row.id === current.branchOf);
  $('branchSource').hidden = !origin;
  $('branchSource').title = origin ? '打开原会话 · ' + origin.title : '';
  return scope;
}
function renderCurrent({ preserveScroll = true } = {}) {
  clearTimeout(streamTimer);
  streamTimer = null;
  const scrollTop = $('scrollArea').scrollTop;
  const follow = !preserveScroll || nearBottom();
  const scope = renderConversationHeader();
  renderTaskPlan(current?.taskPlan);
  renderDrafts(draftsFor(current));
  renderActivity();
  const pending = current?.messages?.at(-1)?.recovery;
  const original = pending && current.messages[pending.originalUserIndex];
  $('resumeHint').textContent = original?.attachment ? '继续前可重新附上原文件。' : '可根据已保存的进度继续。';
  $('chat').replaceChildren();
  const messages = current?.messages || []; $('hero').hidden = messages.length > 0;
  messages.forEach((turn, index) => appendMessage(turn, index));
  streamContent = null;
  const run = currentRun();
  if (run && !run.starting && current?.pendingRun) {
    streamContent = appendMessage({ role: 'assistant', content: run.text, streaming: true });
    updateStream(run);
    renderUpdates(streamContent.parentElement, run.updates);
  }
  if (current) {
    $('agent').checked = current.agent === true;
    planning = Boolean(current.agent && current.planOnly && !current.scheduleId);
  }
  updateMode();
  $('systemPrompt').value = systemEdits.get(viewKey()) ?? current?.systemPrompt ?? '';
  $('contextStatus').textContent = systemEdits.has(viewKey()) ? '未保存' : '';
  syncWorkspace(scope);
  renderInteraction();
  if (current) $('modelSelect').value = current.providerId || '';
  update();
  renderProjects();
  renderHistory();
  if (follow) scrollBottom();
  else $('scrollArea').scrollTop = scrollTop;
}
function upsert(conversation, select = false) {
  if (!conversation?.id) throw new Error('后端未返回有效的对话');
  const index = conversations.findIndex(c => c.id === conversation.id);
  if (index < 0) conversations.push(conversation); else conversations[index] = conversation;
  if (select || current?.id === conversation.id) current = conversation;
  return conversation;
}
async function ensureConversation(localOnly = false) {
  if (!current) {
    if (!localOnly && !$('modelSelect').value) throw new Error('请先添加并选择模型配置');
    const agent = $('agent').checked, systemPrompt = $('systemPrompt').value;
    const homeKey = viewKey();
    upsert(await api.conversations.create({providerId:$('modelSelect').value, projectId: selectedProjectId}), true);
    unsent.delete(homeKey);
    if (systemEdits.delete(homeKey)) systemEdits.set(current.id, systemPrompt);
    if (taskPaneOpen) openInspectors.set(current.id, inspectorTab);
    upsert(await api.conversations.save({id:current.id, agent, systemPrompt, skillIds, planOnly: planning}));
    systemEdits.delete(current.id);
    renderConversationHeader();
    renderHistory();
  }
  return current;
}
let libraryItem, libraryBusy = false;
function renderSkillPicker() {
  $('skillList').replaceChildren(...skills.map(skill => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'library-choice';
    button.disabled = libraryBusy;
    button.setAttribute('aria-pressed', String(skill.id === libraryItem?.id));
    const label = document.createElement('span');
    label.textContent = skill.name;
    const mark = document.createElement('small');
    mark.textContent = skillIds.includes(skill.id) ? '已选用' : skill.builtin ? '内置' : '自定义';
    button.append(label, mark);
    button.onclick = () => inspectSkill(skill);
    return button;
  }));
  const selected = skillIds.includes(libraryItem?.id);
  $('toggleSkill').textContent = selected ? '取消选用' : '用于此任务';
  $('toggleSkill').disabled = libraryBusy || !libraryItem?.id || Boolean(currentRun());
  $('removeSkill').hidden = !libraryItem?.id || Boolean(libraryItem.builtin);
  $('saveSkill').hidden = !libraryItem || Boolean(libraryItem.builtin);
  for (const id of ['importSkill', 'closeSkills', 'removeSkill', 'saveSkill']) $(id).disabled = libraryBusy;
  $('closeSkills').disabled = libraryBusy;
}
function inspectSkill(skill) {
  libraryItem = skill;
  $('skillStatus').textContent = '';
  for (const [id, field] of [['skillName', 'name'], ['skillDescription', 'description'], ['skillBody', 'body']]) {
    $(id).value = skill?.[field] || '';
    $(id).readOnly = Boolean(skill?.builtin) || !skill;
  }
  renderSkillPicker();
}
async function skillAction(action) {
  if (libraryBusy) return;
  libraryBusy = true;
  $('skillStatus').textContent = '';
  renderSkillPicker();
  try { await action(); }
  catch (error) { $('skillStatus').textContent = errorMessage(error); }
  finally { libraryBusy = false; renderSkillPicker(); update(); }
}
$('skillsButton').onclick = () => {
  inspectSkill(skills.find(skill => skillIds.includes(skill.id)) || skills[0]);
  $('skillsDialog').showModal();
};
$('closeSkills').onclick = () => $('skillsDialog').close();
$('skillsDialog').addEventListener('cancel', event => { if (libraryBusy) event.preventDefault(); });
$('importSkill').onclick = () => skillAction(async () => {
  const candidate = await api.skills.import();
  if (!candidate) return;
  inspectSkill(candidate);
  $('skillStatus').textContent = '检查内容后保存到技能库。';
});
$('skillForm').onsubmit = event => {
  event.preventDefault();
  void skillAction(async () => {
    const saved = await api.skills.save({ id: libraryItem?.id, name: $('skillName').value, description: $('skillDescription').value, body: $('skillBody').value });
    skills = await api.skills.list();
    inspectSkill(skills.find(item => item.id === saved.id));
    $('skillStatus').textContent = '已保存';
  });
};
$('removeSkill').onclick = () => skillAction(async () => {
  await api.skills.delete(libraryItem.id);
  skills = await api.skills.list();
  skillIds = skillIds.filter(id => skills.some(skill => skill.id === id));
  inspectSkill(skills[0]);
  $('skillStatus').textContent = '已移除';
});
$('toggleSkill').onclick = () => skillAction(async () => {
  const id = libraryItem.id;
  const selected = skillIds.includes(id);
  if (!selected && skillIds.length >= 3) throw Error('每个任务最多选择 3 个技能');
  const next = selected ? skillIds.filter(item => item !== id) : [...skillIds, id];
  if (current) upsert(await api.conversations.save({ id: current.id, skillIds: next }));
  skillIds = next;
  $('skillStatus').textContent = selected ? '已取消选用' : '已用于此任务';
});
function fillProviders(preferred = current?.providerId || $('modelSelect').value) {
  $('modelSelect').replaceChildren(...providers.map(p => new Option(p.name + ' · ' + p.model, p.id)));
  if (!providers.length) $('modelSelect').append(new Option('请先配置模型', ''));
  if (preferred && !providers.some(p => p.id === preferred)) $('modelSelect').append(new Option('原模型已删除 · 请选择模型', ''));
  if (preferred) $('modelSelect').value = providers.some(p => p.id === preferred) ? preferred : '';
  if (!current && !providers.some(p => p.id === preferred)) $('modelSelect').value = newChatModel();
  fillDefaultModels();
  $('modelPicker').hidden = providers.length === 0;
  $('connectModel').hidden = providers.length !== 0;
  renderProviders(); update();
}
async function refreshProviders(preferred) { providers = await api.providers.list(); fillProviders(preferred); }
function resetProvider(provider = null) {
  editing = provider?.id || null; form.reset(); $('availableModels').replaceChildren();
  for (const key of ['name','kind','baseUrl','model']) if (provider) form.elements.namedItem(key).value = provider[key] ?? '';
  form.elements.namedItem('stream').checked = provider ? provider.stream !== false : true;
  $('providerFormTitle').textContent = provider ? '编辑模型配置' : '新增模型配置';
  $('keyStatus').textContent = provider?.hasKey ? 'API Key 已加密保存；留空可保留。' : '尚未保存 API Key。';
  for (const id of ['testProvider','fetchModels','deleteProvider']) $(id).disabled = !editing;
  renderProviders();
}
function renderProviders() {
  $('providerList').replaceChildren();
  if (!providers.length) { const p = document.createElement('p'); p.className='muted'; p.textContent='添加第一个模型配置'; $('providerList').append(p); }
  for (const provider of providers.filter(item => !item.connectionId)) {
    const button = document.createElement('button'); button.type='button'; button.className='provider-choice' + (editing === provider.id ? ' active' : '');
    button.setAttribute('aria-pressed', String(editing === provider.id));
    button.textContent=provider.name; const small=document.createElement('small'); small.textContent=provider.model; button.append(small);
    button.disabled=settingsBusy; button.onclick=()=>{ resetProvider(provider); status(''); }; $('providerList').append(button);
  }
}
async function settingsAction(fn) {
  if (settingsBusy) return;
  settingsBusy = true;
  for (const id of ['providerFields', 'mcpFields', 'addProvider', 'providerSubmit', 'mcpSubmit']) $(id).disabled = true;
  renderProviders();
  try {
    await fn();
  } catch (error) {
    status(errorMessage(error), true);
  } finally {
    settingsBusy = false;
    for (const id of ['providerFields', 'addProvider', 'providerSubmit']) $(id).disabled = false;
    $('mcpFields').disabled = $('mcpSubmit').disabled = !settingsLoaded;
    renderProviders();
    for (const id of ['testProvider', 'fetchModels', 'deleteProvider']) $(id).disabled = !editing;
  }
}
async function openSettings() {
  if (locked) return;
  if (!$('settingsDialog').open) {
    $('settingsDialog').showModal();
    $('settingsBody').scrollTop = 0;
  }
  await settingsAction(async()=>{
    status('正在加载设置…'); await refreshProviders();
    const active = selectedProvider();
    resetProvider(providers.find(p => p.id === (active?.connectionId || active?.id)) || providers[0]);
    settingsLoaded=false; const settings=await api.settings.get();
    $('mcpServers').value=JSON.stringify(settings.mcpServers || [],null,2); $('maxSteps').value=settings.maxSteps ?? 12; settingsLoaded=true; status('');
  });
}
$('settings').onclick = $('settingsCompact').onclick = () => {
  setTab(providers.length ? 'general' : 'provider');
  openSettings();
};
$('connectModel').onclick = () => {
  setTab('provider');
  openSettings();
};
$('closeSettings').onclick=()=>$('settingsDialog').close();
const settingTabs = ['general', 'provider', 'mcp'];
function setTab(id) {
  for (const name of settingTabs) {
    const active = name === id;
    $(name + 'Panel').hidden = !active;
    if ($(name + 'Submit')) $(name + 'Submit').hidden = !active;
    $(name + 'Tab').setAttribute('aria-selected', String(active));
    $(name + 'Tab').tabIndex = active ? 0 : -1;
  }
  $('settingsBody').scrollTop = 0;
  status('');
}
for (const [i, name] of settingTabs.entries()) {
  const tab = $(name + 'Tab');
  tab.onclick = () => setTab(name);
  tab.onkeydown = e => {
    const j = { ArrowLeft: i-1, ArrowRight: i+1, Home: 0, End: settingTabs.length-1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    const target = settingTabs.at(j % settingTabs.length);
    setTab(target);
    $(target + 'Tab').focus();
  };
}
function fillDefaultModels() {
  $('defaultModel').replaceChildren(new Option('第一个已连接模型', ''), ...providers.map(p => new Option(p.name + ' · ' + p.model, p.id)));
  $('defaultModel').value = providers.some(p => p.id === prefs.defaultModel) ? prefs.defaultModel : '';
}
function applyPreferences(next) {
  prefs = next;
  document.body.dataset.conversationScene = prefs.conversationScene;
  document.documentElement.dataset.readingFont = prefs.readingFont;
  document.documentElement.dataset.textSize = prefs.textSize;
  for (const input of $('appearance').elements) input.checked = input.value === prefs.appearance;
  for (const key of ['conversationScene', 'readingFont', 'textSize', 'sendKey']) $(key).value = prefs[key];
  fillDefaultModels();
  update();
}
$('generalPanel').onchange = async e => {
  const input = e.target;
  const key = input.name || input.id;
  const controls = [...$('generalPanel').querySelectorAll('input, select')];
  controls.forEach(control => { control.disabled = true; });
  try {
    applyPreferences(await api.preferences.set({ key, value: input.value }));
    if (input.id === 'defaultModel' && !current && !$('prompt').value && !attachments.length) $('modelSelect').value = newChatModel();
    update();
    status('偏好已保存');
  } catch (error) { applyPreferences(prefs); status(errorMessage(error), true); }
  finally { controls.forEach(control => { control.disabled = false; }); input.focus(); }
};
const presets={
  openai:{name:'OpenAI',kind:'openai-compatible',baseUrl:'https://api.openai.com/v1'},
  anthropic:{name:'Anthropic',kind:'anthropic',baseUrl:'https://api.anthropic.com/v1'},
  deepseek:{name:'DeepSeek',kind:'openai-compatible',baseUrl:'https://api.deepseek.com/v1'},
  gemini:{name:'Gemini',kind:'openai-compatible',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai'},
  qwen:{name:'通义千问',kind:'openai-compatible',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1'},
  ollama:{name:'Ollama',kind:'ollama',baseUrl:'http://127.0.0.1:11434/v1'}
};
$('providerPreset').onchange=()=>{
  const value=presets[$('providerPreset').value];if(!value)return;
  for(const key of ['name','kind','baseUrl'])form.elements.namedItem(key).value=value[key];
  status('已填充地址；请填写账户实际可用的模型 ID 和 API Key 后保存。');
};
$('addProvider').onclick=()=>{resetProvider();status('');form.elements.namedItem('name').focus();};
form.onsubmit=event=>{event.preventDefault();
  const data=Object.fromEntries(new FormData(form));
  data.stream=form.elements.namedItem('stream').checked; data.clearKey=form.elements.namedItem('clearKey').checked;
  settingsAction(async()=>{
  status('正在保存…'); const id=await api.providers.save({...data,id:editing});
  await refreshProviders(current?.providerId || id); resetProvider(providers.find(p=>p.id===id)); status('模型配置已保存。');
});};
$('testProvider').onclick=()=>settingsAction(async()=>{ status('正在测试已保存的配置…'); status(plain(await api.providers.test(editing))); });
$('fetchModels').onclick=()=>settingsAction(async()=>{ status('正在获取已保存配置的模型列表…'); const models=await api.providers.models(editing); $('availableModels').replaceChildren(...models.map(name=>new Option(name,name))); status(`已获取 ${models.length} 个模型，可在模型 ID 中输入或选择。`); form.elements.namedItem('model').focus(); });
$('deleteProvider').onclick=()=>settingsAction(async()=>{ await api.providers.delete(editing); await refreshProviders(); resetProvider(providers[0]); status('模型配置已删除。'); });
$('mcpForm').onsubmit=event=>{event.preventDefault();settingsAction(async()=>{
  const mcpServers=JSON.parse($('mcpServers').value); if(!Array.isArray(mcpServers)) throw new Error('MCP 配置必须是 JSON 数组');
  for(const [index,server] of mcpServers.entries()) {
    const invalid=message=>{throw new Error(`服务器 ${index+1}：${message}`);};
    if(!server || typeof server!=='object' || Array.isArray(server)) invalid('必须是配置对象');
    if(typeof server.name!=='string' || !server.name.trim()) invalid('请提供 name');
    if(server.enabled!==undefined && typeof server.enabled!=='boolean') invalid('enabled 必须为 true 或 false');
    if(server.transport==='stdio') { if(typeof server.command!=='string' || !server.command.trim()) invalid('stdio 需要 command'); if(server.args!==undefined && (!Array.isArray(server.args) || server.args.some(v=>typeof v!=='string'))) invalid('args 必须为字符串数组'); }
    else if(server.transport==='http') { let url; try{url=new URL(server.url);}catch{invalid('请提供有效的 HTTP URL');} if(!['http:','https:'].includes(url.protocol)) invalid('URL 必须使用 http 或 https'); }
    else invalid('transport 必须是 stdio 或 http');
    for(const key of ['env','headers']) if(server[key]!==undefined && (!server[key] || typeof server[key]!=='object' || Array.isArray(server[key]) || Object.values(server[key]).some(v=>typeof v!=='string'))) invalid(key+' 必须为字符串键值对象');
  }
  const maxSteps=Number($('maxSteps').value); if(!Number.isSafeInteger(maxSteps) || maxSteps<1 || maxSteps>30) throw new Error('最大步数必须为 1 到 30 的整数');
  const saved=await api.settings.save({mcpServers,maxSteps}); $('mcpServers').value=JSON.stringify(saved.mcpServers,null,2); $('maxSteps').value=saved.maxSteps; status('运行设置已保存。仅 enabled: true 的服务器会启用。');
});};
$('dismissError').onclick=()=>{$('errorBanner').hidden=true;};
$('newChat').onclick = () => {
  if (locked) return;
  if (current) changeView(null, selectedProjectId);
  else focusPrompt();
};
$('modelSelect').onchange=()=>action(async()=>{workspaceBrowser.clearAssist();if(current){upsert(await api.conversations.save({id:current.id,providerId:$('modelSelect').value}));renderHistory();}});
$('workspace').onclick = () => {
  if (!current) return openFolder();
  return action(async () => {
    const conversation = await api.workspace.pick(current.id);
    if (!conversation) return;
    upsert(conversation);
    renderCurrent();
  });
};
const composerTools = $('composerTools');
const toolsButton = $('composerToolsButton');
function availableComposerTools() {
  return [...composerTools.querySelectorAll('button:not([hidden]):enabled')];
}
toolsButton.addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  composerTools.showPopover({ source: toolsButton });
  availableComposerTools().at(event.key === 'ArrowUp' ? -1 : 0)?.focus();
});
composerTools.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    composerTools.hidePopover();
    toolsButton.focus();
    return;
  }
  const items = availableComposerTools();
  const index = items.indexOf(document.activeElement);
  const position = {
    Home: 0, End: items.length - 1, ArrowDown: (index + 1) % items.length,
    ArrowUp: (index - 1 + items.length) % items.length
  }[event.key];
  if (position === undefined) return;
  event.preventDefault();
  items[position]?.focus();
});
composerTools.addEventListener('click', event => {
  if (event.target.closest('button') && composerTools.matches(':popover-open')) composerTools.hidePopover();
}, { capture: true });
function showSystemPanel(open) {
  $('systemPanel').hidden = !open;
  $('toggleSystem').setAttribute('aria-expanded', String(open));
  if (open) $('systemPrompt').focus();
  else focusPrompt();
}
$('toggleSystem').onclick = () => showSystemPanel($('systemPanel').hidden);
$('closeSystem').onclick = () => showSystemPanel(false);
$('systemPanel').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing) return;
  event.preventDefault();
  showSystemPanel(false);
});
$('saveContext').onclick=()=>action(async()=>{await ensureConversation();upsert(await api.conversations.save({id:current.id,systemPrompt:$('systemPrompt').value,agent:$('agent').checked,planOnly:planning}));systemEdits.delete(viewKey());$('contextStatus').textContent='已保存';});
$('systemPrompt').oninput = () => {
  if ($('systemPrompt').value === (current?.systemPrompt || '')) systemEdits.delete(viewKey());
  else systemEdits.set(viewKey(), $('systemPrompt').value);
  $('contextStatus').textContent = systemEdits.has(viewKey()) ? '未保存' : '';
};
$('attach').onclick = () => action(async () => {
  if (referencesFull()) return;
  const picked = await api.attachment.pick();
  if (picked) addReference(picked);
  focusPrompt();
});
for (const button of document.querySelectorAll('[data-prompt]')) {
  button.onclick = () => action(async () => {
    const prompt = $('prompt');
    const { mode, prompt: suggestion } = button.dataset;
    if (mode && !planning) await setMode(mode);
    const draft = prompt.value;
    if (!draft.trim()) prompt.value = suggestion;
    else if (!mode && !draft.includes(suggestion)) {
      const addition = (draft.endsWith('\n') ? '' : '\n') + suggestion;
      if (draft.length + addition.length > prompt.maxLength) throw Error('草稿已接近字数上限，无法追加提示。');
      prompt.setRangeText(addition, draft.length, draft.length, 'end');
    }
    focusPrompt();
  });
}
$('prompt').oninput=update;
$('prompt').oncompositionstart=()=>{composing=true;}; $('prompt').oncompositionend=()=>{composing=false;};
$('prompt').onkeydown = event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
  if (prefs.sendKey === 'modifier' && !event.metaKey && !event.ctrlKey) return;
  if (currentRun() && !canSteer(currentRun())) return;
  event.preventDefault();
  $('composer').requestSubmit();
};
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || !$('generationStudio').hidden) return;
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k'
      && !locked && !document.querySelector('dialog[open]') && !event.target.closest('#terminalPanel .xterm')) {
    event.preventDefault();
    navigatorPanel.open(document.activeElement);
    return;
  }
  if (presence.isHome() && $('presenceEntry').hidden) return;
  if (event.key === 'Escape' && document.querySelector(':popover-open')) return;
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyM' && !document.querySelector('dialog[open]') && !$('chatColumn').hidden) {
    event.preventDefault();
    if (!$('composer').hidden) $(providers.length ? 'chooseModel' : 'connectModel').click();
    return;
  }
  if (event.ctrlKey && event.code === 'Backquote' && fileScope && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    $('terminalButton').click();
    return;
  }
  if (event.target.closest('#terminalPanel .xterm')) return;
  if (event.key === '@' && event.target === $('prompt') && !event.isComposing && !$('referenceFile').hidden && !$('referenceFile').disabled) {
    const beforeCursor = $('prompt').value.slice(0, $('prompt').selectionStart);
    if (beforeCursor === '' || /\s$/.test(beforeCursor)) {
      event.preventDefault();
      $('referenceFile').click();
      return;
    }
  }
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
    if (taskPaneOpen && (compactInspector.matches || $('taskPane').contains(document.activeElement))) $('closeTaskPane').click();
    else if (!$('filePreview').hidden) workspaceBrowser.close(true);
  }
  if (!(event.metaKey || event.ctrlKey) || document.querySelector('dialog[open]')) return;
  if (fileScope && event.key === '2' && desktopSplit.matches) {
    event.preventDefault();
    $('developmentMode').click();
    return;
  }
  if (fileScope && (event.key.toLowerCase() === 'p' || (event.shiftKey && event.key.toLowerCase() === 'f'))) {
    event.preventDefault();
    projectSearch.show(fileScope.target, { names: event.key.toLowerCase() === 'p' });
    return;
  }
  if (event.key.toLowerCase() === 's' && !$('filePreview').hidden && !$('chatColumn').contains(document.activeElement)) {
    event.preventDefault();
    workspaceBrowser.save();
    return;
  }
  const target = {n: 'newChat', o: 'openFolder', ',': 'settings'}[event.key.toLowerCase()];
  if (!target) return;
  event.preventDefault();
  $(target).click();
});
$('stop').onclick = $('stopPending').onclick = async () => {
  const run = currentRun();
  if (!run || run.starting || run.stopping || run.finishing) return;
  $('stop').disabled = $('stopPending').disabled = true;
  try {
    await api.chat.stop({ conversationId: run.conversationId, requestId: run.requestId });
  } catch (error) {
    if (run === currentRun()) showError(error);
  } finally { update(); }
};

let displayedInteractionId;
function renderInteraction() {
  const run = currentRun();
  const interaction = run?.interaction;
  const panel = $('interactionPanel');
  panel.hidden = !interaction;
  if (interaction && composerTools.matches(':popover-open')) composerTools.hidePopover();
  $('composer').hidden = $('composeMeta').hidden = Boolean(interaction);
  if (!interaction) {
    if (displayedInteractionId) workspaceReview.set(null);
    displayedInteractionId = null;
    return;
  }
  if (displayedInteractionId === interaction.id) return;
  displayedInteractionId = interaction.id;
  const approval = interaction.kind === 'approval';
  const reviewed = approval && interaction.review;
  workspaceReview.set(reviewed || null);
  const wasPreviewing = $('chatColumn').hidden && fileOpened;
  const wasCompactPane = compactInspector.matches && !$('taskPane').hidden;
  if (wasPreviewing) workspaceBrowser.close();
  if (wasCompactPane) setTaskPane(false);
  panel.classList.toggle('approval', approval);
  $('interactionIcon').className = `ui-icon ${approval ? 'i-lock' : 'i-chat'}`;
  $('interactionTitle').textContent = reviewed ? '文件改动待审阅' : approval ? '需要确认' : '需要你的回答';
  $('interactionQuestion').textContent = reviewed ? '' : interaction.title;
  $('interactionQuestion').hidden = Boolean(reviewed);
  $('approvalDetail').textContent = reviewed ? '' : interaction.detail || '';
  $('approvalDetail').hidden = !approval || Boolean(reviewed);
  $('approvalActions').hidden = !approval || Boolean(reviewed);
  $('answerForm').hidden = approval;
  $('interactionStatus').textContent = $('approvalStatus').textContent = '';
  $('answerText').value = run.answerDraft || '';
  $('questionOptions').replaceChildren(...(interaction.options || []).map(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option;
    button.onclick = () => {
      $('answerText').value = option;
      $('answerText').oninput();
      $('answerText').focus();
    };
    return button;
  }));
  if (wasPreviewing || wasCompactPane) focusPrompt();
  updateInteractionButtons(run);
}
function updateInteractionButtons(run) {
  const disabled = Boolean(run?.answering || run?.stopping);
  $('sendAnswer').disabled = disabled || !$('answerText').value.trim();
  $('allowApproval').disabled = $('denyApproval').disabled = disabled;
  workspaceReview.setBusy(disabled);
}
$('answerText').oninput = () => {
  const run = currentRun();
  if (run) run.answerDraft = $('answerText').value;
  updateInteractionButtons(run);
};
async function answerInteraction(answer) {
  const run = currentRun();
  const interactionId = run?.interaction?.id;
  if (!interactionId || run.answering || run.stopping) return;
  run.answering = true;
  const status = $(run.interaction.kind === 'approval' ? 'approvalStatus' : 'interactionStatus');
  status.textContent = '';
  workspaceReview.setStatus('');
  updateInteractionButtons(run);
  try {
    await api.chat.answer({ conversationId: run.conversationId, requestId: run.requestId, interactionId, answer });
  } catch (error) {
    if (displayedInteractionId === interactionId) {
      status.textContent = errorMessage(error);
      workspaceReview.setStatus(errorMessage(error));
      if (run.interaction?.review && !workspaceReview.pendingOpen()) showError(error);
    }
  } finally {
    run.answering = false;
    if (run === currentRun()) updateInteractionButtons(run);
  }
}
$('answerForm').onsubmit = event => {
  event.preventDefault();
  const answer = $('answerText').value.trim();
  if (answer) void answerInteraction(answer);
};
$('denyApproval').onclick = () => answerInteraction(false);
$('allowApproval').onclick = () => answerInteraction(true);

function updateStream(run) {
  if (!streamContent) return;
  streamContent.parentElement.classList.toggle('pending', !run.text);
  streamContent.dataset.phase = runStatus(run);
  // Append deltas directly. Parse and sanitize Markdown once, when the turn completes.
  const node = streamContent.firstChild;
  if (node?.nodeType === Node.TEXT_NODE && run.text.length >= node.length && run.text.length < 96000) {
    node.appendData(run.text.slice(node.length));
  } else streamContent.textContent = run.text;
}
function handleRunEvent(event) {
  const { conversationId, requestId, type } = event;
  const visible = current?.id === conversationId;
  let run = runs.get(conversationId);
  if (type === 'started') {
    const submission = run?.requestId === requestId && run.starting ? run : null;
    runs.set(conversationId, { ...event.run, tools: event.conversation.pendingRun?.tools || [] });
    upsert(event.conversation);
    if (submission) {
      if (visible) {
        if (presence.isHome() && !$('presenceEntry').hidden) presence.enterConversation();
        presence.voiceHint();
        if (!submission.resume && $('prompt').value === submission.sourceText) $('prompt').value = '';
        attachments = attachments.filter(item => !submission.attachmentIds.includes(item.id));
        unsent.delete(conversationId);
      } else {
        const draft = unsent.get(conversationId);
        if (draft) {
          if (!submission.resume && draft.text === submission.sourceText) draft.text = '';
          draft.attachments = draft.attachments?.filter(item => !submission.attachmentIds.includes(item.id));
        }
      }
    }
    if (visible) renderCurrent({ preserveScroll: false });
    else renderHistory();
    return;
  }
  if (run?.requestId !== requestId) return;
  if (type === 'finished') {
    runs.delete(conversationId);
    if (event.conversation) upsert(event.conversation);
    if (visible) {
      const wasAnswering = workspaceReview.pendingOpen() || $('interactionPanel').contains(document.activeElement) || document.activeElement === $('stop');
      renderCurrent();
      if (event.error) showError(event.error);
      else presence.readReply(event.conversation?.messages?.at(-1));
      if (wasAnswering) focusPrompt();
    } else {
      if (event.conversation?.revision) refreshReplyVersions();
      renderHistory();
    }
    return;
  }
  if (type === 'metrics') {
    run.metrics = event.metrics;
    if (visible) renderConversationMetrics(current, run);
    return;
  }
  const item = conversations.find(row => row.id === conversationId);
  if (type === 'text') {
    const firstText = !run.text;
    run.text = (run.text + event.text).slice(-96000);
    const paint = () => {
      streamTimer = null;
      if (run === currentRun()) {
        const follow = nearBottom();
        updateStream(run);
        if (follow) scrollBottom();
      }
    };
    if (visible && firstText) paint();
    else if (visible && !streamTimer) streamTimer = setTimeout(paint, 32);
    return;
  }
  const follow = visible && nearBottom();
  if (type === 'plan' && item) {
    item.taskPlan = event.steps;
    if (visible) renderTaskPlan(event.steps);
  } else if (type === 'drafts' && item) {
    item.drafts = event.drafts;
    delete item.draft;
    if (visible) renderDrafts(event.drafts);
  } else if (type === 'workspace-changes' && item) {
    item.workspaceChanges = event.changes;
    if (visible) {
      renderWorkspaceChanges(event.changes);
      workspaceBrowser.refresh();
      gitBrowser.invalidate();
      if (event.historySaved === false) showError('文件已写入，改动记录未能保存。');
    }
  } else if (type === 'tool') {
    run.tools = event.journal;
    if (visible) renderActivity();
  } else if (type === 'status') {
    run.status = event.text;
    if (visible) {
      if (streamContent) streamContent.dataset.phase = runStatus(run);
      update();
    }
  } else if (type === 'updates') {
    run.updates = event.updates;
    if (visible && streamContent) renderUpdates(streamContent.parentElement, event.updates);
  } else if (type === 'stopping' || type === 'interaction') {
    const focusWasInside = visible && (workspaceReview.pendingOpen() || $('interactionPanel').contains(document.activeElement));
    if (type === 'stopping') run.stopping = true;
    if (type === 'interaction') {
      run.interaction = event.interaction;
      run.answerDraft = '';
    }
    if (visible) {
      renderInteraction();
      updateInteractionButtons(run);
      if (focusWasInside && !run.interaction) focusPrompt();
    }
    renderRunning();
    update();
  }
  if (follow) scrollBottom();
}

let initialEvents = [];
const unsubscribe = api.chat.onEvent(event => {
  if (initialEvents) initialEvents.push(event);
  else handleRunEvent(event);
});
window.addEventListener('beforeunload', unsubscribe);
$('composer').onsubmit = event => {
  event.preventDefault();
  const run = currentRun();
  if (run) void submitUpdate(run);
  else void sendMessage($('prompt').value.trim());
};
$('steerNow').onclick = () => {
  const run = currentRun();
  if (run) void submitUpdate(run, true);
};
async function submitUpdate(run, immediate = false) {
  const source = $('prompt').value;
  const text = source.trim();
  if (!text || !canSteer(run) || run.submittingUpdate) return;
  if (ConnectionIntent.mask(text) !== text) {
    $('prompt').value = ConnectionIntent.mask(source);
    showError('已隐藏密钥。请在任务结束后打开「＋ → 接口检测」。');
    return;
  }
  run.submittingUpdate = true;
  update();
  try {
    await api.chat.update({ conversationId: run.conversationId, requestId: run.requestId, text, immediate });
    if (current?.id === run.conversationId && $('prompt').value === source) $('prompt').value = '';
    else if (current?.id !== run.conversationId && unsent.get(run.conversationId)?.text === source) unsent.get(run.conversationId).text = '';
  } catch (error) {
    if (current?.id === run.conversationId) showError(error);
  } finally { run.submittingUpdate = false; update(); }
}
$('resumeTask').onclick = () => sendMessage('继续上次未完成的任务', true);
async function sendMessage(text, resume = false, media = []) {
  if (currentRun() || locked || !text) return;
  const intent = !resume && ConnectionIntent.detect(text);
  if (intent) {
    $('prompt').value = ConnectionIntent.mask($('prompt').value);
    showConnectionCheck(intent, true);
    return;
  }
  if (!$('modelSelect').value) return;
  locked = true;
  $('errorBanner').hidden = true;
  update();
  let submission, result;
  try {
    await ensureConversation();
    const conversationId = current.id;
    upsert(await api.conversations.save({ id: conversationId, providerId: $('modelSelect').value, systemPrompt: $('systemPrompt').value, agent: $('agent').checked, planOnly: planning, skillIds }));
    systemEdits.delete(conversationId);
    const requestId = crypto.randomUUID();
    const attachmentIds = attachments.map(item => item.id);
    submission = { conversationId, requestId, attachmentIds, resume, sourceText: $('prompt').value, starting: true, status: '正在准备' };
    runs.set(conversationId, submission);
    result = api.chat.send({ conversationId, text, attachmentIds, requestId, resume, media });
  } catch (error) { showError(error); }
  finally {
    locked = false;
    renderHistory();
  }
  if (!result) return;
  try { await result; }
  catch (error) {
    // Started runs report their terminal state through the same event channel as other updates.
    if (runs.get(submission.conversationId) !== submission) return;
    runs.delete(submission.conversationId);
    if (current?.id === submission.conversationId) showError(error);
    renderHistory();
  }
}
async function initialize() {
  locked=true;update();
  const results=await Promise.allSettled([
    api.brand().then(({ name, icon, mark }) => {
      if (name) {
        document.title = name;
        $('brandName').textContent = name;
        const parts = /^(.*?)\s+(Agent)$/i.exec(name);
        for (const prefix of ['presence', 'room']) {
          $(prefix + 'Brand').textContent = parts ? parts[1] : name;
          $(prefix + 'BrandSuffix').textContent = parts?.[2] || '';
          $(prefix + 'BrandSuffix').hidden = !parts;
        }
      }
      if (mark || icon) for (const img of document.querySelectorAll('.logo, .studio-brand-knot, .message-avatar')) img.src = mark || icon;
      for (const element of document.querySelectorAll('[aria-label="Xiaoxiao Agent 首页"]')) element.setAttribute('aria-label', name + '首页');
    }),
    api.preferences.get().then(applyPreferences).finally(() => refreshProviders()),
    api.skills.list().then(items => { skills = items; }),
    api.projects.list().then(rows => { projects = rows; renderProjects(); update(); }),
    api.chat.state().then(snapshot => {
      conversations = snapshot.conversations;
      for (const run of snapshot.runs) {
        const conversation = conversations.find(row => row.id === run.conversationId);
        runs.set(run.conversationId, { ...run, tools: conversation?.pendingRun?.tools || [] });
      }
      const queued = initialEvents;
      initialEvents = null;
      for (const event of queued) if (event.sequence > snapshot.sequence) handleRunEvent(event);
      renderCurrent();
    })
  ]);
  initialEvents = null;
  for(const result of results)if(result.status==='rejected')showError(result.reason);
  locked=false;update();if (!presence.isHome()) focusPrompt();
}
installSilkStrands($('conversationField'), { travellingLights: true });
installSilkStrands($('creationField'));
const presence = createPresence();
const showConnectionCheck = installConnectionCheck();
installSessionActions();
installRevisionEditor();
initialize();
