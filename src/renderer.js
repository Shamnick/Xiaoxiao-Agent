'use strict';
const $ = id => document.getElementById(id);
const api = window.nova;
let providers = [], conversations = [], current = null, attachment = null;
let busy = false, locked = false, settingsBusy = false, editing = null, settingsLoaded = false;
let activeRequest = null, streamContent = null, activities = 0, composing = false;
const form = $('providerForm');
const errorMessage = error => error?.message || String(error);
const plain = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
function showError(error) { $('errorText').textContent = errorMessage(error); $('errorBanner').hidden = false; }
function status(text, error = false) { $('settingsStatus').textContent = text; $('settingsStatus').classList.toggle('error', error); }
function selectedProvider() { return providers.find(p => p.id === $('modelSelect').value); }
function update() {
  const disabled = busy || locked;
  $('send').disabled = disabled || !$('modelSelect').value || !$('prompt').value.trim();
  $('stop').hidden = !busy;
  for (const id of ['newChat','modelSelect','attach','clearAttachment','agent','workspace','saveContext','systemPrompt']) $(id).disabled = disabled;
  for (const id of ['renameConversation','deleteConversation','exportConversation']) $(id).disabled = disabled || !current;
  $('navSettings').disabled = $('settings').disabled = disabled;
  $('chat').setAttribute('aria-busy', String(busy));
  $('runBadge').textContent = busy ? '正在协作' : locked ? '正在保存' : '准备就绪';
  $('attachmentLabel').hidden = !attachment;
  $('attachmentText').textContent = attachment ? '▤ ' + attachment.name : '';
  $('composerHint').textContent = providers.length ? 'Enter 发送 · Shift + Enter 换行' : '先在「模型设置」中添加一个模型';
  document.querySelectorAll('#history button').forEach(button => { button.disabled = disabled; });
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = disabled; });
}
async function action(fn) {
  if (busy || locked) return;
  locked = true; update();
  try { return await fn(); } catch (error) { showError(error); }
  finally { locked = false; update(); }
}
function scrollBottom() { const box = $('scrollArea'); box.scrollTop = box.scrollHeight; }
function appendMessage(turn) {
  const article = document.createElement('article');
  const role = ['user','assistant','system','tool'].includes(turn.role) ? turn.role : 'system';
  article.className = 'message ' + role;
  const label = document.createElement('div'); label.className = 'message-label';
  label.textContent = ({user:'你',assistant:'Xiaoxiao',system:'系统',tool:'工具'})[role];
  const body = document.createElement('div'); body.className = 'message-content'; body.textContent = plain(turn.content);
  if (role === 'assistant' && window.marked && window.DOMPurify) {
    body.classList.add('markdown');
    body.innerHTML = DOMPurify.sanitize(marked.parse(plain(turn.content)), {
      ALLOWED_TAGS:['p','br','strong','em','del','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','pre','code','table','thead','tbody','tr','th','td','hr','a'],
      ALLOWED_ATTR:['href','title'], ALLOW_DATA_ATTR:false
    });
    for (const link of body.querySelectorAll('a')) link.removeAttribute('href');
  }
  article.append(label, body);
  if (turn.attachment) {
    const note = document.createElement('p'); note.className = 'muted message-content';
    note.textContent = '附件：' + (turn.attachment.name || plain(turn.attachment)); article.append(note);
  }
  if (turn.failed || turn.error) {
    const note = document.createElement('p'); note.className = 'message-content muted';
    note.textContent = '未完成 / 已停止' + (turn.error ? ' · ' + plain(turn.error) : ''); article.append(note);
  }
  $('chat').append(article); return body;
}
function renderHistory() {
  $('history').replaceChildren(); $('historyCount').textContent = String(conversations.length);
  if (!conversations.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '还没有对话。\n从一个新想法开始吧。'; $('history').append(p); }
  for (const item of [...conversations].sort((a,b) => (Number(b.updatedAt) || Date.parse(b.updatedAt) || 0) - (Number(a.updatedAt) || Date.parse(a.updatedAt) || 0))) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = item.id === current?.id ? 'active' : ''; button.setAttribute('aria-current', item.id === current?.id ? 'page' : 'false');
    button.textContent = item.title || '未命名对话'; button.title = item.title || '未命名对话';
    const small = document.createElement('small'); const date = new Date(item.updatedAt);
    small.textContent = Number.isNaN(date.getTime()) ? '已保存的对话' : date.toLocaleDateString('zh-CN', {month:'short',day:'numeric'});
    if (item.messages?.some(m => m.failed || m.error)) small.textContent += ' · 有未完成消息';
    button.append(small); button.onclick = () => action(async () => { await clearAttachment(); current = item; resetActivity(); renderCurrent(); });
    $('history').append(button);
  }
  update();
}
function resetActivity() { $('activityLog').replaceChildren(); $('activityPanel').hidden = true; activities = 0; $('activityCount').textContent = '0'; }
function renderCurrent() {
  $('conversationTitle').textContent = current?.title || '新对话';
  $('conversationMeta').textContent = current ? `${current.messages?.length || 0} 条消息 · 自动保存在本机` : '让想法，从这里开始。';
  $('chat').replaceChildren();
  const messages = current?.messages || []; $('hero').hidden = messages.length > 0;
  for (const turn of messages) appendMessage(turn);
  $('agent').checked = current ? current.agent === true : true;
  $('systemPrompt').value = current?.systemPrompt || '';
  const workspace = current?.workspace;
  $('workspace').textContent = workspace ? '▱ ' + workspace : '▱ 选择工作目录'; $('workspace').title = workspace || '选择此对话的工作目录';
  if (current) $('modelSelect').value = current.providerId || '';
  renderHistory(); scrollBottom();
}
function upsert(conversation) {
  if (!conversation?.id) throw new Error('后端未返回有效的对话');
  const index = conversations.findIndex(c => c.id === conversation.id);
  if (index < 0) conversations.push(conversation); else conversations[index] = conversation;
  current = conversation; return conversation;
}
async function reloadConversations(id = current?.id) {
  conversations = await api.conversations.list(); current = conversations.find(c => c.id === id) || null;
  renderCurrent();
}
async function ensureConversation() {
  if (!current) {
    if (!$('modelSelect').value) throw new Error('请先添加并选择模型配置');
    const agent = $('agent').checked, systemPrompt = $('systemPrompt').value;
    upsert(await api.conversations.create({providerId:$('modelSelect').value}));
    upsert(await api.conversations.save({id:current.id, agent, systemPrompt}));
    renderHistory();
  }
  return current;
}
async function clearAttachment() { if (attachment) await api.attachment.clear(); attachment = null; update(); }
function fillProviders(preferred = current?.providerId || $('modelSelect').value) {
  $('modelSelect').replaceChildren(...providers.map(p => new Option(p.name + ' · ' + p.model, p.id)));
  if (!providers.length) $('modelSelect').append(new Option('请先配置模型', ''));
  if (preferred && !providers.some(p => p.id === preferred)) $('modelSelect').append(new Option('原模型已删除 · 请选择模型', ''));
  if (preferred) $('modelSelect').value = providers.some(p => p.id === preferred) ? preferred : '';
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
  for (const provider of providers) {
    const button = document.createElement('button'); button.type='button'; button.className='provider-choice' + (editing === provider.id ? ' active' : '');
    button.textContent=provider.name; const small=document.createElement('small'); small.textContent=provider.model; button.append(small);
    button.disabled=settingsBusy; button.onclick=()=>{ resetProvider(provider); status(''); }; $('providerList').append(button);
  }
}
async function settingsAction(fn) {
  if(settingsBusy) return;
  settingsBusy=true; $('providerFields').disabled=true; $('mcpFields').disabled=true; $('addProvider').disabled=true; renderProviders();
  try { await fn(); } catch(error) { status(errorMessage(error),true); }
  finally { settingsBusy=false; $('providerFields').disabled=false; $('mcpFields').disabled=!settingsLoaded; $('addProvider').disabled=false; renderProviders(); for(const id of ['testProvider','fetchModels','deleteProvider']) $(id).disabled=!editing; }
}
async function openSettings() {
  if(busy || locked) return;
  if(!$('settingsDialog').open) $('settingsDialog').showModal();
  await settingsAction(async()=>{
    status('正在加载设置…'); await refreshProviders(); resetProvider(providers[0]);
    settingsLoaded=false; const settings=await api.settings.get();
    $('mcpServers').value=JSON.stringify(settings.mcpServers || [],null,2); $('maxSteps').value=settings.maxSteps ?? 12; settingsLoaded=true; status('');
  });
}
$('settings').onclick=$('navSettings').onclick=openSettings;
$('closeSettings').onclick=()=>$('settingsDialog').close();
function setTab(id) {
  for(const name of ['provider','mcp']) { const active=name===id; $(name+'Panel').hidden=!active; $(name+'Tab').setAttribute('aria-selected',String(active)); $(name+'Tab').tabIndex=active?0:-1; }
}
for(const name of ['provider','mcp']) { $(name+'Tab').onclick=()=>setTab(name); $(name+'Tab').onkeydown=event=>{ if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault(); const target=event.key==='Home'?'provider':event.key==='End'?'mcp':name==='provider'?'mcp':'provider';setTab(target);$(target+'Tab').focus();} }; }
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
$('newChat').onclick=()=>action(async()=>{ await clearAttachment(); current=null; resetActivity(); $('prompt').value=''; renderCurrent(); $('prompt').focus(); });
$('brandHome').onclick=event=>{event.preventDefault();$('newChat').click();};
$('modelSelect').onchange=()=>action(async()=>{if(current){upsert(await api.conversations.save({id:current.id,providerId:$('modelSelect').value}));renderHistory();}});
$('agent').onchange=()=>action(async()=>{if(current)upsert(await api.conversations.save({id:current.id,agent:$('agent').checked}));});
$('workspace').onclick=()=>action(async()=>{await ensureConversation();const conversation=await api.workspace.pick(current.id);if(conversation)upsert(conversation);renderCurrent();});
$('toggleSystem').onclick=()=>{const open=$('systemPanel').hidden;$('systemPanel').hidden=!open;$('toggleSystem').setAttribute('aria-expanded',String(open));if(open)$('systemPrompt').focus();};
$('saveContext').onclick=()=>action(async()=>{await ensureConversation();upsert(await api.conversations.save({id:current.id,systemPrompt:$('systemPrompt').value,agent:$('agent').checked}));$('contextStatus').textContent='已保存';});
$('systemPrompt').oninput=()=>{$('contextStatus').textContent='未保存';};
$('renameConversation').onclick=()=>{if(!current)return;$('renameInput').value=current.title||'';$('renameDialog').showModal();$('renameInput').select();};
$('cancelRename').onclick=()=>$('renameDialog').close();
$('renameForm').onsubmit=event=>{event.preventDefault();const title=$('renameInput').value.trim();if(!title)return;action(async()=>{upsert(await api.conversations.save({id:current.id,title}));$('renameDialog').close();renderCurrent();});};
$('deleteConversation').onclick=()=>action(async()=>{await api.conversations.delete(current.id);await clearAttachment();current=null;resetActivity();await reloadConversations(null);});
$('exportConversation').onclick=()=>action(()=>api.conversations.export(current.id));
$('attach').onclick=()=>action(async()=>{const picked=await api.attachment.pick();if(picked)attachment=picked;});
$('clearAttachment').onclick=()=>action(clearAttachment);
for(const button of document.querySelectorAll('[data-prompt]')) button.onclick=()=>{ $('prompt').value=button.dataset.prompt;update();$('prompt').focus(); };
$('prompt').oninput=update;
$('prompt').oncompositionstart=()=>{composing=true;}; $('prompt').oncompositionend=()=>{composing=false;};
$('prompt').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing&&event.keyCode!==229){event.preventDefault();$('composer').requestSubmit();}};
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='n'&&!$('settingsDialog').open&&!$('renameDialog').open){event.preventDefault();$('newChat').click();}});
$('stop').onclick=async()=>{if(!busy)return;$('stop').disabled=true;$('runBadge').textContent='正在停止';try{await api.chat.stop();}catch(error){showError(error);$('stop').disabled=false;}};
const unsubscribe=api.chat.onEvent(event=>{
  if(!busy || !activeRequest || event?.requestId!==activeRequest) return;
  if(event.type==='text' && typeof event.text==='string') {streamContent.textContent+=event.text;streamContent.parentElement.classList.remove('pending');}
  else if(event.type==='tool'||event.type==='status') {
    const item=document.createElement('p'); item.textContent=event.type==='tool'?[event.name,event.phase,plain(event.detail),event.text].filter(Boolean).join(' · '):plain(event.text || event.detail);
    $('activityLog').append(item);$('activityCount').textContent=String(++activities);$('activityPanel').hidden=false;
    if(event.type==='status'&&event.text)$('runBadge').textContent=event.text;
  }
  scrollBottom();
});
window.addEventListener('beforeunload',()=>unsubscribe());
$('composer').onsubmit=async event=>{
  event.preventDefault();const text=$('prompt').value.trim();if(busy||locked||!text||!$('modelSelect').value)return;
  busy=true;activeRequest=crypto.randomUUID();const requestId=activeRequest;const attached=attachment;let conversationId=current?.id, sent=false;
  $('errorBanner').hidden=true;resetActivity();update();
  try {
    await ensureConversation();conversationId=current.id;
    upsert(await api.conversations.save({id:current.id,providerId:$('modelSelect').value,systemPrompt:$('systemPrompt').value,agent:$('agent').checked}));
    $('hero').hidden=true;appendMessage({role:'user',content:text,attachment:attached});streamContent=appendMessage({role:'assistant',content:''});streamContent.classList.remove('markdown');streamContent.parentElement.classList.add('pending');
    $('prompt').value='';attachment=null;update();scrollBottom();sent=true;
    const result=await api.chat.send({conversationId,text,attachmentId:attached?.id,requestId});
    if(result.conversation)upsert(result.conversation);else if(typeof result.text==='string')streamContent.textContent=result.text;
  }catch(error){showError(error);if(sent && !$('prompt').value)$('prompt').value=text;}
  finally {
    activeRequest=null;streamContent=null;
    try {await reloadConversations(conversationId);}catch(error){showError('历史记录刷新失败：'+errorMessage(error));}
    busy=false;$('stop').disabled=false;update();$('prompt').focus();
  }
};
async function initialize() {
  locked=true;update();
  const results=await Promise.allSettled([
    api.brand().then(({name,icon})=>{if(name){document.title=name;$('brandName').textContent=name;$('heroBrand').textContent=name;}if(icon){for(const img of document.querySelectorAll('.logo,.hero-logo'))img.src=icon;}}),
    refreshProviders(),
    reloadConversations(null)
  ]);
  for(const result of results)if(result.status==='rejected')showError(result.reason);
  locked=false;update();$('prompt').focus();
}
initialize();
