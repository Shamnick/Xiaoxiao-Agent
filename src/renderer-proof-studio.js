'use strict';

(() => {
  const el = id => document.getElementById(id);
  const dialog = el('proofStudio');
  const briefs = {
    launch: { edition: '新品发布', original: '让灵感成形。', casual: '有个想法？一起试试。', short: '让想法成形。', art: 'silk-knot.png', alt: '层叠的彩色丝结' },
    invite: { edition: '体验邀请', original: '开启你的创作之旅。', casual: '来做点自己的东西吧。', short: '一起开工。', art: 'proof-workspace.png', alt: 'Xiaoxiao 桌面工作区示例截图' }
  };
  const sessions = new Map();
  const names = { title: '海报标题', voice: '旁白稿' };
  const nodes = { title: el('proofTitleObject'), voice: el('proofVoiceObject') };
  let opener;
  let session;
  let draft;
  let target;
  let awaitingTarget = false;
  let dictationTurn = 0;

  function status(text = '') { el('proofStatus').textContent = text; }
  function focusAction(id) { el(id).focus({ preventScroll: true }); }
  function show() {
    const { title, voice } = session.current;
    for (const [key, node] of Object.entries(nodes)) {
      node.textContent = session.current[key];
      node.setAttribute('aria-pressed', String(key === target));
      node.setAttribute('aria-label', names[key] + '，' + session.current[key]);
    }
    el('proofTarget').textContent = target ? '修改' + names[target] : '想改哪里？';
    el('proofHelp').textContent = target ? '只修改选中的对象，可先比较再采纳。' : '点选海报标题或旁白稿，再写下修改要求。';
    el('proofCompare').hidden = !draft;
    el('proofForm').hidden = Boolean(draft);
    el('proofSync').hidden = Boolean(draft) || target !== 'title' || title === voice;
    el('proofUndo').hidden = Boolean(draft) || !session.history.length;
    if (draft) {
      el('proofBefore').textContent = session.current[draft.target];
      el('proofAfter').textContent = draft.text;
      el('proofTarget').textContent = '比较' + names[draft.target];
      el('proofHelp').textContent = '采纳后写入这份演示作品。';
    }
  }

  function chooseBrief() {
    const id = el('proofBrief').value;
    const brief = briefs[id];
    if (!sessions.has(id)) {
      sessions.set(id, { brief, current: { title: brief.original, voice: brief.original }, history: [] });
    }
    session = sessions.get(id);
    ++dictationTurn;
    draft = null;
    target = null;
    awaitingTarget = false;
    el('proofEdition').textContent = brief.edition;
    el('proofPoster').dataset.brief = id;
    const art = dialog.querySelector('.proof-art');
    art.src = brief.art;
    art.alt = brief.alt;
    el('proofPrompt').value = '';
    status();
    show();
  }

  function preview() {
    const input = el('proofPrompt').value.trim();
    if (!input) {
      status('写下“口语一点”“短一点”，或用“改成：”输入自己的文案。');
      focusAction('proofPrompt');
      return;
    }
    if (!target) {
      awaitingTarget = true;
      status('“这里”是指海报标题还是旁白稿？请点选。');
      nodes.title.focus();
      return;
    }
    const literal = input.match(/^改成\s*[:：]\s*([\s\S]+)$/);
    let text;
    if (literal) text = literal[1].trim();
    else if (/口语|自然|随意/.test(input)) text = session.brief.casual;
    else if (/短|简洁|精简/.test(input)) text = session.brief.short;
    if (!text) {
      status('演示支持“口语一点”“短一点”，也可以用“改成：”指定新文案。');
      focusAction('proofPrompt');
      return;
    }
    if (text === session.current[target]) {
      status('这句话已经是当前版本，可以再换一种写法。');
      focusAction('proofPrompt');
      return;
    }
    draft = { target, text };
    status('');
    show();
    focusAction('proofAccept');
  }

  function undo() {
    if (draft || !session.history.length) return;
    session.current = session.history.pop();
    status('已撤销上一步。');
    show();
    nodes[target || 'title'].focus();
  }

  for (const [key, node] of Object.entries(nodes)) {
    node.onclick = () => {
      const pending = awaitingTarget;
      awaitingTarget = false;
      ++dictationTurn;
      target = key;
      draft = null;
      status();
      show();
      if (pending) preview();
      else focusAction('proofPrompt');
    };
  }
  for (const id of ['openProofFromKnot', 'openProofFromRail']) {
    el(id).onclick = () => {
      opener = el(id);
      chooseBrief();
      dialog.showModal();
      nodes.title.focus();
    };
  }
  el('proofClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { ++dictationTurn; opener?.focus(); });
  el('proofBrief').onchange = chooseBrief;
  el('proofForm').onsubmit = event => { event.preventDefault(); preview(); };
  el('proofPrompt').onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      preview();
    }
  };
  el('proofDictate').onclick = async () => {
    focusAction('proofPrompt');
    const turn = ++dictationTurn;
    if (window.nova.platform !== 'darwin') return status('可使用系统听写快捷键输入，再预览修改。');
    try {
      const result = await window.nova.presence.dictate();
      if (turn === dictationTurn) status(result === 'requested' ? '听写结束后请确认文字，再预览修改。' : '请使用系统听写快捷键，或直接键入修改要求。');
    } catch { if (turn === dictationTurn) status('系统听写暂时不可用，可以继续打字。'); }
  };
  el('proofAccept').onclick = () => {
    if (!draft) return;
    session.history.push(session.current);
    session.current = { ...session.current, [draft.target]: draft.text };
    const changed = draft.target;
    draft = null;
    el('proofPrompt').value = '';
    status('已采纳' + names[changed] + '。');
    show();
    nodes[changed].focus();
  };
  el('proofDiscard').onclick = () => {
    draft = null;
    show();
    status('已放弃提案。');
    focusAction('proofPrompt');
  };
  el('proofSync').onclick = () => {
    draft = { target: 'voice', text: session.current.title };
    show();
    focusAction('proofAccept');
  };
  el('proofUndo').onclick = undo;
  dialog.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' &&
      !event.isComposing && event.target !== el('proofPrompt') && !draft) {
      event.preventDefault();
      undo();
    }
  });
})();
