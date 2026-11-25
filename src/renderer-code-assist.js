'use strict';

function createCodeAssist({ $, api, getContext, errorMessage }) {
  const dialog = $('codeEditDialog');
  const form = $('codeEditForm');
  const instruction = $('codeInstruction');
  const difference = $('codeEditCompare');
  const status = $('codeAssistStatus');
  const cancel = $('dismissCodeAssist');
  const accept = $('acceptCodeSuggestion');
  const apply = $('applyCodeEdit');
  let pending = null;
  let completion = null;
  let draft = null;
  let autoTimer = null;
  let lastAutomatic = 0;

  function showStatus(text = '', { error = false, canDismiss = false } = {}) {
    status.textContent = text;
    $('codeAssistStrip').hidden = !text;
    $('codeAssistStrip').classList.toggle('assist-error', error);
    cancel.hidden = !canDismiss;
    accept.hidden = !completion;
  }

  function stop() {
    if (pending) {
      const { id } = pending;
      pending = null;
      void api.code.cancel(id).catch(() => {});
    }
  }

  function clear() {
    const wasActive = Boolean(pending || completion || !status.parentElement.hidden);
    clearTimeout(autoTimer);
    stop();
    if (completion) {
      completion.editor.clearSuggestion();
      completion = null;
    }
    $('codeSuggestionText').textContent = '';
    showStatus();
    return wasActive;
  }

  function valid(context) {
    const next = getContext();
    return next?.editor === context.editor && next.revision === context.revision
      && next.source === context.source && next.providerId === context.providerId
      && next.from === context.from && next.to === context.to;
  }

  async function request(mode, context, requirement, automatic = false) {
    const id = crypto.randomUUID();
    pending = { id };
    try {
      const text = await api.code.suggest({
        ...context.target, path: context.path, revision: context.revision, providerId: context.providerId,
        content: context.source, from: context.from, to: context.to, mode, instruction: requirement, automatic, requestId: id
      });
      return pending?.id === id && valid(context) ? { text } : null;
    } catch (error) {
      if (pending?.id === id && valid(context)) throw error;
      return null;
    } finally {
      if (pending?.id === id) pending = null;
    }
  }

  async function complete(context, automatic = false) {
    if (!automatic) showStatus('正在生成补写建议…', { canDismiss: true });
    try {
      const response = await request('complete', context, '', automatic);
      if (!response) return;
      if (automatic && (!context.editor.readyForAutoCompletion() || document.querySelector('dialog[open]'))) return;
      if (!response.text) {
        if (!automatic) showStatus('当前光标处没有补写建议', { canDismiss: true });
        return;
      }
      const { text } = response;
      completion = { ...context, text };
      context.editor.suggest(context.from, text);
      $('codeSuggestionText').textContent = text;
      showStatus('补写建议 · Tab 采纳 · Esc 忽略', { canDismiss: true });
    } catch (error) {
      if (!automatic) showStatus(errorMessage(error), { error: true, canDismiss: true });
    }
  }

  function dial(mode) {
    if (mode === 'cancel') return clear();
    const context = getContext();
    if (!context) return false;
    clear();
    if (!context.providerId) showStatus('请先在对话中选择模型', { canDismiss: true });
    else if (mode === 'complete' && context.from !== context.to) showStatus('请把光标放在要补写的位置', { canDismiss: true });
    else if (mode === 'complete') void complete(context);
    else if (context.from === context.to) showStatus('请选中一段代码再改写', { canDismiss: true });
    else {
      draft = { context, result: null };
      form.reset();
      instruction.disabled = false;
      difference.hidden = apply.hidden = true;
      $('submitCodeEdit').hidden = $('submitCodeEdit').disabled = false;
      $('codeEditPath').textContent = context.path;
      $('codeEditBefore').textContent = context.source.slice(context.from, context.to);
      $('codeEditAfter').textContent = '';
      $('codeEditStatus').textContent = `使用 ${context.providerName} 处理选区与相邻代码。`;
      dialog.showModal();
      instruction.focus();
    }
    return true;
  }

  form.onsubmit = async event => {
    event.preventDefault();
    if (!draft || pending || !instruction.value.trim()) return;
    const attempt = draft;
    const prompt = instruction.value;
    const feedback = $('codeEditStatus');
    feedback.textContent = '正在生成改写…';
    $('submitCodeEdit').disabled = instruction.disabled = true;
    try {
      const response = await request('edit', attempt.context, prompt);
      if (!response || draft !== attempt || !dialog.open) return;
      if (response.text === $('codeEditBefore').textContent) {
        feedback.textContent = '当前选区已符合要求。可以修改要求后重试。';
        return;
      }
      attempt.result = response.text;
      $('codeEditAfter').textContent = response.text || '（删除选区）';
      difference.hidden = apply.hidden = false;
      $('submitCodeEdit').hidden = true;
      feedback.textContent = '应用后可以继续编辑、撤销或保存。';
      apply.focus();
    } catch (error) {
      if (draft === attempt && dialog.open) feedback.textContent = errorMessage(error);
    } finally {
      if (draft === attempt && attempt.result === null) $('submitCodeEdit').disabled = instruction.disabled = false;
    }
  };

  apply.onclick = () => {
    if (!draft || draft.result === null) return;
    const { context, result } = draft;
    if (!valid(context)) { $('codeEditStatus').textContent = '选区已变化，请重新发起改写'; apply.disabled = true; return; }
    draft = null;
    dialog.close();
    context.editor.replace(context.from, context.to, result);
    context.editor.focus();
  };
  accept.onclick = () => {
    if (!completion || !valid(completion)) { clear(); return; }
    const { editor, from, text } = completion;
    clear();
    editor.replace(from, from, text);
    editor.focus();
  };
  cancel.onclick = () => { clear(); getContext()?.editor.focus(); };
  $('closeCodeEdit').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    apply.disabled = false;
    stop();
    draft = null;
  });
  for (const [id, mode] of [['codeComplete', 'complete'], ['codeRewrite', 'edit']]) {
    $(id).onclick = () => { getContext()?.editor.focus(); dial(mode); };
  }
  return {
    run: dial,
    onTyped() {
      const context = getContext();
      if (!context?.automatic || !context.providerId) return;
      autoTimer = setTimeout(() => {
        if (pending || document.querySelector('dialog[open]') || !valid(context) || !context.editor.readyForAutoCompletion()) return;
        lastAutomatic = Date.now();
        void complete(context, true);
      }, Math.max(1000, lastAutomatic + 2600 - Date.now()));
    },
    clear() {
      clear();
      if (dialog.open) dialog.close();
      draft = null;
    }
  };
}
