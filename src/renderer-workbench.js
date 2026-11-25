'use strict';

function createProjectSearch({ $, api, errorMessage, open, attach }) {
  const dialog = $('projectSearchDialog');
  const input = $('projectQuery');
  const results = $('projectSearchResults');
  let scope, kind, reference, timer, sequence = 0, chosen = false;

  function setKind(next) {
    kind = next;
    input.placeholder = kind === 'files' ? '输入文件名或路径' : '搜索代码或文本';
    $('searchContent').setAttribute('aria-pressed', String(kind === 'content'));
    $('searchFiles').setAttribute('aria-pressed', String(kind === 'files'));
    $('searchContent').hidden = reference;
    $('searchFiles').hidden = reference;
  }

  async function select(row) {
    if (chosen) return;
    chosen = true;
    if (!reference) {
      dialog.close();
      open(row.path, { line: row.line });
      return;
    }
    try {
      const preview = await api.workspace.preview({ ...scope, path: row.path });
      if (!dialog.open) return;
      if (!preview.revision) throw Error('请选择不超过 64 KiB 的 UTF-8 文件');
      if (await attach({ ...scope, path: row.path, revision: preview.revision })) dialog.close();
    } catch (error) {
      if (dialog.open) $('projectSearchStatus').textContent = errorMessage(error);
    } finally { chosen = false; }
  }

  function render(matches) {
    results.replaceChildren(...matches.map(row => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'project-search-result';
      button.title = row.path;
      const icon = workspaceIcon(row.line ? 'code' : 'file');
      const body = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = row.path.split('/').at(-1) + (row.line ? `:${row.line}` : '');
      const detail = document.createElement('small');
      detail.textContent = row.path;
      body.append(title, detail);
      if (row.line) {
        const line = document.createElement('code');
        line.textContent = row.text;
        body.append(line);
      }
      button.append(icon, body);
      button.onclick = () => void select(row);
      return button;
    }));
  }

  function search() {
    clearTimeout(timer);
    const id = ++sequence;
    const query = input.value.trim();
    results.replaceChildren();
    if (!query) {
      $('projectSearchStatus').textContent = reference ? '搜索并选择要加入消息的文件。' : '输入关键词搜索已打开的工作目录。';
      return;
    }
    $('projectSearchStatus').textContent = '正在搜索…';
    timer = setTimeout(async () => {
      try {
        const result = await api.workspace.search({ ...scope, query, kind });
        if (id !== sequence) return;
        render(result.matches);
        $('projectSearchStatus').textContent = `${result.matches.length ? `${result.matches.length} 个结果` : '没有匹配结果'}${result.limited ? ' · 搜索范围已达上限，可缩小关键词再试' : ''}`;
      } catch (error) {
        if (id === sequence) $('projectSearchStatus').textContent = errorMessage(error);
      }
    }, 160);
  }

  input.oninput = search;
  for (const [id, type] of [['searchContent', 'content'], ['searchFiles', 'files']]) $(id).onclick = () => { setKind(type); search(); input.focus(); };
  $('closeProjectSearch').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { clearTimeout(timer); ++sequence; });
  dialog.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const rows = [...results.querySelectorAll('button')];
    if (!rows.length) return;
    const index = rows.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') rows[Math.min(rows.length - 1, index + 1)].focus();
    else if (event.key === 'ArrowUp') (rows[index - 1] || input).focus();
    else if (event.key === 'Enter' && event.target === input) rows[0].click();
    else return;
    event.preventDefault();
  });

  return {
    show(target, { names = false, attachFile = false } = {}) {
      if (!target || dialog.open) return;
      scope = target;
      reference = attachFile;
      chosen = false;
      $('projectSearchTitle').textContent = reference ? '引用项目文件' : '搜索项目';
      setKind(names || reference ? 'files' : 'content');
      input.value = '';
      search();
      dialog.showModal();
      input.focus();
    },
    close() { if (dialog.open) dialog.close(); }
  };
}

function createGitBrowser({ $, api, errorMessage, openFile, onReview, hasUnsaved, onBranchChanged }) {
  let scope, status = null, loaded = false, loading = false, loadSequence = 0, diffSequence = 0, actionBusy = false, selected;
  const dialog = $('gitDialog');
  const commitDialog = $('gitCommitDialog');
  const commitForm = $('gitCommitForm');
  const commitButton = $('gitCommitNow');
  const reloadCommit = $('reloadGitCommit');
  const reviewCommit = $('reviewGitCommit');
  let commitPreview = null;
  const indexAction = $('gitIndexAction');
  const agentReview = $('gitReviewAgent');
  const gitStatusLabel = ({ index, worktree, conflict }, kind) => {
    if (conflict) return ['冲突', '!'];
    const code = kind === 'staged' ? index : worktree;
    return [{ '?': '未跟踪', A: '新增', M: '修改', D: '删除', T: '类型变更' }[code] || '改动', code];
  };

  function render() {
    $('gitBranch').textContent = status?.available ? (status.branch === 'HEAD' ? '分离的 HEAD' : status.branch) : 'Git 改动';
    $('gitBranch').title = status?.branch || '';
    $('openGitBranches').hidden = !status?.available || status.scoped;
    $('workspaceGitButton').classList.toggle('has-changes', Boolean(status?.total));
    const target = $('gitEntries');
    target.replaceChildren();
    $('openGitCommit').disabled = loading;
    $('openGitCommit').hidden = !status?.available || status.scoped || !status.rows.some(row => !row.conflict && row.index !== ' ' && row.index !== '?');
    if (!status?.available) return;
    const groups = [
      { title: '未暂存', kind: 'working', rows: status.rows.filter(row => row.worktree !== ' ' || row.conflict) },
      { title: '已暂存', kind: 'staged', rows: status.rows.filter(row => row.index !== ' ' && row.index !== '?' && !row.conflict) }
    ];
    for (const group of groups) {
      if (!group.rows.length) continue;
      const label = document.createElement('h3');
      label.className = 'git-group-title';
      label.textContent = `${group.title} · ${group.rows.length}`;
      target.append(label);
      for (const row of group.rows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'git-entry';
        button.dataset.path = row.path;
        const [description, code] = gitStatusLabel(row, group.kind);
        button.title = `${row.path} · ${description}`;
        const name = document.createElement('span');
        name.className = 'git-entry-name';
        const filename = document.createElement('strong');
        filename.textContent = row.path.split('/').at(-1);
        name.append(filename);
        if (row.path.includes('/')) {
          const parent = document.createElement('small');
          parent.textContent = row.path.slice(0, row.path.lastIndexOf('/'));
          name.append(parent);
        }
        const badge = document.createElement('span');
        badge.className = 'git-entry-badge';
        badge.dataset.code = code;
        badge.textContent = code;
        badge.setAttribute('aria-label', description);
        button.append(workspaceIcon('file'), name, badge);
        button.onclick = () => void showDiff(row, group.kind);
        target.append(button);
      }
    }
  }

  async function refresh() {
    if (!scope) return;
    const sequence = ++loadSequence;
    loading = $('openGitCommit').disabled = true;
    $('gitStatus').textContent = '正在检查工作区…';
    try {
      const result = await api.workspace.gitStatus(scope.target);
      if (sequence !== loadSequence) return;
      status = result;
      $('gitStatus').textContent = !status.available ? (status.missing ? '此电脑尚未安装 Git。' : '当前目录没有 Git 仓库。') : !status.total ? '工作区干净' : `${status.total} 个文件${status.scoped ? ' · 当前目录' : ''}${status.total > status.rows.length ? ` · 显示前 ${status.rows.length} 项` : ''}`;
    } catch (error) {
      if (sequence !== loadSequence) return;
      status = null;
      $('gitStatus').textContent = errorMessage(error);
    } finally {
      if (sequence === loadSequence) { loading = false; loaded = true; render(); }
    }
  }

  function renderPatch(patch, target = $('gitDiffBody')) {
    const fragment = document.createDocumentFragment();
    let before, after;
    for (const line of patch.trimEnd().split('\n')) {
      const section = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (line.startsWith('diff --git ')) before = after = undefined;
      if (section) {
        before = Number(section[1]);
        after = Number(section[2]);
      }
      const type = before !== undefined && line.startsWith('+') ? 'add' : before !== undefined && line.startsWith('-') ? 'remove' : '';
      const context = before !== undefined && line.startsWith(' ');
      const row = document.createElement('div');
      row.className = `diff-row ${type ? `diff-${type}` : context ? '' : 'git-diff-meta'}`;
      const counts = type === 'add' ? ['', after++] : type === 'remove' ? [before++, ''] : context ? [before++, after++] : ['', ''];
      for (const value of counts) {
        const number = document.createElement('span');
        number.className = 'diff-number';
        number.textContent = value;
        number.setAttribute('aria-hidden', 'true');
        row.append(number);
      }
      const code = document.createElement('code');
      code.textContent = line;
      row.append(code);
      fragment.append(row);
    }
    const content = document.createElement('div');
    content.className = 'git-patch';
    content.append(fragment);
    target.replaceChildren(content);
  }

  async function showDiff(row, kind) {
    if (!scope || dialog.open) return;
    const sequence = ++diffSequence;
    const target = scope.target;
    selected = { row, kind, target, revision: null };
    $('gitReviewTitle').textContent = kind === 'staged' ? '已暂存的改动' : '工作区改动';
    $('gitReviewPath').textContent = row.path;
    $('gitReviewPath').title = row.path;
    $('gitOpenFile').hidden = row.worktree === 'D';
    $('gitDiffBody').replaceChildren();
    $('gitDiffStatus').textContent = '正在读取差异…';
    indexAction.hidden = agentReview.hidden = true;
    dialog.showModal();
    $('gitDiffBody').focus();
    try {
      const result = await api.workspace.gitDiff({ ...target, path: row.path, kind });
      if (!dialog.open || sequence !== diffSequence) return;
      selected.revision = result.revision;
      if (result.patch) renderPatch(result.patch);
      $('gitDiffStatus').textContent = result.conflict ? '此文件存在合并冲突。' : result.unavailable ? '此改动没有可显示的文本差异。' : result.patch ? '' : '当前没有差异，请刷新列表。';
      indexAction.textContent = kind === 'staged' ? '取消暂存' : '暂存文件';
      indexAction.hidden = !result.revision;
      agentReview.hidden = !result.revision;
    } catch (error) {
      if (sequence === diffSequence) $('gitDiffStatus').textContent = errorMessage(error);
    }
  }

  indexAction.onclick = async () => {
    if (!selected?.revision || actionBusy) return;
    const { target, row, kind, revision } = selected;
    actionBusy = indexAction.disabled = true;
    try {
      await api.workspace.gitIndex({ ...target, path: row.path, kind: kind === 'staged' ? 'unstage' : 'stage', revision });
      dialog.close();
      await refresh();
      [...$('gitEntries').querySelectorAll('button')].find(item => item.dataset.path === row.path)?.focus();
    } catch (error) {
      $('gitDiffStatus').textContent = errorMessage(error);
      indexAction.hidden = true;
    } finally { actionBusy = indexAction.disabled = false; }
  };
  agentReview.onclick = async () => {
    if (!selected?.revision || actionBusy) return;
    const { target, row, kind, revision } = selected;
    actionBusy = agentReview.disabled = indexAction.disabled = true;
    try {
      if (await onReview({ ...target, path: row.path, kind, revision })) dialog.close();
    } catch (error) {
      $('gitDiffStatus').textContent = errorMessage(error);
    } finally { actionBusy = agentReview.disabled = indexAction.disabled = false; }
  };
  $('closeGitDialog').onclick = () => { if (!actionBusy) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (actionBusy) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++diffSequence; selected = null; $('gitDiffBody').replaceChildren(); });
  $('gitOpenFile').onclick = () => {
    const relative = selected?.row.path;
    if (actionBusy) return;
    dialog.close();
    if (relative) void openFile(relative);
  };
  $('refreshGit').onclick = refresh;

  async function loadCommit(target) {
    const pending = { target };
    commitPreview = pending;
    commitButton.disabled = true;
    reloadCommit.hidden = reviewCommit.hidden = true;
    $('gitCommitBranch').textContent = '';
    $('gitCommitPatch').replaceChildren();
    $('gitCommitStatus').textContent = '正在读取暂存区…';
    try {
      const preview = await api.workspace.gitCommitPreview(target);
      if (commitPreview !== pending || !commitDialog.open) return;
      Object.assign(pending, preview);
      $('gitCommitBranch').textContent = preview.branch;
      renderPatch(preview.patch, $('gitCommitPatch'));
      $('gitCommitStatus').textContent = '需要运行 Git hooks 时，请在终端提交。';
      commitButton.disabled = false;
      reviewCommit.hidden = false;
      $('gitCommitMessage').focus();
    } catch (error) {
      if (commitPreview === pending && commitDialog.open) {
        $('gitCommitStatus').textContent = errorMessage(error);
        reloadCommit.hidden = false;
      }
    }
  }
  $('openGitCommit').onclick = () => {
    if (!scope || commitDialog.open || loading) return;
    commitForm.reset();
    commitDialog.showModal();
    void loadCommit(scope.target);
  };
  reloadCommit.onclick = () => { if (commitPreview && !actionBusy) void loadCommit(commitPreview.target); };
  reviewCommit.onclick = async () => {
    if (!commitPreview?.revision || actionBusy) return;
    const { target, revision } = commitPreview;
    actionBusy = reviewCommit.disabled = $('closeGitCommit').disabled = commitButton.disabled = true;
    try {
      if (await onReview({ ...target, kind: 'staged-set', revision })) commitDialog.close();
    } catch (error) {
      $('gitCommitStatus').textContent = errorMessage(error);
      reloadCommit.hidden = false;
    } finally {
      actionBusy = reviewCommit.disabled = $('closeGitCommit').disabled = false;
      commitButton.disabled = !commitPreview?.revision;
    }
  };
  commitForm.onsubmit = async event => {
    event.preventDefault();
    const message = $('gitCommitMessage').value.trim();
    if (actionBusy || !commitPreview?.revision || !message || commitButton.disabled) return;
    actionBusy = reviewCommit.disabled = $('closeGitCommit').disabled = commitButton.disabled = true;
    try {
      const { target, revision } = commitPreview;
      const result = await api.workspace.gitCommit({ ...target, revision, message });
      commitDialog.close();
      await refresh();
      if (scope?.target === target) $('gitStatus').textContent = `已创建本地提交 ${result.commit.slice(0, 8)}`;
      $('refreshGit').focus({ preventScroll: true });
    } catch (error) {
      $('gitCommitStatus').textContent = errorMessage(error);
      reloadCommit.hidden = false;
    } finally { actionBusy = reviewCommit.disabled = $('closeGitCommit').disabled = false; }
  };
  $('closeGitCommit').onclick = () => { if (!actionBusy) commitDialog.close(); };
  commitDialog.addEventListener('cancel', event => { if (actionBusy) event.preventDefault(); });
  commitDialog.addEventListener('close', () => { commitPreview = null; $('gitCommitPatch').replaceChildren(); });

  const branchDialog = $('gitBranchDialog');
  const branchSelect = $('gitBranchSelect');
  const branchName = $('gitBranchName');
  let branchView;
  function branchFeedback(text, error = false) {
    $('gitBranchStatus').textContent = text;
    $('gitBranchStatus').classList.toggle('error', error);
  }
  function syncBranchControls() {
    const ready = Boolean(branchView?.snapshot?.head) && !actionBusy;
    branchSelect.disabled = !ready || branchSelect.options.length <= 1;
    branchName.disabled = !ready;
    $('gitSwitchNow').disabled = !ready || !branchSelect.value;
    $('gitCreateBranch').disabled = !ready || !branchName.value.trim();
    $('closeGitBranch').disabled = actionBusy;
  }
  $('openGitBranches').onclick = async () => {
    if (!scope || actionBusy || branchDialog.open) return;
    const view = branchView = { target: scope.target };
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择分支';
    branchSelect.replaceChildren(placeholder);
    branchName.value = '';
    $('gitBranchCurrent').textContent = '';
    branchFeedback('正在读取本地分支…');
    syncBranchControls();
    branchDialog.showModal();
    try {
      const snapshot = await api.workspace.gitBranches(view.target);
      if (!branchDialog.open || branchView !== view) return;
      view.snapshot = snapshot;
      const name = snapshot.branch || '分离的 HEAD';
      $('gitBranchCurrent').textContent = `当前分支 ${name}${snapshot.head ? ` · ${snapshot.head.slice(0, 8)}` : ''}`;
      for (const branch of snapshot.branches) {
        if (branch.name === snapshot.branch) continue;
        const option = document.createElement('option');
        option.value = branch.name;
        option.textContent = branch.name;
        branchSelect.append(option);
      }
      branchFeedback(!snapshot.head ? '创建首次提交后即可管理分支。' : snapshot.limited ? '仅显示前 250 个本地分支。' : '切换前请保存编辑并处理 Git 工作区改动。');
      syncBranchControls();
      (branchSelect.disabled ? branchName : branchSelect).focus({ preventScroll: true });
    } catch (error) { if (branchDialog.open && branchView === view) branchFeedback(errorMessage(error), true); }
  };
  async function switchBranch(event, create) {
    event.preventDefault();
    const view = branchView;
    if (actionBusy || !view?.snapshot || view.target !== scope?.target) return;
    const branch = create ? branchName.value.trim() : branchSelect.value;
    if (!branch) return;
    if (hasUnsaved()) {
      branchFeedback('有未保存的编辑，请先保存或放弃后再切换分支。', true);
      return;
    }
    actionBusy = true;
    syncBranchControls();
    branchFeedback(create ? '正在新建并切换…' : '正在切换分支…');
    try {
      const commit = view.snapshot.branches.find(item => item.name === branch)?.commit;
      const result = await api.workspace.gitSwitch({ ...view.target, branch, create, commit, revision: view.snapshot.revision });
      if (scope?.target !== view.target) return;
      branchDialog.close();
      onBranchChanged();
      await refresh();
      if (scope?.target !== view.target) return;
      $('gitStatus').textContent = `${result.created ? '已新建并切换到' : '已切换到'} ${result.branch}`;
      $('openGitBranches').focus({ preventScroll: true });
    } catch (error) { if (branchView === view) branchFeedback(errorMessage(error), true); }
    finally { actionBusy = false; syncBranchControls(); }
  }
  $('gitSwitchForm').onsubmit = event => switchBranch(event, false);
  $('gitBranchCreateForm').onsubmit = event => switchBranch(event, true);
  branchSelect.onchange = branchName.oninput = syncBranchControls;
  $('closeGitBranch').onclick = () => { if (!actionBusy) branchDialog.close(); };
  branchDialog.addEventListener('cancel', event => { if (actionBusy) event.preventDefault(); });
  branchDialog.addEventListener('close', () => { if (!branchDialog.open) branchView = null; });

  return {
    setScope(next) {
      if (scope?.key === next?.key) return;
      ++loadSequence;
      scope = next;
      status = null;
      loaded = loading = false;
      $('gitStatus').textContent = '';
      if (dialog.open) dialog.close();
      if (commitDialog.open) commitDialog.close();
      if (branchDialog.open) branchDialog.close();
      render();
    },
    show() { if (!loaded && !loading) void refresh(); },
    invalidate() {
      if ($('gitBrowser').hidden || $('taskPane').hidden) { ++loadSequence; loaded = loading = false; }
      else void refresh();
    }
  };
}
