'use strict';

function textLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function fileSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function workspaceIcon(name) {
  const icon = document.createElement('span');
  icon.className = `ui-icon i-${name}`;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function renderCounts(element, counts) {
  element.replaceChildren();
  if (!counts) return;
  for (const [kind, sign, label] of [['add', '+', '新增'], ['remove', '−', '删除']]) {
    const item = document.createElement('span');
    item.className = `count-${kind}`;
    item.textContent = `${sign}${counts[kind]}`;
    item.setAttribute('aria-label', `${label} ${counts[kind]} 行`);
    element.append(item);
  }
}

function createWorkspaceBrowser({ $, api, errorMessage, onPreview, onAttach, onSave, getProvider }) {
  let scope, directory = '.', loaded = false, loading = false, listRequest = 0;
  let entries = [], folderNote = '', truncated = false, selected = null, editor = null, mountedTab = null;
  let treeMode = false;
  const folders = new Map();
  const expanded = new Set();
  const workspaces = new Map();
  const autoCompletion = new Set();
  const filter = $('fileFilter');
  const fileDialog = $('newWorkspaceFileDialog');
  const fileForm = $('newWorkspaceFileForm');
  let creating = false;
  const discard = $('editorDiscard');
  $('cancelEditorDiscard').onclick = () => discard.close('cancel');
  $('confirmEditorDiscard').onclick = () => discard.close('discard');
  const tabs = () => scope && workspaces.get(scope.target.workspace);
  const active = () => tabs()?.get(selected);
  const dirty = tab => Boolean(tab?.preview?.revision && tab.text !== tab.initial);
  const hasUnsaved = () => [...workspaces.values()].some(items => [...items.values()].some(tab => dirty(tab) || tab.saving));
  const editable = tab => Boolean(tab?.preview?.revision && !tab.preview.readOnly);
  const assist = createCodeAssist({ $, api, errorMessage, getContext() {
    const tab = active();
    if (!editor || tab !== mountedTab || !editable(tab) || tab.saving) return null;
    const provider = getProvider();
    const { from, to } = editor.selection();
    return {
      editor, from, to, target: scope.target, path: tab.path, revision: tab.preview.revision,
      source: tab.text, providerId: provider?.id, providerName: provider?.name,
      automatic: tab.canAutoComplete && autoCompletion.has(scope.target.workspace)
    };
  } });

  function makeFileRow({ name, kind }, parent, children) {
    const relative = parent === '.' ? name : `${parent}/${name}`;
    const folder = kind === 'directory';
    const interactive = folder || kind === 'file';
    const row = document.createElement(interactive ? 'button' : 'div');
    row.className = 'file-entry';
    row.title = interactive ? relative : `${relative} · 链接或特殊文件`;
    const open = folder && treeMode && expanded.has(relative);
    row.append(workspaceIcon(folder ? (open ? 'folder-open' : 'folder') : kind === 'link' ? 'link' : 'file'));
    const label = document.createElement('span');
    label.className = 'file-entry-name';
    label.textContent = name;
    row.append(label);
    if (folder) row.append(workspaceIcon('chevron'));
    if (interactive) {
      row.type = 'button';
      row.dataset.path = relative;
      if (selected === relative) row.setAttribute('aria-current', 'true');
      row.onclick = () => {
        if (!folder) void openPreview(relative);
        else if (treeMode) void toggleFolder(relative);
        else void loadFolder(relative, true);
      };
      if (folder && treeMode) row.setAttribute('aria-expanded', String(open));
    }
    if (!open || !children) return row;
    const group = document.createElement('div');
    group.className = 'tree-branch';
    group.append(row, children);
    return group;
  }

  const fileKey = name => name.normalize('NFC').toLowerCase();

  function renderFileTree(list, query) {
    const root = folders.get('.');
    let count = 0;
    let limited = Boolean(root?.truncated);
    const matches = item => !query || fileKey(item.name).includes(query);

    function build(parent, level) {
      const rows = document.createElement('div');
      if (parent !== '.') rows.className = 'tree-children';
      const folder = folders.get(parent);
      if (folder?.note && parent !== '.') {
        const note = document.createElement('p');
        note.className = 'muted tree-note';
        note.textContent = folder.note;
        rows.append(note);
      }
      for (const item of folder?.entries || []) {
        if (count >= 1200 || level >= 24) { limited = true; break; }
        const relative = parent === '.' ? item.name : `${parent}/${item.name}`;
        const isOpen = item.kind === 'directory' && expanded.has(relative);
        const children = isOpen ? build(relative, level + 1) : null;
        if (!matches(item) && !children?.childElementCount) continue;
        limited ||= Boolean(isOpen && folders.get(relative)?.truncated);
        count++;
        rows.append(makeFileRow(item, parent, children));
      }
      return rows;
    }

    const tree = build('.', 0);
    list.replaceChildren(...tree.children);
    $('fileLocation').hidden = true;
    $('fileListStatus').textContent = root?.note || (limited ? '列表已达显示上限，可用 ⌘P 搜索项目。' : query ? `${count} 个匹配项` : '');
  }

  function renderFiles() {
    const list = $('fileEntries');
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.path : null;
    const query = fileKey(filter.value.trim());
    if (treeMode) renderFileTree(list, query);
    else {
      const visible = query ? entries.filter(({ name }) => fileKey(name).includes(query)) : entries;
      const status = folderNote || (query ? `${visible.length} 个匹配项` : '');
      $('fileListStatus').textContent = truncated ? `${status ? `${status} · ` : ''}已列出前 500 项` : status;
      $('fileLocation').hidden = directory === '.';
      $('fileLocationPath').textContent = directory;
      $('fileLocationPath').title = directory;
      list.replaceChildren(...visible.map(item => makeFileRow(item, directory)));
    }
    if (focused) [...list.querySelectorAll('button')].find(node => node.dataset.path === focused)?.focus({ preventScroll: true });
  }

  function loadTreeFolder(relative) {
    if (!scope) return;
    const pending = { note: '正在读取…' };
    folders.set(relative, pending);
    renderFiles();
    return api.workspace.list({ ...scope.target, path: relative }).then(result => {
      if (folders.get(relative) !== pending) return;
      Object.assign(pending, result, { note: result.entries.length ? '' : '此目录为空。' });
    }, error => {
      if (folders.get(relative) === pending) pending.note = errorMessage(error);
    }).finally(() => {
      if (treeMode && folders.get(relative) === pending) renderFiles();
    });
  }

  function toggleFolder(relative) {
    if (expanded.delete(relative)) { renderFiles(); return; }
    if (expanded.size >= 48) {
      $('fileListStatus').textContent = '已展开 48 个目录，请收起一部分再继续。';
      return;
    }
    expanded.add(relative);
    return loadTreeFolder(relative);
  }

  function showFiles() {
    if (treeMode) {
      if (!folders.has('.')) void loadTreeFolder('.');
    } else if (!loaded && !loading) void loadFolder();
  }

  async function loadFolder(relative = directory, focus = false) {
    if (!scope) return;
    const request = ++listRequest;
    loading = true;
    if (relative !== directory) filter.value = '';
    directory = relative;
    entries = [];
    truncated = false;
    folderNote = '正在读取目录…';
    renderFiles();
    try {
      const result = await api.workspace.list({ ...scope.target, path: relative });
      if (request !== listRequest) return;
      entries = result.entries;
      truncated = result.truncated;
      folderNote = entries.length ? '' : '此目录为空。';
    } catch (error) {
      if (request !== listRequest) return;
      folderNote = errorMessage(error);
    }
    loaded = true;
    loading = false;
    renderFiles();
    if (focus && !$('fileBrowser').hidden && !$('taskPane').hidden) {
      const next = $('fileEntries').querySelector('button') || (directory === '.' ? $('refreshFiles') : $('fileParent'));
      next.focus({ preventScroll: true });
    }
  }

  function setPreviewStatus(text, isError = false) {
    $('previewStatus').hidden = !text;
    $('previewStatus').textContent = text;
    $('previewStatus').classList.toggle('preview-error', isError);
  }

  function renderTabs() {
    const list = $('editorTabs');
    const focus = list.contains(document.activeElement) ? document.activeElement.dataset.tab : null;
    list.replaceChildren(...[...(tabs()?.values() || [])].map(tab => {
      const row = document.createElement('div');
      row.className = 'editor-tab';
      row.classList.toggle('active', tab.path === selected);
      const open = document.createElement('button');
      open.type = 'button';
      open.dataset.tab = tab.path;
      open.setAttribute('aria-pressed', String(tab.path === selected));
      open.title = tab.path;
      const name = document.createElement('span');
      name.textContent = tab.path.split('/').at(-1);
      open.append(workspaceIcon('code'), name);
      open.onclick = () => void openPreview(tab.path);
      const close = document.createElement('button');
      close.className = 'editor-tab-close';
      close.type = 'button';
      close.setAttribute('aria-label', `关闭 ${tab.path}${dirty(tab) ? '（有未保存修改）' : ''}`);
      close.title = dirty(tab) ? '有未保存修改' : '关闭文件';
      close.append(workspaceIcon('close'));
      close.classList.toggle('modified', dirty(tab));
      close.onclick = () => void closeTab(tab);
      row.append(open, close);
      return row;
    }));
    if (focus) [...list.querySelectorAll('[data-tab]')].find(button => button.dataset.tab === focus)?.focus({ preventScroll: true });
  }

  function syncEditor(tab) {
    const preview = tab?.preview;
    const edit = editable(tab);
    const selection = editor?.selection();
    const ready = Boolean(preview?.revision && !dirty(tab) && !tab.saving);
    $('attachSelection').hidden = !(ready && selection && selection.from < selection.to);
    $('attachPreview').hidden = !preview?.revision;
    $('attachPreview').dataset.ready = String(ready);
    $('codeComplete').hidden = $('codeRewrite').hidden = !edit;
    $('codeComplete').disabled = $('codeRewrite').disabled = !edit || tab.saving;
    const autoEnabled = Boolean(scope && autoCompletion.has(scope.target.workspace));
    $('autoComplete').hidden = !edit || !tab.canAutoComplete;
    $('autoComplete').setAttribute('aria-pressed', String(autoEnabled));
    $('saveEditor').hidden = !edit;
    $('saveEditor').disabled = !edit || !dirty(tab) || tab.saving;
    $('saveEditor').classList.toggle('has-edits', dirty(tab));
    $('editorFooter').hidden = !editor;
    const issues = editor?.issueCount() || 0;
    $('editorIssues').hidden = !issues;
    $('editorIssues').textContent = issues ? `${issues} 处语法提示` : '';
    $('editorPosition').textContent = selection ? `第 ${selection.line} 行，第 ${selection.column} 列` : '';
    $('editorEncoding').textContent = `UTF-8 · ${tab?.eol === '\r\n' ? 'CRLF' : tab?.eol === '\r' ? 'CR' : 'LF'}`;
    $('filePreviewBytes').textContent = preview ? fileSize(preview.bytes) : '';
    $('editorState').textContent = tab?.saving ? '正在保存…' : dirty(tab) ? '未保存' : edit ? '已保存' : '只读';
  }

  function unmount(keepState = true) {
    if (!editor) return;
    assist.clear();
    mountedTab.snapshot = keepState ? editor.snapshot() : null;
    editor.destroy();
    editor = null;
    mountedTab = null;
    $('fileLines').replaceChildren();
  }

  function mount(tab, { focus = false, line, reset = false } = {}) {
    if (tab !== mountedTab || reset) unmount(!reset || tab !== mountedTab);
    $('filePreviewName').textContent = tab.path.split('/').at(-1);
    $('filePreviewPath').textContent = tab.path;
    $('filePreviewPath').title = tab.path;
    const hasText = typeof tab.preview?.text === 'string';
    $('filePreviewBody').hidden = $('wrapPreview').hidden = !hasText;
    $('wrapPreview').setAttribute('aria-pressed', String(tab.wrap));
    setPreviewStatus(tab.error || (tab.loading ? '正在读取文件…' : !hasText ? '此文件无法作为 UTF-8 文本打开。' : tab.preview.truncated ? '只读预览 · 显示前 64 KiB' : tab.preview.readOnly ? '只读预览 · 此文件有硬链接' : ''), Boolean(tab.error));
    if (hasText) {
      if (!window.xiaoxiaoEditor) {
        setPreviewStatus('编辑器资源加载失败。请重新构建应用。', true);
        syncEditor(null);
        return;
      }
      if (!editor) {
        mountedTab = tab;
        editor = window.xiaoxiaoEditor.open($('fileLines'), {
          path: tab.path, text: tab.text, wrap: tab.wrap, readOnly: !editable(tab), snapshot: tab.snapshot,
          onSave: save,
          onAssist: assist.run,
          onUpdate(changed, selectionChanged, typed) {
            if (changed || selectionChanged) assist.clear();
            if (changed) {
              const wasDirty = dirty(tab);
              tab.text = editor.text();
              if (wasDirty !== dirty(tab)) renderTabs();
              if (typed) assist.onTyped();
            }
            syncEditor(tab);
          }
        });
        tab.snapshot = null;
      }
      if (line) editor.jump(line);
      if (focus) editor.focus();
    }
    syncEditor(tab);
  }

  async function loadTab(tab, target, { focus, line, quiet, force = false } = {}) {
    const request = (tab.request || 0) + 1;
    tab.request = request;
    tab.loading = true;
    tab.error = '';
    if (!quiet && active() === tab) mount(tab);
    let reset = false;
    try {
      const result = await api.workspace.preview({ ...target, path: tab.path });
      if (request !== tab.request || dirty(tab)) return;
      reset = force || tab.preview?.text !== result.text || Boolean(tab.preview?.readOnly) !== Boolean(result.readOnly)
        || Boolean(tab.preview?.revision) !== Boolean(result.revision);
      tab.preview = result;
      tab.canAutoComplete = result.canAutoComplete;
      tab.initial = tab.text = result.text?.replace(/\r\n|\r/g, '\n') ?? '';
      tab.eol = result.text?.match(/\r\n|\r|\n/)?.[0] || '\n';
    } catch (error) {
      if (request !== tab.request || dirty(tab)) return;
      const message = errorMessage(error);
      const missing = message.startsWith('ENOENT:');
      if (!quiet || force || missing) { reset = true; tab.preview = null; }
      tab.error = missing ? '文件已移动或删除。' : message;
    } finally {
      if (tab.request === request) {
        tab.loading = false;
        if (reset) tab.snapshot = null;
        if (active() === tab && !dirty(tab)) mount(tab, { focus, line, reset });
      }
    }
  }

  async function openPreview(relative, { line } = {}) {
    if (!scope) return;
    let tab = tabs().get(relative);
    if (!tab) {
      if (tabs().size >= 12) {
        const clean = [...tabs().values()].find(item => item.path !== selected && !dirty(item) && !item.saving);
        if (clean) tabs().delete(clean.path);
        else { setPreviewStatus('已打开 12 个文件。保存并关闭一个标签后再打开新文件。', true); return; }
      }
      tab = { path: relative, wrap: false, text: '', initial: '' };
      tabs().set(relative, tab);
    }
    const requestScope = scope.key;
    selected = relative;
    renderFiles();
    renderTabs();
    onPreview(true);
    if (tab.preview && dirty(tab)) mount(tab, { line, focus: true });
    else {
      const unchanged = tab.preview && active() === tab;
      if (unchanged) mount(tab, { line, focus: true });
      await loadTab(tab, scope.target, { line, focus: true, quiet: Boolean(unchanged) });
    }
    if (requestScope === scope?.key && active() === tab) renderTabs();
  }

  function closePreview(restoreFocus = false) {
    const previous = selected;
    selected = null;
    unmount();
    $('filePreviewBody').hidden = $('editorFooter').hidden = true;
    setPreviewStatus('');
    renderTabs();
    renderFiles();
    onPreview(false, { restoreFocus, previous });
  }

  function confirmDiscard(tab) {
    if (!dirty(tab)) return Promise.resolve(true);
    if (discard.open) return Promise.resolve(false);
    $('editorDiscardFile').textContent = tab.path;
    discard.returnValue = '';
    discard.showModal();
    return new Promise(resolve => discard.addEventListener('close', () => resolve(discard.returnValue === 'discard'), { once: true }));
  }

  async function closeTab(tab) {
    const items = tabs();
    if (tab.saving || !await confirmDiscard(tab) || items !== tabs()) return;
    items.delete(tab.path);
    if (selected === tab.path) {
      const next = [...items.keys()].at(-1);
      if (next) await openPreview(next);
      else closePreview(true);
    }
    renderTabs();
  }

  async function save() {
    const tab = active();
    if (!tab || !dirty(tab) || tab.saving || tab.preview.readOnly) return;
    const target = scope.target;
    const submitted = tab.text;
    const content = submitted.replace(/\n/g, tab.eol);
    assist.clear();
    ++tab.request;
    tab.loading = false;
    tab.saving = true;
    syncEditor(tab);
    try {
      tab.preview = await api.workspace.save({ ...target, path: tab.path, revision: tab.preview.revision, content });
      tab.initial = submitted;
      tab.error = '';
      onSave();
    } catch (error) {
      tab.error = errorMessage(error);
    } finally {
      tab.saving = false;
      if (active() === tab) {
        setPreviewStatus(tab.error, Boolean(tab.error));
        renderTabs();
        syncEditor(tab);
      }
    }
  }

  async function attach(range) {
    const tab = active();
    if (!tab?.preview?.revision || dirty(tab) || tab.saving) return;
    try { await onAttach({ ...scope.target, path: tab.path, revision: tab.preview.revision, range }); }
    catch (error) { if (active() === tab) setPreviewStatus(errorMessage(error), true); }
  }

  function showCreateFile() {
    if (!scope || fileDialog.open) return;
    const parent = treeMode ? selected?.split('/').slice(0, -1).join('/') : directory;
    const input = $('newWorkspaceFilePath');
    input.value = parent && parent !== '.' ? `${parent}/` : '';
    $('newWorkspaceFileStatus').textContent = '';
    fileDialog.showModal();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  $('newWorkspaceFile').onclick = $('createEditorFile').onclick = showCreateFile;
  $('cancelWorkspaceFile').onclick = () => { if (!creating) fileDialog.close(); };
  fileDialog.addEventListener('cancel', event => { if (creating) event.preventDefault(); });
  fileForm.onsubmit = async event => {
    event.preventDefault();
    if (!scope || creating) return;
    const path = $('newWorkspaceFilePath').value.trim();
    const key = scope.key;
    creating = $('cancelWorkspaceFile').disabled = $('createWorkspaceFileNow').disabled = true;
    $('newWorkspaceFileStatus').textContent = '正在创建文件…';
    try {
      await api.workspace.createFile({ ...scope.target, path });
      if (scope?.key !== key) return;
      fileDialog.close();
      if (treeMode) {
        const segments = path.split('/');
        await loadTreeFolder('.');
        for (let level = 1; level < segments.length && expanded.size < 48; level++) {
          if (scope?.key !== key || !treeMode) break;
          const parent = segments.slice(0, level).join('/');
          expanded.add(parent);
          await loadTreeFolder(parent);
        }
      } else if (!$('fileBrowser').hidden && !$('taskPane').hidden) await loadFolder();
      if (scope?.key !== key) return;
      onSave();
      await openPreview(path);
    } catch (error) {
      $('newWorkspaceFileStatus').textContent = errorMessage(error);
      if (fileDialog.open) $('newWorkspaceFilePath').focus();
    } finally { creating = $('cancelWorkspaceFile').disabled = $('createWorkspaceFileNow').disabled = false; }
  };

  $('fileParent').onclick = () => void loadFolder(directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '.', true);
  $('refreshFiles').onclick = () => {
    if (treeMode) {
      folders.clear();
      expanded.clear();
      void loadTreeFolder('.');
    } else void loadFolder();
  };
  filter.oninput = renderFiles;
  $('fileEntries').onkeydown = event => {
    if (!treeMode || !event.target.matches('button')) return;
    const rows = [...$('fileEntries').querySelectorAll('button')];
    const row = event.target;
    const index = rows.indexOf(row);
    if (event.key === 'ArrowDown') rows[index + 1]?.focus();
    else if (event.key === 'ArrowUp') (rows[index - 1] || filter).focus();
    else if (event.key === 'ArrowRight' && row.hasAttribute('aria-expanded')) {
      if (row.getAttribute('aria-expanded') === 'false') row.click();
      else row.nextElementSibling?.querySelector('button')?.focus();
    } else if (event.key === 'ArrowLeft') {
      if (row.getAttribute('aria-expanded') === 'true') row.click();
      else row.closest('.tree-children')?.previousElementSibling?.focus();
    }
    else return;
    event.preventDefault();
  };
  filter.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && filter.value) {
      event.stopPropagation();
      event.preventDefault();
      filter.value = '';
      renderFiles();
    } else if (event.key === 'ArrowDown') {
      const first = $('fileEntries').querySelector('button');
      if (!first) return;
      event.preventDefault();
      first.focus();
    }
  };
  $('refreshPreview').onclick = async () => {
    const tab = active();
    if (!tab || tab.saving || !await confirmDiscard(tab) || active() !== tab) return;
    tab.text = tab.initial;
    await loadTab(tab, scope.target, { focus: true, force: true });
    renderTabs();
  };
  $('returnToChat').onclick = () => closePreview(true);
  $('wrapPreview').onclick = () => {
    const tab = active();
    if (!tab) return;
    tab.wrap = !tab.wrap;
    $('wrapPreview').setAttribute('aria-pressed', String(tab.wrap));
    editor?.wrap(tab.wrap);
  };
  $('saveEditor').onclick = save;
  $('autoComplete').onclick = () => {
    if (!scope || !editable(active()) || !active().canAutoComplete) return;
    const { workspace } = scope.target;
    if (autoCompletion.has(workspace)) autoCompletion.delete(workspace);
    else autoCompletion.add(workspace);
    assist.clear();
    syncEditor(active());
    editor?.focus();
  };
  $('editorIssues').onclick = () => editor?.showIssues();
  $('attachPreview').onclick = () => attach();
  $('attachSelection').onclick = () => attach(editor?.selection());
  window.addEventListener('beforeunload', event => {
    if (hasUnsaved()) { event.preventDefault(); event.returnValue = false; }
  });

  return {
    setScope(next) {
      const previousKey = scope?.key;
      if (previousKey === next?.key) return;
      closePreview();
      scope = next;
      if (scope && !tabs()) workspaces.set(scope.target.workspace, new Map());
      ++listRequest;
      directory = '.';
      loaded = loading = false;
      filter.value = '';
      folderNote = '';
      truncated = false;
      entries = [];
      folders.clear();
      expanded.clear();
      $('fileRootLabel').textContent = next?.name || '';
      $('fileRootLabel').title = next?.name || '';
    },
    show: showFiles,
    setTreeMode(next) {
      if (treeMode === next) return;
      treeMode = next;
      filter.value = '';
      filter.placeholder = treeMode ? '筛选已展开的文件' : '筛选当前目录';
      renderFiles();
      if (!$('fileBrowser').hidden && !$('taskPane').hidden) showFiles();
    },
    refresh({ allFolders = false } = {}) {
      if (!scope) return;
      if (allFolders || (!$('fileBrowser').hidden && !$('taskPane').hidden)) {
        if (treeMode) {
          void loadTreeFolder('.');
          const parent = selected?.includes('/') && selected.slice(0, selected.lastIndexOf('/'));
          for (const folder of expanded) if (allFolders || folder === parent) void loadTreeFolder(folder);
        } else void loadFolder();
      }
      else { ++listRequest; loaded = loading = false; }
      const refreshTabs = allFolders ? tabs()?.values() || [] : [active()];
      for (const tab of refreshTabs) {
        if (tab && !dirty(tab) && !tab.saving) void loadTab(tab, scope.target, { quiet: true, force: allFolders });
      }
    },
    open: openPreview,
    close: closePreview,
    save,
    clearAssist: assist.clear,
    hasUnsavedHere() { return [...(tabs()?.values() || [])].some(tab => dirty(tab) || tab.saving); },
    hasPendingChanges(relative) {
      const tab = tabs()?.get(relative);
      return dirty(tab) || Boolean(tab?.saving);
    },
    async reloadFile(relative) {
      const tab = tabs()?.get(relative);
      if (tab && !dirty(tab) && !tab.saving) await loadTab(tab, scope.target, { quiet: true, force: true });
    },
    hasUnsaved
  };
}

function createWorkspaceReview({ $, answer, errorMessage }) {
  let pending, active;
  const dialog = $('changeReviewDialog');
  const modes = { diff: 'reviewDiff', before: 'reviewBefore', after: 'reviewAfter' };

  function source(text, empty) {
    const output = document.createElement(text ? 'pre' : 'p');
    output.className = text ? 'review-source' : 'review-note';
    output.textContent = text || empty;
    return output;
  }

  function difference(review) {
    const changed = review.chunks?.reduce((count, chunk) => chunk.kind === 'context' ? count : count + chunk.count, 0);
    if (!review.chunks || changed > 1600) return source('', '差异较长，可切换视图查看全文。');
    const list = document.createElement('div');
    list.className = 'diff-lines';
    let oldNumber = 1, newNumber = 1;
    const fragment = document.createDocumentFragment();
    for (const [index, chunk] of review.chunks.entries()) {
      const lines = textLines(chunk.value);
      const context = chunk.kind === 'context';
      for (const [offset, text] of lines.entries()) {
        const left = chunk.kind === 'add' ? '' : oldNumber++;
        const right = chunk.kind === 'remove' ? '' : newNumber++;
        const nearPrevious = index > 0 && offset < 3;
        const nearNext = index < review.chunks.length - 1 && offset >= lines.length - 3;
        if (context && !nearPrevious && !nearNext) {
          if (offset === (index === 0 ? 0 : 3)) {
            const omitted = document.createElement('div');
            omitted.className = 'diff-omitted';
            omitted.textContent = '未改动的内容已折叠';
            fragment.append(omitted);
          }
          continue;
        }
        const row = document.createElement('div');
        row.className = `diff-row diff-${chunk.kind}`;
        for (const number of [left, right]) {
          const cell = document.createElement('span');
          cell.className = 'diff-number';
          cell.textContent = number;
          cell.setAttribute('aria-hidden', 'true');
          row.append(cell);
        }
        const value = document.createElement('code');
        value.textContent = (chunk.kind === 'add' ? '+ ' : chunk.kind === 'remove' ? '− ' : '  ') + text;
        row.append(value);
        fragment.append(row);
      }
    }
    list.append(fragment);
    if (!list.children.length) return source('', review.created ? '将创建空文件。' : '没有文本差异。');
    if (!review.created && (review.before.endsWith('\n') !== review.after.endsWith('\n') || review.before.replace(/\r\n/g, '\n') === review.after.replace(/\r\n/g, '\n'))) {
      const note = document.createElement('p');
      note.className = 'diff-omitted';
      note.textContent = '文件的换行符发生了变化。';
      list.append(note);
    }
    return list;
  }

  function render(mode) {
    if (!active) return;
    const { review } = active;
    for (const [key, id] of Object.entries(modes)) $(id).setAttribute('aria-pressed', String(key === mode));
    const body = $('changeReviewBody');
    const content = mode === 'diff' ? difference(review) : source(review[mode], '此文件为空。');
    body.replaceChildren(content);
    body.scrollTo(0, 0);
  }

  function reviewFeedback(text, error = false) {
    const status = $('reviewStatus');
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function renderReview() {
    const { review, stored, openCurrent, restore, restoring } = active;
    const folder = review.workspace?.split(/[\\/]/).filter(Boolean).at(-1);
    $('changeReviewTitle').textContent = restoring ? '恢复文件' : stored ? '写入记录' : '审阅文件改动';
    $('changeReviewPath').textContent = folder ? `${folder} / ${review.path}` : review.path;
    $('changeReviewPath').title = review.workspace ? `${review.workspace} / ${review.path}` : review.path;
    $('reviewBefore').hidden = review.created;
    $('reviewBefore').textContent = restoring ? '当前版本' : '原文件';
    $('reviewAfter').textContent = restoring ? '恢复后' : stored ? '写入版本' : '拟写内容';
    $('reviewDate').hidden = !stored || restoring;
    $('reviewDate').textContent = stored && !restoring ? `${review.restoration ? '已恢复' : '已应用'} · ${new Date(review.at).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
    $('openCurrentFile').hidden = !stored || !openCurrent || restoring;
    $('restoreFilePreview').hidden = !restore || restoring;
    $('cancelFileRestore').hidden = $('applyFileRestore').hidden = !restoring;
    $('applyReviewedWrite').hidden = $('rejectReviewedWrite').hidden = stored;
    reviewFeedback('');
    renderCounts($('reviewCounts'), review.counts);
    render('diff');
  }

  function show(review, { stored = false, openCurrent, restore, restoreFocus } = {}) {
    if (dialog.open) return;
    active = { review, original: review, stored, openCurrent, restore, restoreFocus };
    setRestoreBusy(false);
    renderReview();
    dialog.showModal();
    $('changeReviewBody').focus({ preventScroll: true });
  }

  function setRestoreBusy(busy, applying = false) {
    active.applying = busy && applying;
    $('restoreFilePreview').disabled = $('applyFileRestore').disabled = $('cancelFileRestore').disabled = busy;
    $('openCurrentFile').disabled = $('closeChangeReview').disabled = busy && applying;
  }

  for (const [mode, id] of Object.entries(modes)) $(id).onclick = () => render(mode);
  $('openChangeReview').onclick = () => {
    if (pending) show(pending);
  };
  $('closeChangeReview').onclick = () => dialog.close();
  $('rejectReviewedWrite').onclick = () => answer(false);
  $('applyReviewedWrite').onclick = () => answer(true);
  $('openCurrentFile').onclick = () => {
    const open = active?.openCurrent;
    if (active) active.restoreFocus = null;
    dialog.close();
    open?.();
  };
  $('restoreFilePreview').onclick = async () => {
    const view = active;
    if (!view?.restore || view.restoring) return;
    setRestoreBusy(true);
    reviewFeedback('正在检查磁盘版本…');
    try {
      const review = await view.restore.preview();
      if (active !== view || !dialog.open) return;
      view.restoring = true;
      view.review = { ...review, workspace: view.original.workspace };
      renderReview();
      reviewFeedback('确认后将写入显示的恢复版本。');
      $('changeReviewBody').focus({ preventScroll: true });
    } catch (error) {
      if (active === view && dialog.open) reviewFeedback(errorMessage(error), true);
    } finally { if (active === view) setRestoreBusy(false); }
  };
  $('cancelFileRestore').onclick = () => {
    if (!active?.restoring || active.applying) return;
    active.restoring = false;
    active.review = active.original;
    renderReview();
    $('restoreFilePreview').focus({ preventScroll: true });
  };
  $('applyFileRestore').onclick = async () => {
    const view = active;
    if (!view?.restoring || view.applying) return;
    setRestoreBusy(true, true);
    reviewFeedback('正在恢复文件…');
    try {
      await view.restore.apply();
      dialog.close();
    } catch (error) { reviewFeedback(errorMessage(error), true); }
    finally { if (active === view) setRestoreBusy(false); }
  };
  dialog.addEventListener('cancel', event => { if (active?.applying) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    // An immediately reopened dialog already has its own content.
    if (!dialog.open) {
      const restoreFocus = active?.restoreFocus;
      active = null;
      $('changeReviewBody').replaceChildren();
      restoreFocus?.();
    }
  });

  return {
    set(review) {
      if (dialog.open && !active?.stored) dialog.close();
      pending = review;
      $('openChangeReview').hidden = !review;
      if (!review) return;
      $('approvalFileName').textContent = review.path;
      $('approvalFileName').title = review.path;
      $('approvalFileInfo').textContent = review.created ? '新建文件 · 查看改动' : '修改现有文件 · 查看改动';
      renderCounts($('approvalFileCounts'), review.counts);
    },
    showStored(review, options) { show(review, { ...options, stored: true }); },
    setBusy(busy) { $('applyReviewedWrite').disabled = $('rejectReviewedWrite').disabled = busy; },
    setStatus(text) { reviewFeedback(text, Boolean(text)); },
    pendingOpen() { return dialog.open && !active?.stored; }
  };
}
