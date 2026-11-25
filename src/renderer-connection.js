'use strict';

function installConnectionCheck() {
  const dialog = $('connectionDialog');
  const form = $('connectionForm');
  const address = $('connectionAddress');
  const secret = $('connectionKey');
  const status = $('connectionStatus');
  let running = false;
  let clearDraftOnSuccess = false;

  function target(validate = false) {
    let endpoint = '';
    let error = '';
    try { endpoint = ConnectionIntent.modelsUrl(address.value.trim()); }
    catch (reason) { error = reason.message; }
    address.setCustomValidity(error);
    $('connectionTarget').textContent = endpoint ? 'GET ' + endpoint : validate && address.value ? error : '支持 HTTPS 网关和本机 HTTP 服务。';
    address.setAttribute('aria-invalid', String(Boolean(validate && error)));
    return endpoint;
  }
  function show(intent = {}, submitted = false) {
    if (dialog.open || locked || currentRun()) return;
    form.reset();
    clearDraftOnSuccess = submitted;
    address.value = intent.address || '';
    secret.value = intent.key || '';
    status.textContent = '';
    status.classList.remove('error');
    target();
    dialog.showModal();
    if (address.value && !secret.value) secret.focus();
  }
  $('openConnectionCheck').onclick = () => {
    const prompt = $('prompt');
    const intent = ConnectionIntent.detect(prompt.value);
    if (intent) prompt.value = ConnectionIntent.mask(prompt.value);
    show(intent || {}, Boolean(intent));
  };
  address.oninput = () => target();
  address.onblur = () => target(true);
  function dismiss() {
    if (running) return;
    secret.value = '';
    dialog.close();
  }
  $('cancelConnection').onclick = dismiss;
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => { form.reset(); clearDraftOnSuccess = false; update(); });
  form.onsubmit = async event => {
    event.preventDefault();
    if (running || locked || currentRun() || !target(true)) return;
    running = true;
    const controls = [address, secret, $('cancelConnection'), $('runConnection')];
    controls.forEach(control => { control.disabled = true; });
    status.classList.remove('error');
    status.textContent = '正在读取模型列表并保存报告…';
    try {
      const c = await ensureConversation(true);
      const result = await api.messages.checkConnection({ id: c.id, address: address.value.trim(), key: secret.value.trim() });
      upsert(result);
      if (current?.id === c.id) {
        if (clearDraftOnSuccess) $('prompt').value = '';
        if (presence.isHome()) presence.enterConversation();
        renderCurrent({ preserveScroll: false });
      } else renderHistory();
      dialog.close();
      if (current?.id === c.id) $('chat').lastElementChild?.querySelector('.reply-files button')?.focus();
    } catch (error) {
      status.classList.add('error');
      status.textContent = errorMessage(error);
      status.focus();
    } finally {
      running = false;
      secret.value = '';
      controls.forEach(control => { control.disabled = false; });
      update();
    }
  };
  return show;
}
