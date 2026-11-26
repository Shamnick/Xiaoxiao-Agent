'use strict';

const openCreationGallery = (() => {
  const dialog = $('creationGallery');
  const toggle = $('galleryCompare');
  const pair = $('galleryPair');
  const position = $('galleryPosition');
  const panes = [];
  let session;

  function showSingle(index) {
    const thumb = session.thumbs[index];
    if (!thumb) return;
    session.index = index;
    const image = thumb.querySelector('img');
    $('galleryImage').src = image.src;
    $('galleryImage').alt = image.alt;
    $('galleryScale').setAttribute('aria-pressed', 'false');
    $('galleryViewport').classList.remove('original-size');
    $('galleryViewport').scrollTo(0, 0);
    position.textContent = (index + 1) + ' / ' + session.thumbs.length;
    $('galleryNavigation').hidden = session.thumbs.length < 2;
    $('galleryPrevious').disabled = index === 0;
    $('galleryNext').disabled = index === session.thumbs.length - 1;
    $('galleryCaption').textContent = session.prompt;
  }

  async function indexThread(opened, turns) {
    const choices = [];
    let failed = false;
    for (const [i, row] of turns.entries()) {
      if (session !== opened) return;
      if (!isCompleted(row)) continue;
      let indices = row.imageIndices;
      if (!indices) {
        // Older records contain only a prompt in the index. Read one batch at a
        // time and retain just its indices for subsequent previews.
        try { indices = creationImageIndices(await readAssets(row.id)); }
        catch { failed = true; continue; }
        row.imageIndices = indices;
      }
      for (const index of indices) {
        choices.push({ id: row.id, index, prompt: row.prompt, label: '第 ' + (i + 1) + ' 轮 · 图 ' + (index + 1) });
      }
    }
    if (session !== opened) return;
    opened.choices = choices;
    toggle.hidden = choices.length < 2;
    if (failed) position.textContent = '部分历史图片读取失败';
  }

  async function saveImage(id, index, report) {
    try {
      const asset = (await readAssets(id))?.[index];
      if (!asset?.data) throw Error('找不到这张原图');
      if (await api.generation.save({ ...asset, kind: 'image' })) report('图片已导出');
    } catch (error) { report(errorMessage(error)); }
  }

  function createPane(side) {
    const el = $('galleryPaneTemplate').content.firstElementChild.cloneNode(true);
    const pane = {
      side, request: 0, select: el.querySelector('select'), save: el.querySelector('button'),
      image: el.querySelector('img'), prompt: el.querySelector('p'), status: el.querySelector('[role=status]')
    };
    el.querySelector('.gallery-side').textContent = side + '图';
    el.setAttribute('aria-label', side + '图');
    pane.select.setAttribute('aria-label', '选择' + side + '图版本');
    pane.save.title = '导出' + side + '图原件';
    pane.save.setAttribute('aria-label', pane.save.title);
    pane.select.onchange = () => selectPair(panes.map(p => p.select.selectedIndex));
    pane.save.onclick = () => {
      const selected = pane.selection;
      void saveImage(selected.id, selected.index, message => {
        if (pane.selection === selected) position.textContent = message === '图片已导出' ? side + '图已导出' : message;
      });
    };
    pair.append(el);
    return pane;
  }

  async function loadSide(pane, choice) {
    pane.selection = choice;
    const request = ++pane.request;
    pane.image.hidden = pane.save.disabled = true;
    pane.image.removeAttribute('src');
    pane.prompt.textContent = pane.prompt.title = choice.prompt;
    pane.status.textContent = '正在读取原图…';
    try {
      const asset = (await readAssets(choice.id))?.[choice.index];
      if (pane.request !== request) return;
      if (!asset?.data) throw Error('找不到这张原图');
      pane.image.src = 'data:' + asset.mimeType + ';base64,' + asset.data;
      await pane.image.decode();
      if (pane.request !== request) return;
      pane.image.alt = pane.side + '图，' + choice.label;
      pane.image.hidden = pane.save.disabled = false;
      pane.status.textContent = '';
    } catch (error) {
      if (pane.request === request) pane.status.textContent = errorMessage(error);
    }
  }

  function selectPair(indices) {
    for (const [i, pane] of panes.entries()) {
      pane.select.selectedIndex = indices[i];
      for (const option of pane.select.options) option.disabled = option.index === indices[1 - i];
      const choice = session.choices[indices[i]];
      if (choice !== pane.selection) void loadSide(pane, choice);
    }
    position.textContent = '';
  }

  function clearPair() {
    for (const pane of panes) {
      pane.request++;
      pane.selection = null;
      pane.image.removeAttribute('src');
      pane.select.replaceChildren();
    }
  }

  function setComparison(enabled) {
    toggle.setAttribute('aria-pressed', String(enabled));
    pair.hidden = $('gallerySwap').hidden = !enabled;
    $('galleryUseReference').hidden = $('galleryViewport').hidden = $('galleryScale').hidden = $('gallerySave').hidden = enabled;
    $('creationGalleryTitle').textContent = enabled ? '图片对比' : '图片预览';
    if (!enabled) {
      clearPair();
      showSingle(session.index);
      return;
    }
    const choices = session.choices;
    const thumb = session.thumbs[session.index];
    const anchor = choices.findIndex(choice => choice.id === session.id && choice.index === Number(thumb.dataset.assetIndex));
    if (anchor < 0) { setComparison(false); return; }
    // Prefer another round over a sibling from the clicked batch.
    const before = choices.findLastIndex((choice, i) => i < anchor && choice.id !== session.id);
    const after = choices.findIndex((choice, i) => i > anchor && choice.id !== session.id);
    const sibling = anchor > 0 ? anchor - 1 : 1;
    const other = [before, after, sibling].find(index => index >= 0);
    for (const pane of panes) {
      pane.select.replaceChildren(...choices.map(choice => new Option(choice.label)));
    }
    $('galleryNavigation').hidden = true;
    $('galleryCaption').textContent = '本次创作 · 共 ' + choices.length + ' 张图片';
    selectPair([Math.min(anchor, other), Math.max(anchor, other)]);
  }

  panes.push(createPane('左'), createPane('右'));
  toggle.onclick = () => setComparison(pair.hidden);
  $('gallerySwap').onclick = () => selectPair(panes.map(pane => pane.select.selectedIndex).reverse());
  $('galleryClose').onclick = () => dialog.close();
  $('galleryPrevious').onclick = () => showSingle(session.index - 1);
  $('galleryNext').onclick = () => showSingle(session.index + 1);
  dialog.addEventListener('keydown', event => {
    if (!pair.hidden || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    showSingle(session.index + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  $('galleryScale').onclick = () => {
    const original = $('galleryViewport').classList.toggle('original-size');
    $('galleryScale').setAttribute('aria-pressed', String(original));
    $('galleryViewport').scrollTo(0, 0);
  };
  $('galleryUseReference').onclick = () => {
    const id = session.id;
    const index = Number(session.thumbs[session.index].dataset.assetIndex);
    const round = currentTurns().findIndex(row => row.id === id) + 1;
    session.selectedReference = { id, index, label: '第 ' + round + ' 轮 · 图 ' + (index + 1) };
    dialog.close();
  };
  $('gallerySave').onclick = () => {
    const opened = session;
    const index = opened.index;
    void saveImage(opened.id, Number(opened.thumbs[index].dataset.assetIndex), message => {
      if (session === opened && opened.index === index && pair.hidden) position.textContent = message;
    });
  };
  dialog.addEventListener('close', () => {
    if (session?.selectedReference) selectCreationReference(session.selectedReference);
    else session?.thumbs[session.index]?.focus({ preventScroll: true });
    session = null;
    clearPair();
    $('galleryImage').removeAttribute('src');
  });

  return (output, trigger) => {
    const thumbs = [...output.querySelectorAll('.creation-thumbnail')];
    session = { thumbs, index: thumbs.indexOf(trigger), id: output.dataset.id,
      prompt: output.closest('.creation-turn').querySelector('.creation-question').textContent };
    toggle.hidden = true;
    setComparison(false);
    dialog.showModal();
    $('galleryClose').focus();
    void indexThread(session, currentTurns());
  };
})();
