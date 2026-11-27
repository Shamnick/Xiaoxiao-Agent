'use strict';

(() => {
  const dialog = $('imageModelDialog');
  const connection = $('imageCatalogConnection');
  const query = $('imageCatalogQuery');
  const list = $('imageCatalogList');
  const note = $('imageCatalogNote');
  const apply = $('imageCatalogUse');
  let names = [], revision = 0;
  const imageName = name => /gpt-image|dall-e|flux|seedream|imagen|image-preview/i.test(name);

  function filter() {
    const text = query.value.trim().toLowerCase();
    list.replaceChildren(...names.filter(name => name.toLowerCase().includes(text)).map(name => new Option(name, name)));
    list.selectedIndex = -1;
    apply.disabled = !connection.value || !text;
  }
  async function discover() {
    const ticket = ++revision;
    query.value = '';
    names = [];
    filter();
    note.textContent = '正在读取服务商目录…';
    try {
      const found = await api.providers.models(connection.value);
      if (ticket !== revision) return;
      names = found.sort((a,b) => Number(imageName(b)) - Number(imageName(a)) || a.localeCompare(b));
      note.textContent = found.length ? `共 ${found.length} 个模型 · 图像相关名称排在前面` : '目录为空，可手动填写模型 ID。';
      filter();
    } catch (error) {
      if (ticket === revision) note.textContent = errorMessage(error) + ' 也可以手动填写模型 ID。';
    }
  }
  $('chooseImageModel').onclick = () => {
    if (!providers.length) { setTab('provider'); void openSettings(); return; }
    const current = providers.find(p => p.id === generationModelId());
    connection.replaceChildren(...providers.filter(p => !p.connectionId).map(p => new Option(p.name, p.id)));
    if (current) connection.value = current.connectionId || current.id;
    dialog.showModal();
    query.focus();
    void discover();
  };
  connection.onchange = discover;
  query.oninput = filter;
  list.onchange = () => { if (list.value) { query.value = list.value; apply.disabled = false; } };
  $('imageCatalogClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { revision++; });
  apply.onclick = async () => {
    const ticket = revision;
    connection.disabled = query.disabled = list.disabled = apply.disabled = true;
    try {
      const id = await api.providers.rememberModel({connectionId:connection.value, model:query.value.trim()});
      await refreshProviders($('modelSelect').value);
      if (!dialog.open || revision !== ticket) return;
      fillGenerationModels(providers);
      $('generationImageModel').value = id;
      $('generationImageModel').dispatchEvent(new Event('input', {bubbles:true}));
      dialog.close();
    } catch (error) { if (ticket === revision) note.textContent = errorMessage(error); }
    finally { connection.disabled = query.disabled = list.disabled = false; apply.disabled = !query.value.trim(); }
  };
})();
