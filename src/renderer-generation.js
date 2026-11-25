'use strict';

let generationKind = 'image';
let generationRequestId = '';
let generationHistory = [];
const generationQueue = [];
let runningCreation = null;
const activeThreads = { image: crypto.randomUUID(), video: crypto.randomUUID(), audio: crypto.randomUUID() };
const creationDrafts = new Map();
const draftPrefix = 'xiaoxiao-creation-draft:';
const unsavedAssets = new Map();
const creationThread = row => row.threadId || row.id;
const activeThread = () => activeThreads[generationKind];
const currentTurns = () => generationHistory.filter(row => row.kind === generationKind && creationThread(row) === activeThread()).reverse();
const isCompleted = row => !row.state || row.state === 'done';

const generationTabs = {
  image: ['generationTabImage', 'generationPanelImage'],
  video: ['generationTabVideo', 'generationPanelVideo'],
  audio: ['generationTabAudio', 'generationPanelAudio']
};
const generationLabels = { image: '生图', video: '生视频', audio: '语音' };
const generationPromptLabels = { image: '画面描述', video: '视频描述', audio: '朗读文本' };
const generationPlaceholders = {
  image: '描述主体、风格、构图、光线和氛围…',
  video: '描述主体动作、镜头运动、场景变化和节奏…',
  audio: '输入想听到的文字…'
};
const generationStorageKey = 'xiaoxiao-generation-history-v1';
const localVoiceId = 'macos-system-speech';
function isLocalVoice(kind, providerId) {
  return api.platform === 'darwin' && kind === 'audio' && providerId === localVoiceId;
}
const generationPresets = {
  image: [
    ['产品摄影', '产品摄影，主体清晰，柔和棚拍光线，细腻材质，背景简洁，商业广告质感'],
    ['电影剧照', '电影剧照，宽银幕构图，富有层次的光影，胶片颗粒，克制的色彩和叙事氛围'],
    ['编辑插画', '编辑风格插画，独特的形状语言，精致配色，清晰主体，适合杂志封面'],
    ['空间设计', '建筑与室内摄影，真实材质，柔和自然光，干净线条，具有空间纵深']
  ],
  video: [
    ['电影镜头', '电影感短片，主体动作自然连贯，镜头缓慢推进，光线有层次，结尾留白'],
    ['产品展示', '产品展示短片，环绕镜头，细节特写，材质反光真实，节奏克制而高级'],
    ['自然风光', '自然风光短片，云雾和水面缓慢流动，镜头平稳，保留真实环境光变化'],
    ['社交竖屏', '竖屏短片，开场主体明确，动作节奏鲜明，镜头稳定，画面简洁易读']
  ],
  audio: [
    ['温柔旁白', '你好，欢迎来到这里。接下来的时间，我们一起开启一段新的探索。'],
    ['明快讲解', '先从最简单的一步开始。跟着节奏，很快就能掌握关键方法。'],
    ['沉浸叙事', '午后的风穿过窗边，带来一阵安静的香气。她合上书，决定去看看远方。'],
    ['产品播报', '为你的日常带来更简单、自然的体验。轻轻一步，开始发现新的可能。']
  ]
};

// Store media separately so opening the history rail reads only the metadata.
const creationDatabase = new Promise((resolve, reject) => {
  const request = indexedDB.open('xiaoxiao-creations', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('records', { keyPath: 'id' });
    request.result.createObjectStore('media');
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
});

async function archiveOperation(mode, operation) {
  const db = await creationDatabase;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['records', 'media'], mode);
    const result = operation(tx.objectStore('records'), tx.objectStore('media'));
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = () => reject(tx.error || Error('创作记录写入失败'));
  });
}

let historyLoaded = false;
(async () => {
  const previous = localStorage.getItem(generationStorageKey);
  if (previous) {
    const rows = JSON.parse(previous);
    await archiveOperation('readwrite', (records, media) => {
      for (const { result, ...row } of rows) {
        records.put(row);
        if (result) media.put(result.assets || [result], row.id);
      }
    });
    localStorage.removeItem(generationStorageKey);
  }
  generationHistory = await archiveOperation('readonly', records => records.getAll());
  generationHistory.sort((a, b) => b.createdAt - a.createdAt);
  const receipts = await api.generation.receipts();
  const delivered = generationHistory.filter(row => row.state === 'done' && receipts[row.id]);
  if (delivered.length) await api.generation.forget(delivered.map(row => row.id));
  for (const row of generationHistory) {
    if (row.state !== 'done' && receipts[row.id]) {
      row.receipt = receipts[row.id];
      row.state = 'stopped';
      row.status = videoRecoveryText(row);
      await archiveOperation('readwrite', records => records.put(row));
    } else if (['running', 'queued'].includes(row.state)) {
      if (row.kind === 'video' && row.state === 'running' && !row.tracksSubmission) row.receipt = 'unknown';
      row.status = row.receipt ? videoRecoveryText(row) : row.state === 'queued' || row.tracksSubmission
        ? '任务尚未提交，可重新生成。' : '上次生成已中断，可以重新生成。';
      row.state = 'stopped';
      await archiveOperation('readwrite', records => records.put(row));
    }
  }
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(draftPrefix)) continue;
    try {
      const draft = JSON.parse(localStorage.getItem(key));
      if (Object.hasOwn(generationTabs, draft.kind) && typeof draft.text === 'string') creationDrafts.set(key.slice(draftPrefix.length), draft);
    } catch { /* Ignore individual unreadable drafts. */ }
  }
  renderGenerationHistory();
})().catch(error => { $('generationStatus').textContent = errorMessage(error); }).finally(() => {
  historyLoaded = true;
  updateGenerationComposer();
});

function panelFields(kind = generationKind) {
  return [...$(generationTabs[kind][1]).querySelectorAll('input, select, textarea')];
}

function restoreFields(row) {
  for (const field of panelFields(row.kind)) {
    const value = row.fields?.[field.id];
    if (value !== undefined) field.value = value;
  }
}

function saveCreationDraft() {
  const id = activeThread();
  const draft = creationDrafts.get(id) || { kind: generationKind };
  const text = generationPromptElement().value;
  if (text.trim() && draft.text !== text) draft.updatedAt = Date.now();
  draft.text = text;
  draft.fields = captureFields();
  creationDrafts.set(id, draft);
  try {
    if (draft.text.trim() || draft.editing) localStorage.setItem(draftPrefix + id, JSON.stringify(draft));
    else localStorage.removeItem(draftPrefix + id);
  } catch (error) { $('generationStatus').textContent = '草稿暂时只能在本窗口找回 · ' + errorMessage(error); }
}

function generationCapitalized(kind = generationKind) {
  return kind[0].toUpperCase() + kind.slice(1);
}

function generationPromptElement() {
  return document.querySelector('#generationImagePrompt, #generationVideoPrompt, #generationAudioPrompt');
}

function generationModelId(kind = generationKind) {
  return $(`generation${generationCapitalized(kind)}Model`).value;
}

function generationHistoryIcon(kind) {
  return kind === 'image' ? 'image' : kind === 'video' ? 'film' : 'audio';
}

function formatGenerationDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  const now = new Date();
  if (now.toDateString() === date.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function renderGenerationHistory() {
  const list = $('generationHistory');
  list.replaceChildren();
  const groups = new Map();
  for (const item of generationHistory) {
    const key = creationThread(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [id, draft] of creationDrafts) {
    if ((draft.text.trim() || draft.editing) && !groups.has(id)) groups.set(id, []);
  }
  if (!groups.size) {
    const empty = document.createElement('p');
    empty.className = 'generation-history-empty';
    empty.textContent = '还没有创作记录';
    list.append(empty);
    return;
  }
  const latest = ([id, items]) => Math.max(creationDrafts.get(id)?.updatedAt || 0, items[0]?.createdAt || 0);
  for (const [id, items] of [...groups].sort((a, b) => latest(b) - latest(a))) {
    const draft = creationDrafts.get(id);
    const kind = items[0]?.kind || draft.kind;
    const name = items.at(-1)?.prompt || draft.text || '未命名草稿';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'generation-history-item';
    button.dataset.thread = id;
    button.dataset.rounds = items.length;
    button.title = name;
    const icon = workspaceIcon(generationHistoryIcon(kind));
    const body = document.createElement('span');
    body.className = 'generation-history-copy';
    const title = document.createElement('strong');
    title.textContent = name;
    const meta = document.createElement('small');
    const summary = draft?.text.trim() || draft?.editing ? '草稿' : items.length + ' 轮';
    meta.textContent = [generationLabels[kind], summary, formatGenerationDate(latest([id, items]))].join(' · ');
    body.append(title, meta);
    button.append(icon, body);
    button.setAttribute('aria-current', String(activeThread() === id));
    button.onclick = () => { setGenerationTab(kind, id); generationPromptElement().focus(); };
    list.append(button);
  }
}

function updateDraftEntry() {
  const draft = creationDrafts.get(activeThread());
  const button = $('generationHistory').querySelector('[aria-current="true"]');
  if (!button || button.dataset.thread !== activeThread() || !draft.text.trim()) {
    renderGenerationHistory();
    return;
  }
  if (button.dataset.rounds === '0') {
    button.querySelector('strong').textContent = button.title = draft.text;
  }
  button.querySelector('small').textContent = [generationLabels[generationKind], '草稿', formatGenerationDate(draft.updatedAt)].join(' · ');
  if (button.previousElementSibling) $('generationHistory').prepend(button);
}

function setGenerationTab(kind, threadId = activeThreads[kind]) {
  if (generationPromptElement() && generationPromptElement().dataset.ready) saveCreationDraft();
  generationKind = kind;
  activeThreads[kind] = threadId;
  const turns = currentTurns();
  const draft = creationDrafts.get(threadId);
  const fields = draft?.fields || turns.at(-1)?.fields;
  if (fields) restoreFields({ kind, fields });
  for (const [name, [tab, panel]] of Object.entries(generationTabs)) {
    $(tab).setAttribute('aria-selected', String(name === kind));
    $(tab).tabIndex = name === kind ? 0 : -1;
    $(panel).hidden = name !== kind;
  }
  const prompt = generationPromptElement();
  if (prompt && prompt.id !== `generation${generationCapitalized(kind)}Prompt`) {
    prompt.id = `generation${generationCapitalized(kind)}Prompt`;
  }
  $('generationPromptFieldLabel').htmlFor = prompt.id;
  prompt.dataset.ready = 'true';
  prompt.value = draft?.text || '';
  $('generationPromptLabel').textContent = generationPromptLabels[kind];
  $('generationPromptCount').textContent = `${prompt?.value.length || 0} / 8,000`;
  $('generationTypeLabel').textContent = generationLabels[kind];
  $('generationStatus').textContent = runningCreation?.item.threadId === threadId ? runningCreation.status || '正在生成…' : '';
  prompt.placeholder = generationPlaceholders[kind];
  $('generationFocus').setAttribute('aria-label', `专注${generationLabels[kind]}画布`);
  $('generationPromptEnhance').hidden = kind === 'audio';
  updateGenerationComposer();
  renderGenerationResult();
  renderGenerationPresets();
  renderGenerationHistory();
}

function renderGenerationPresets() {
  const menu = $('generationPresetMenu');
  menu.replaceChildren();
  for (const [name, text] of generationPresets[generationKind]) {
    const button = document.createElement('button');
    button.type = 'button';
    const title = document.createElement('strong');
    title.textContent = name;
    const description = document.createElement('small');
    description.textContent = text;
    button.append(title, description);
    button.onclick = () => {
      const prompt = generationPromptElement();
      prompt.value = (prompt.value.trim() ? `${prompt.value.trim()}\n\n${text}` : text).slice(0, 8000);
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      menu.hidePopover();
      prompt.focus();
    };
    menu.append(button);
  }
}

function fillGenerationModels(rows) {
  for (const kind of Object.keys(generationTabs)) {
    const select = $(`generation${generationCapitalized(kind)}Model`);
    const draftModel = creationDrafts.get(activeThreads[kind])?.fields?.[select.id];
    const preferred = select.value || draftModel || current?.providerId || $('modelSelect').value;
    select.replaceChildren(...rows.map(row => new Option(`${row.name} · ${row.model}`, row.id)));
    if (isLocalVoice(kind,localVoiceId)) select.append(new Option('Mac 系统语音 · 本机',localVoiceId));
    if (!select.options.length) select.append(new Option('还没有模型配置', ''));
    if ([...select.options].some(option => option.value === preferred)) select.value = preferred;
  }
}

function renderGenerationResult() {
  const output = $('generationOutput');
  const turns = currentTurns();
  const latest = turns.at(-1);
  const completed = turns.findLast(isCompleted);
  const same = output.dataset.thread === activeThread();
  const follow = !same || output.scrollHeight - output.clientHeight - output.scrollTop < 90;
  output.dataset.thread = activeThread();
  $('generationStageTitle').textContent = turns[0]?.prompt || { image: '图像工作室', video: '视频工作室', audio: '语音工作室' }[generationKind];
  $('generationStageMeta').textContent = latest ? formatGenerationDate(latest.createdAt) : '';
  $('generationDuplicate').hidden = !latest;
  $('generationDuplicate').disabled = !latest;
  $('saveGeneration').hidden = !completed;
  $('saveGeneration').disabled = !completed;
  $('generationResultInfo').textContent = latest ? `共 ${turns.length} 轮` : '';
  output.classList.toggle('creation-thread', Boolean(latest));
  if (!same || !latest) {
    previewObserver.disconnect();
    output.replaceChildren();
  }
  if (!latest) {
    const empty = document.createElement('div');
    empty.className = 'generation-empty';
    const orbit = document.createElement('span');
    orbit.className = 'generation-empty-orbit';
    orbit.append(workspaceIcon(generationHistoryIcon(generationKind)));
    const title = document.createElement('strong');
    title.textContent = { image: '想画一幅什么画面？', video: '镜头从哪里开始？', audio: '想让这段文字如何发声？' }[generationKind];
    const hint = document.createElement('span');
    hint.textContent = { image: '写下主体、光线和构图，也可以从模板开始。', video: '描述第一个镜头、主体动作和场景变化。', audio: '输入台词，选好音色后即可试听。' }[generationKind];
    empty.append(orbit, title, hint);
    output.append(empty);
    return;
  }
  output.querySelector('.generation-empty')?.remove();
  for (const item of turns) {
    let article = document.getElementById('creation-' + item.id);
    if (!article) {
      article = document.createElement('article');
      article.id = 'creation-' + item.id;
      article.className = 'creation-turn';
      output.append(article);
    }
    if (article.dataset.state === (item.state || 'done')) continue;
    article.dataset.state = item.state || 'done';
    const prompt = document.createElement('p');
    prompt.className = 'creation-question';
    prompt.textContent = item.prompt;
    const preview = document.createElement('div');
    preview.className = 'creation-preview';
    const buttons = document.createElement('div');
    buttons.className = 'creation-actions';
    article.replaceChildren(prompt, preview, buttons);
    if (isCompleted(item)) {
      preview.textContent = '正在载入作品…';
      previewObserver.observe(preview);
      preview.dataset.id = item.id;
      buttons.append(messageButton('download', '导出这轮作品', () => exportCreation(item)));
    } else {
      preview.textContent = item.status || (item.state === 'running' ? '正在生成…' : '等待生成…');
    }
    if (!['queued', 'running'].includes(item.state)) {
      if (item.receipt === 'accepted') {
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.textContent = '继续查询原视频';
        resume.onclick = () => resumeVideo(item);
        buttons.append(resume);
      }
      buttons.append(messageButton('refresh', '重新生成这一轮', () => repeatCreation(item)),
        messageButton('edit', '编辑这轮提示词', () => editCreation(item)));
    }
  }
  if (follow) output.scrollTop = output.scrollHeight;
}

function creationImageIndices(assets) {
  return (assets || []).flatMap((asset, index) => asset?.mimeType?.startsWith('image/') && asset.data ? [index] : []);
}

function readAssets(id) {
  return unsavedAssets.get(id) || archiveOperation('readonly', (_, media) => media.get(id));
}

const previewObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const preview = entry.target;
    previewObserver.unobserve(preview);
    void loadPreview(preview);
  }
}, { root: $('generationOutput'), rootMargin: '300px' });

async function loadPreview(preview) {
  try {
    const assets = await readAssets(preview.dataset.id);
    if (!preview.isConnected) return;
    if (!assets?.length) { preview.textContent = '此历史记录仅保存了提示词。'; return; }
    preview.replaceChildren();
    preview.classList.toggle('creation-grid', assets.length > 1);
    renderAssets(preview, assets);
  } catch (error) { preview.textContent = errorMessage(error); }
}

function renderAssets(output, assets) {
  for (const [index, asset] of assets.entries()) {
    const source = `data:${asset.mimeType};base64,${asset.data}`;
    let element;
    if (asset.mimeType.startsWith('image/')) {
      element = document.createElement('img');
      element.className = 'generation-result';
      element.alt = `生成的图片 ${index + 1}`;
      element.src = source;
      const thumbnail = document.createElement('button');
      thumbnail.type = 'button';
      thumbnail.className = 'creation-thumbnail';
      thumbnail.dataset.assetIndex = index;
      thumbnail.setAttribute('aria-label', `查看第 ${index + 1} 张大图`);
      thumbnail.title = '查看大图';
      thumbnail.append(element);
      thumbnail.onclick = () => openCreationGallery(output, thumbnail);
      output.append(thumbnail);
      continue;
    } else if (asset.mimeType.startsWith('video/')) {
      element = document.createElement('video');
      element.className = 'generation-result generation-result-video';
      element.controls = true;
      element.preload = 'metadata';
    } else {
      element = document.createElement('audio');
      element.className = 'generation-result-audio';
      element.controls = true;
      element.preload = 'metadata';
    }
    element.src = source;
    output.append(element);
  }
}

function updateGenerationComposer() {
  const prompt = generationPromptElement();
  const hasModel = Boolean(generationModelId());
  const local = isLocalVoice(generationKind,generationModelId());
  if (generationKind === 'audio') {
    $('localVoiceLabel').hidden = $('localVoiceFormat').hidden = !local;
    for (const id of ['generationAudioVoice','generationAudioFormat','generationAudioEndpoint','generationAudioOptions']) {
      $(id).closest('label, details').hidden = local;
    }
  }
  $('runGeneration').disabled = !historyLoaded || !hasModel || !prompt.value.trim();
  if (local && prompt.value.length > 3000) $('runGeneration').disabled = true;
  $('runGeneration').lastChild.textContent = generationRequestId ? ' 加入队列' : ' 开始生成';
  $('cancelGeneration').hidden = !runningCreation || creationThread(runningCreation.item) !== activeThread();
  const editing = creationDrafts.get(activeThread())?.editing;
  $('cancelCreationEdit').hidden = !editing;
  if (editing) $('runGeneration').lastChild.textContent = ' 生成新版本';
  const follow = generationKind !== 'audio' && currentTurns().length;
  prompt.placeholder = follow ? '继续描述要调整的地方…' : generationPlaceholders[generationKind];
  $('generationPromptLabel').textContent = editing ? '编辑这轮提示词' : follow ? '继续创作 · 沿用本会话的文字描述' : generationPromptLabels[generationKind];
  $('runGeneration').title = hasModel ? '开始生成 · ⌘ / Ctrl + Enter' : '请先在设置中添加模型配置';
  if (prompt) $('generationPromptCount').textContent = `${prompt.value.length} / ${local ? '3,000' : '8,000'}`;
}

async function refreshGenerationModels() {
  try {
    fillGenerationModels(await api.providers.list());
    updateGenerationComposer();
    if (!generationModelId()) $('generationStatus').textContent = '请先在设置中添加模型配置。';
  } catch (error) {
    $('generationStatus').textContent = error.message;
  }
}

function generationInput(kind, fields, prompt) {
  const value = key => fields['generation' + generationCapitalized(kind) + key] || '';
  const input = {
    kind,
    providerId: value('Model'),
    endpoint: value('Endpoint'),
    prompt
  };
  if (kind === 'image') {
    input.size = value('Size');
    input.quality = value('Quality');
    input.count = Number(value('Count')) || 1;
    input.style = value('Style');
    input.negativePrompt = value('Negative').trim();
    input.options = parseGenerationOptions(value('Options'));
  }
  if (kind === 'video') {
    input.duration = value('Duration');
    input.aspectRatio = value('Aspect');
    input.motion = value('Motion');
    input.audio = value('Audio');
    input.negativePrompt = value('Negative').trim();
    input.pollEndpoint = value('PollEndpoint');
    input.contentEndpoint = value('ContentEndpoint');
    input.options = parseGenerationOptions(value('Options'));
  }
  if (kind === 'audio') {
    if (isLocalVoice(kind,input.providerId)) {
      return {kind,providerId:input.providerId,prompt,voice:value('LocalVoice') || 'default',speed:Number(value('Speed')) || 1};
    }
    input.voice = value('Voice');
    input.format = value('Format');
    input.speed = Number(value('Speed')) || 1;
    input.options = parseGenerationOptions(value('Options'));
  }
  return input;
}

function parseGenerationOptions(text) {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('高级参数必须是 JSON 对象');
    return value;
  } catch (error) {
    throw Error(`高级参数格式错误：${error.message}`);
  }
}

function resetGenerationSettings() {
  for (const field of panelFields()) {
    if (field.id.endsWith('Model')) continue;
    if (field.tagName === 'SELECT') field.value = ([...field.options].find(option => option.defaultSelected) || field.options[0]).value;
    else field.value = field.defaultValue;
  }
  saveCreationDraft();
  $('generationStatus').textContent = '已恢复默认生成设置。';
}

function addPromptTemplate() {
  const prompt = generationPromptElement();
  const templates = {
    image: '一张具有高级质感的产品视觉，主体清晰，构图平衡，柔和自然光，细节丰富，干净背景，商业摄影风格',
    video: '电影感短片，主体自然运动，镜头缓慢推进，光线有层次，动作连贯，画面稳定，结尾留出呼吸感',
    audio: '请用自然、温和、清晰的语气朗读以下内容，适当加入停顿和情绪变化。'
  };
  prompt.value = (prompt.value.trim() ? `${prompt.value.trim()}\n\n${templates[generationKind]}` : templates[generationKind]).slice(0, 8000);
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  prompt.focus();
}

function enhanceGenerationPrompt() {
  const prompt = generationPromptElement();
  if (!prompt.value.trim()) {
    addPromptTemplate();
    return;
  }
  const suffix = generationKind === 'image'
    ? '主体关系清晰，材质细节丰富，光线方向明确，色彩层次自然，构图平衡。'
    : '动作连贯，镜头运动平稳，主体前后一致，节奏自然，画面稳定。';
  if (!prompt.value.includes(suffix)) prompt.value = `${prompt.value.trim()}\n\n${suffix}`.slice(0, 8000);
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  prompt.focus();
}

function newGeneration() {
  setGenerationTab(generationKind, crypto.randomUUID());
  generationPromptElement().focus();
}

function renderCreationQueue() {
  const list = $('generationQueue');
  list.replaceChildren();
  for (const job of [runningCreation, ...generationQueue].filter(Boolean)) {
    const row = document.createElement('div');
    row.className = 'generation-queued';
    const title = document.createElement('span');
    title.textContent = (job === runningCreation ? '生成中' : '等待中') + ' · ' + (job.input.prompt || job.item.prompt);
    title.title = title.textContent;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.onclick = () => {
      if (job === runningCreation) void cancelCreation(job);
      else {
        generationQueue.splice(generationQueue.indexOf(job), 1);
        void finishCreation(job.item, 'stopped', '已取消，可重新生成。');
      }
      renderCreationQueue();
    };
    row.append(title, cancel);
    list.append(row);
  }
  updateGenerationComposer();
}

api.generation.onEvent(event => {
  if (event.requestId !== generationRequestId) return;
  runningCreation.status = event.text;
  if (creationThread(runningCreation.item) === activeThread()) $('generationStatus').textContent = event.text;
});

$('openGenerationStudio').onclick = () => {
  $('generationStudio').hidden = false;
  void refreshGenerationModels();
  generationPromptElement().focus();
};
$('manageGenerationModels').onclick = () => { setTab('provider'); void openSettings(); };
$('settingsDialog').addEventListener('close', () => {
  if (!$('generationStudio').hidden) void refreshGenerationModels();
});
$('closeGenerationStudio').onclick = () => {
  $('generationStudio').hidden = true;
  $('generationOutput').querySelectorAll('video, audio').forEach(media => media.pause());
  $('openGenerationStudio').focus();
};
$('generationNew').onclick = newGeneration;
$('resetGenerationSettings').onclick = resetGenerationSettings;
$('generationPromptEnhance').onclick = enhanceGenerationPrompt;
$('generationFocus').onclick = () => {
  const focused = $('generationStudio').classList.toggle('generation-focus');
  $('generationFocus').setAttribute('aria-pressed', String(focused));
};
const inspectorDock = $('creationInspector').parentElement;
const settingsSheet = $('creationSettingsDialog');
$('openCreationSettings').onclick = () => {
  settingsSheet.prepend($('creationInspector'));
  settingsSheet.showModal();
  $(`generation${generationCapitalized()}Model`).focus();
};
settingsSheet.addEventListener('close', () => {
  inspectorDock.append($('creationInspector'));
  if ($('openCreationSettings').checkVisibility()) $('openCreationSettings').focus();
  else generationPromptElement().focus();
});
const compactCreation = matchMedia('(max-width: 1120px)');
compactCreation.addEventListener('change', () => {
  if (settingsSheet.open && !compactCreation.matches && !$('generationStudio').classList.contains('generation-focus')) settingsSheet.close();
});
$('clearGenerationHistory').onclick = async () => {
  if (runningCreation || generationQueue.length) { $('generationStatus').textContent = '请等待创作队列结束后再清空历史。'; return; }
  if (!generationHistory.length && ![...creationDrafts.values()].some(draft => draft.text || draft.editing)) return;
  if (!window.confirm('清空本机的创作记录、草稿和预览文件？')) return;
  try {
    await archiveOperation('readwrite', (records, media) => { records.clear(); media.clear(); });
    await api.generation.forget(generationHistory.filter(item => item.kind === 'video').map(item => item.id));
    generationHistory = [];
    for (const id of creationDrafts.keys()) localStorage.removeItem(draftPrefix + id);
    creationDrafts.clear();
    unsavedAssets.clear();
    for (const kind of Object.keys(generationTabs)) activeThreads[kind] = crypto.randomUUID();
    generationPromptElement().value = '';
    updateGenerationComposer();
    renderGenerationHistory();
    renderGenerationResult();
  } catch (error) { $('generationStatus').textContent = errorMessage(error); }
};
for (const [kind, [tab]] of Object.entries(generationTabs)) {
  $(tab).onclick = () => setGenerationTab(kind);
  $(tab).onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const kinds = Object.keys(generationTabs);
    const currentIndex = kinds.indexOf(kind);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? kinds.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : kinds.length - 1)) % kinds.length;
    const nextKind = kinds[index];
    setGenerationTab(nextKind);
    $(generationTabs[nextKind][0]).focus();
  };
}
function captureFields() {
  return Object.fromEntries(panelFields().map(field => [field.id, field.value]));
}

function editCreation(item) {
  saveCreationDraft();
  const draft = creationDrafts.get(activeThread());
  if (!draft.editing) draft.previous = { text: draft.text, fields: draft.fields };
  draft.editing = { id: item.id, parentId: item.parentId };
  restoreFields(item);
  generationPromptElement().value = item.prompt;
  saveCreationDraft();
  updateGenerationComposer();
  generationPromptElement().focus();
}

function endCreationEdit() {
  const draft = creationDrafts.get(activeThread());
  if (!draft?.editing) return;
  restoreFields({ kind: generationKind, fields: draft.previous.fields });
  generationPromptElement().value = draft.previous.text;
  delete draft.editing;
  delete draft.previous;
  saveCreationDraft();
  updateGenerationComposer();
}
$('cancelCreationEdit').onclick = endCreationEdit;

function enqueueCreation(prompt, fields, parentId) {
  let input;
  try { input = generationInput(generationKind, fields, prompt.trim()); }
  catch (error) { $('generationStatus').textContent = errorMessage(error); return false; }
  if (!historyLoaded) return false;
  if (!isLocalVoice(input.kind,input.providerId) && !providers.some(provider => provider.id === input.providerId)) {
    $('generationStatus').textContent = '请选择可用的生成模型。';
    return false;
  }
  if (!input.prompt) return false;
  const item = { id: crypto.randomUUID(), threadId: activeThread(), parentId, kind: input.kind,
    prompt: input.prompt, fields, ...(input.kind === 'video' && { tracksSubmission: true }), state: 'queued',
    createdAt: Math.max(Date.now(), (generationHistory[0]?.createdAt || 0) + 1) };
  generationHistory.unshift(item);
  const recorded = archiveOperation('readwrite', records => records.put({ ...item, state: 'queued' }))
    .then(() => null, error => error);
  generationQueue.push({ input, item, recorded });

  renderGenerationHistory();
  renderGenerationResult();
  $('generationOutput').scrollTop = $('generationOutput').scrollHeight;
  renderCreationQueue();
  void processCreationQueue();
  return true;
}

function videoRecoveryText(item) {
  return item.receipt === 'accepted' ? '已保留远程任务号，可继续查询原视频。' : '提交结果未知，服务可能已计费，请先核对服务商记录。';
}
function resumeVideo(item) {
  if (item.receipt !== 'accepted' || runningCreation || generationQueue.length) {
    $('generationStatus').textContent = '请在当前队列结束后查询原任务。';
    return;
  }
  generationQueue.push({ input: { kind: 'video', providerId: item.fields.generationVideoModel, resume: true }, item });
  void processCreationQueue();
}
function repeatCreation(item) {
  if (item.receipt && !window.confirm('重新生成将提交一个新视频任务，服务商可能再次收费。继续吗？')) return;
  enqueueCreation(item.prompt, item.fields || captureFields(), item.parentId || null);
}

$('generationComposer').onsubmit = event => {
  event.preventDefault();
  const draft = creationDrafts.get(activeThread());
  const latest = currentTurns().at(-1);
  const parentId = draft?.editing ? draft.editing.parentId : latest?.id;
  if (enqueueCreation(generationPromptElement().value, captureFields(), parentId || null)) {
    if (draft?.editing) endCreationEdit();
    else {
      generationPromptElement().value = '';
      saveCreationDraft();
      updateGenerationComposer();
    }
    renderGenerationHistory();
    generationPromptElement().focus();
  }
};

// Follow the selected version's successful ancestors, including jobs that finished while queued.
function contextualPrompt(item) {
  if (item.kind === 'audio' || !item.parentId) return item.prompt;
  const rows = new Map(generationHistory.filter(row => creationThread(row) === item.threadId).map(row => [row.id, row]));
  const suffix = '\n\n本轮要求（优先）：\n' + item.prompt;
  const prefix = '此前的创作描述：\n';
  let available = 8000 - prefix.length - suffix.length;
  const history = [];
  for (let parent = rows.get(item.parentId); parent && available > 0; parent = rows.get(parent.parentId)) {
    rows.delete(parent.id);
    if (!isCompleted(parent)) continue;
    const text = parent.prompt.slice(0, available);
    history.unshift(text);
    available -= text.length + 2;
  }
  return history.length ? prefix + history.join('\n\n') + suffix : item.prompt;
}

async function finishCreation(item, state, status, result) {
  const assets = result && (result.assets || [result]);
  const completed = { ...item, state, status };
  if (item.kind === 'image' && assets) completed.imageIndices = creationImageIndices(assets);
  try {
    await archiveOperation('readwrite', (records, media) => {
      records.put(completed);
      if (assets) media.put(assets, item.id);
    });
  } catch (error) {
    if (assets) unsavedAssets.set(item.id, assets);
    completed.status += ' 历史保存失败：' + errorMessage(error);
  }
  Object.assign(item, completed);
  if (activeThread() === creationThread(item)) {
    $('generationStatus').textContent = item.status;
    renderGenerationResult();
  }
}

async function processCreationQueue() {
  if (runningCreation || !generationQueue.length) return;
  const job = runningCreation = generationQueue.shift();
  const { input, item } = job;
  generationRequestId = item.id;
  item.state = 'running';
  if (activeThread() === item.threadId) renderGenerationResult();
  renderCreationQueue();
  try {
    const recordingError = await job.recorded;
    if (recordingError) throw recordingError;
    await archiveOperation('readwrite', records => records.put(item));
    if (job.cancelled) throw Error('已停止本机等待');
    const result = await api.generation.run({ ...input, prompt: contextualPrompt(item), requestId: item.id });
    if (job.cancelled) throw Error('已停止本机等待');
    delete item.receipt;
    await finishCreation(item, 'done', '生成完成，可以播放或保存文件。', result);
    if (item.kind === 'video' && !unsavedAssets.has(item.id)) await api.generation.forget([item.id]).catch(() => {});
  } catch (error) {
    let note = job.cancelled ? '已停止本机等待。' : errorMessage(error);
    if (item.kind === 'video') {
      const receipt = (await api.generation.receipts().catch(() => ({})))[item.id];
      if (receipt) { item.receipt = receipt; note += ' ' + videoRecoveryText(item); }
    }
    await finishCreation(item, job.cancelled ? 'stopped' : 'failed', note);
  } finally {
    runningCreation = null;
    generationRequestId = '';
    renderCreationQueue();
    void processCreationQueue();
  }
}

async function cancelCreation(job) {
  if (!job || job.cancelled) return;
  job.cancelled = true;
  try { await api.generation.cancel(job.item.id); }
  catch (error) { $('generationStatus').textContent = errorMessage(error); }
}
$('cancelGeneration').onclick = () => cancelCreation(runningCreation);

async function exportCreation(item) {
  if (!item) return;
  try {
    const assets = await readAssets(item.id);
    if (!assets?.length) throw Error('此记录没有可导出的作品。');
    if (assets.length > 1) {
      const directory = await api.generation.saveAll({ kind: item.kind, assets });
      if (directory) $('generationStatus').textContent = `已导出 ${assets.length} 张图片 · ${directory}`;
    } else if (await api.generation.save({ ...assets[0], kind: item.kind })) $('generationStatus').textContent = '作品已导出。';
  } catch (error) { $('generationStatus').textContent = errorMessage(error); }
}
$('saveGeneration').onclick = () => exportCreation(currentTurns().findLast(isCompleted));

$('generationDuplicate').onclick = () => {
  const item = currentTurns().at(-1);
  if (!item) return;
  newGeneration();
  restoreFields(item);
  generationPromptElement().value = item.prompt;
  saveCreationDraft();
  updateGenerationComposer();
  generationPromptElement().focus();
};

document.addEventListener('input', event => {
  if (event.target === generationPromptElement()) {
    saveCreationDraft();
    updateDraftEntry();
    updateGenerationComposer();
  } else if ($('creationInspector').contains(event.target)) {
    saveCreationDraft();
    updateGenerationComposer();
  }
});
document.addEventListener('keydown', event => {
  if ($('generationStudio').hidden || document.querySelector('dialog[open], :popover-open') || event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    newGeneration();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    $('generationComposer').requestSubmit();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (creationDrafts.get(activeThread())?.editing) endCreationEdit();
    else if (!$('cancelGeneration').hidden) $('cancelGeneration').click();
    else $('closeGenerationStudio').click();
  }
});

$('generationKeyHint').textContent = mac ? '⌘ ↵' : 'Ctrl ↵';
setGenerationTab('image');
