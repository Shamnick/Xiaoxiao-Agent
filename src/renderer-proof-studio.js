'use strict';

(() => {
  const el = id => document.getElementById(id);
  const dialog = el('proofStudio');
  const api = window.nova.proof;
  let scope = {};
  let generation = 0;
  let saving = false;
  let previewTurn;
  const names = { title: '海报标题', voice: '旁白稿', body: '海报正文' };
  const nodes = { title: el('proofTitleObject'), voice: el('proofVoiceObject'), body: el('proofBodyObject') };
  let opener;
  let session;
  let draft;
  let target;
  let instructions;
  function storeInstructions() {
    if (!session) return;
    instructions.selected = target;
    try { ProofInstructions.save(localStorage, scope, el('proofBrief').value, instructions); }
    catch { status('本机草稿保存失败，请在离开前复制修改要求。'); }
  }
  function rememberInput() {
    const field = target || 'unassigned';
    const value = el('proofPrompt').value;
    if (value.trim()) instructions.fields[field] = ConnectionIntent.mask(value);
    else delete instructions.fields[field];
    storeInstructions();
  }
  let awaitingTarget = false;
  let dictationTurn = 0;
  const delivery = el('proofDelivery');
  let sheet, savingPng = false, deliveryTurn = 0;

  function status(text = '') { el('proofStatus').textContent = text; }
  function focusAction(id) { el(id).focus({ preventScroll: true }); }
  function show() {
    const { title, voice } = session.current;
    el('proofVersion').textContent = (scope.conversationId ? '当前会话' : scope.projectId ? '当前项目' : '本机作品') + ' · ' + (session.number ? '已保存 v' + session.number : '初稿');

    for (const [key, node] of Object.entries(nodes)) {
      node.textContent = session.current[key];
      node.setAttribute('aria-pressed', String(key === target));
      node.setAttribute('aria-label', names[key] + '，' + session.current[key]);
    }
    el('proofTarget').textContent = target ? '修改' + names[target] : '想改哪里？';
    el('proofHelp').textContent = target ? '只修改选中的对象，可先比较再采纳。' : '点选标题、正文或旁白，再写下修改要求。';
    el('proofCompare').hidden = !draft;
    el('proofExport').disabled = Boolean(draft);
    el('proofForm').hidden = Boolean(draft);
    el('proofAudio').hidden = Boolean(draft) || target !== 'voice';
    el('proofSync').hidden = Boolean(draft) || target !== 'title' || title === voice;
    el('proofUndo').hidden = Boolean(draft) || !session.undoTo;
    if (draft) {
      el('proofBefore').textContent = session.current[draft.target];
      el('proofAfter').textContent = draft.text;
      el('proofTarget').textContent = '比较' + names[draft.target];
      el('proofHelp').textContent = '采纳后保存为新版本。';
    }
  }

  async function chooseBrief() {
    const token = ++generation;
    const id = el('proofBrief').value;
    cancelModelPreview();
    session = null;
    el('proofExport').disabled = true;
    el('proofVersion').textContent = '读取作品中…';
    dialog.querySelector('.proof-layout').inert = true;
    try {
      const loaded = await api.read({ ...scope, brief: id });
      if (token !== generation) return;
      session = loaded;
    } catch (error) { if (token === generation) el('proofVersion').textContent = errorMessage(error); return; }
    dialog.querySelector('.proof-layout').inert = false;
    const brief = session.brief;
    ++dictationTurn;
    draft = null;
    instructions = ProofInstructions.read(localStorage, scope, id);
    target = instructions.selected;
    awaitingTarget = false;
    el('proofEdition').textContent = brief.edition;
    el('proofPoster').dataset.brief = id;
    const art = dialog.querySelector('.proof-art');
    art.src = brief.art;
    art.alt = brief.alt;
    el('proofPrompt').value = instructions.fields[target || 'unassigned'] || '';
    status(el('proofPrompt').value ? '已恢复这份简报的修改要求。' : '');
    show();
    (nodes[target] || nodes.title).focus();
    return true;
  }

  async function preview() {
    const input = el('proofPrompt').value.trim();
    if (!session || saving || draft || previewTurn !== undefined) return;
    if (!input) {
      status('写下“口语一点”“短一点”，或用“改成：”输入自己的文案。');
      focusAction('proofPrompt');
      return;
    }
    if (!target) {
      awaitingTarget = true;
      status('请点选海报标题、正文或旁白稿。');
      nodes.title.focus();
      return;
    }
    const literal = input.match(/^改成\s*[:：]\s*([\s\S]+)$/);
    let text;
    if (el('proofModel').value) {
      const turn = ++generation;
      const submittedWithButton = document.activeElement === el('proofPreview');
      setPreviewTurn(turn);
      if (submittedWithButton) focusAction('proofStopPreview');
      status('正在为选中文案生成提案…');
      try {
        text = await api.preview({ ...scope, brief: el('proofBrief').value, base: session.id, target,
          instruction: input, providerId: el('proofModel').value });
        if (turn !== generation) return;
      } catch (error) {
        if (turn === generation) {
          const note = errorMessage(error);
          if (note.includes('作品版本已更新')) {
            if (await chooseBrief()) {
              status('已载入最新文案，修改要求已保留。可再次预览。');
              focusAction('proofPrompt');
            }
          } else {
            status(note);
            if (document.activeElement === el('proofStopPreview')) focusAction('proofPrompt');
          }
        }
        return;
      } finally { if (previewTurn === turn) setPreviewTurn(undefined); }
    } else if (literal) text = literal[1].trim();
    else if (target !== 'body' && /口语|自然|随意/.test(input)) text = session.brief.casual;
    else if (target !== 'body' && /短|简洁|精简/.test(input)) text = session.brief.short;
    if (!text) {
      status('本地改稿可用“改成：”指定文案。标题和旁白也支持“口语一点”和“短一点”。');
      focusAction('proofPrompt');
      return;
    }
    if (text === session.current[target]) {
      status('这句话已经是当前版本，可以再换一种写法。');
      focusAction('proofPrompt');
      return;
    }
    draft = { target, text, base: session.id, operation: 'edit' };
    status('');
    show();
    focusAction('proofAccept');
  }

  async function commit(input, message, focus) {
    if (saving || !session) return;
    saving = true;
    el('proofExport').disabled = true;
    el('proofBrief').disabled = el('proofClose').disabled = true;
    dialog.querySelector('.proof-layout').inert = true;
    status('正在保存…');
    try {
      session = await api.change({ ...scope, brief: el('proofBrief').value, ...input });
      draft = null;
      status(message);
      if (input.operation === 'edit') {
        el('proofPrompt').value = '';
        rememberInput();
      }
      show();
    } catch (error) {
      const note = errorMessage(error);
      if (note.includes('作品版本已更新')) {
        if (await chooseBrief()) status('已载入最新文案，修改要求已保留。可再次预览。');
      } else status(note);
    } finally {
      saving = false;
      el('proofExport').disabled = !session || Boolean(draft);
      el('proofBrief').disabled = el('proofClose').disabled = false;
      dialog.querySelector('.proof-layout').inert = !session;
      nodes[focus].focus();
    }
  }
  function undo() {
    if (draft || !session?.undoTo || saving) return;
    ++generation;
    cancelModelPreview();
    void commit({ operation: 'undo', base: session.id }, '已撤销上一步。', target || 'title');
  }
  function setPreviewTurn(turn) {
    previewTurn = turn;
    const busy = turn !== undefined;
    el('proofForm').setAttribute('aria-busy', String(busy));
    el('proofPreview').disabled = busy;
    el('proofStopPreview').hidden = !busy;
    el('proofDictate').hidden = busy;
    el('proofExport').disabled = busy || !session || saving || Boolean(draft);
  }
  function cancelModelPreview() {
    if (previewTurn === undefined) return;
    setPreviewTurn(undefined);
    void api.cancel().catch(() => {});
  }
  function invalidatePreview() {
    if (!session || saving) return;
    ++generation;
    cancelModelPreview();
    status();
  }
  el('proofStopPreview').onclick = () => {
    if (previewTurn === undefined) return;
    invalidatePreview();
    status('已停止本次预览，修改要求已保留。');
    focusAction('proofPrompt');
  };
  el('proofPrompt').oninput = () => {
    invalidatePreview();
    if (session && !saving) rememberInput();
  };
  el('proofModel').onchange = invalidatePreview;

  for (const [key, node] of Object.entries(nodes)) {
    node.onclick = () => {
      invalidatePreview();
      const pending = awaitingTarget;
      awaitingTarget = false;
      ++dictationTurn;
      if (!target && instructions.fields.unassigned) {
        instructions.fields[key] = instructions.fields.unassigned;
        delete instructions.fields.unassigned;
      }
      target = key;
      el('proofPrompt').value = instructions.fields[key] || '';
      draft = null;
      status();
      storeInstructions();
      show();
      if (pending) preview();
      else focusAction('proofPrompt');
    };
  }
  for (const id of ['openProofFromKnot', 'openProofFromRail']) {
    el(id).onclick = () => {
      opener = el(id);
      scope = current ? { conversationId: current.id } : { projectId: selectedProjectId };
      el('proofModel').replaceChildren(new Option('本地改稿', ''), ...providers.map(p => new Option('用 ' + p.name + ' / ' + p.model + ' 改写选区', p.id)));
      dialog.showModal();
      void chooseBrief();
    };
  }
  el('proofClose').onclick = () => dialog.close();
  el('proofExport').onclick = async () => {
    if (!session || draft || saving || delivery.open) return;
    const version = session;
    const turn = ++deliveryTurn;
    const image = el('proofDeliveryImage');
    image.removeAttribute('src');
    image.hidden = true;
    el('proofSavePng').disabled = true;
    el('proofDeliveryStatus').textContent = '正在排版…';
    el('proofDeliveryMeta').textContent = version.brief.edition;
    delivery.showModal();
    el('proofDeliveryClose').focus();
    try {
      const art = await api.art({...scope,brief:el('proofBrief').value,base:version.id});
      const raster = await renderProofPoster(version,art);
      if (turn !== deliveryTurn || !delivery.open) return;
      image.src = raster.url;
      image.alt = version.current.title + '。' + version.current.body;
      image.hidden = false;
      sheet = {data:raster.url.split(',')[1],mimeType:'image/png',filename:version.brief.edition+'-v'+version.number+'.png',kind:'image'};
      el('proofDeliveryMeta').textContent = version.brief.edition + ' · v' + version.number + ' · ' + raster.width + ' × ' + raster.height;
      el('proofDeliveryStatus').textContent = '';
      el('proofSavePng').disabled = false;
    } catch (error) { if (turn === deliveryTurn) el('proofDeliveryStatus').textContent = errorMessage(error); }
  };
  el('proofSavePng').onclick = async () => {
    if (!sheet || savingPng) return;
    savingPng = true;
    el('proofSavePng').disabled = el('proofDeliveryClose').disabled = true;
    try {
      const saved = await window.nova.generation.save(sheet);
      el('proofDeliveryStatus').textContent = saved ? '海报已保存。' : '已取消，仍可继续保存。';
    } catch (error) { el('proofDeliveryStatus').textContent = errorMessage(error); }
    finally {
      savingPng = false;
      el('proofSavePng').disabled = el('proofDeliveryClose').disabled = false;
      el('proofSavePng').focus();
    }
  };
  el('proofDeliveryClose').onclick = () => delivery.close();
  delivery.addEventListener('cancel', event => { if (savingPng) event.preventDefault(); });
  delivery.addEventListener('close', () => {
    ++deliveryTurn;
    sheet = null;
    el('proofDeliveryImage').removeAttribute('src');
    el('proofExport').focus();
  });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++generation; ++dictationTurn; cancelModelPreview(); opener?.focus(); });
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
    void commit(draft, '已采纳' + names[draft.target] + '。', draft.target);
  };
  el('proofDiscard').onclick = () => {
    draft = null;
    show();
    status('已放弃提案。');
    focusAction('proofPrompt');
  };
  el('proofSync').onclick = () => {
    invalidatePreview();
    draft = { target: 'voice', text: session.current.title, base: session.id, operation: 'sync' };
    show();
    focusAction('proofAccept');
  };
  el('proofAudio').onclick = () => {
    if (!session || saving) return;
    const text = session.current.voice;
    opener = null;
    dialog.close();
    if (presence.isHome()) presence.showWorkspace();
    el('openGenerationStudio').click();
    setGenerationTab('audio', crypto.randomUUID());
    generationPromptElement().value = text;
    generationPromptElement().dispatchEvent(new Event('input', { bubbles: true }));
    generationPromptElement().focus();
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
