'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { relativeSegments, previewWorkspace } = require('./workspace-files');
const { createTwoFilesPatch } = require('diff');

const exec = promisify(execFile);
const maxDiff = 192 * 1024;
const maxStatus = 350;
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--submodule=short', '--ignore-submodules=dirty', '--unified=3'];
const fixedConfig = ['core.fsmonitor=false', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), 'core.untrackedCache=false'];
// Inherit PATH and locale, but never alternate repositories, indexes or command configuration.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
Object.assign(gitEnv, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: '' });

async function git(cwd, args, { config = [], signal, limit = 1024 * 1024 } = {}) {
  return (await exec('git', ['--no-pager', '--literal-pathspecs', ...[...fixedConfig, ...config].flatMap(value => ['-c', value]), '-C', cwd, ...args], {
    timeout: 6000, windowsHide: true, encoding: 'buffer', maxBuffer: limit, env: gitEnv, signal
  })).stdout;
}

async function findRepository(workspace, signal) {
  if (await fs.realpath(workspace) !== workspace) throw Error('工作目录已移动，请重新选择');
  try {
    const output = await git(workspace, ['rev-parse', '--show-toplevel'], { signal });
    const root = await fs.realpath(output.toString('utf8').replace(/\r?\n$/, ''));
    const offset = path.relative(root, workspace);
    if (path.isAbsolute(offset) || offset === '..' || offset.startsWith(`..${path.sep}`)) return null;
    return { root, prefix: offset ? offset.split(path.sep).join('/') + '/' : '' };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') return { missing: true };
    if (String(error.stderr || '').includes('not a git repository')) return null;
    throw Error('无法读取工作区的 Git 仓库');
  }
}

function insideScope(name, prefix) {
  if (!name.startsWith(prefix)) return '';
  const relative = name.slice(prefix.length);
  try { relativeSegments(relative); return relative === '.' ? '' : relative; }
  catch { return ''; }
}

async function gitCandidates(workspace, { signal } = {}) {
  const repo = await findRepository(workspace, signal);
  if (!repo || repo.missing) return null;
  try {
    const output = await git(repo.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', repo.prefix || '.'], { signal });
    return [...new Set(output.toString('utf8').split('\0').map(name => insideScope(name, repo.prefix)).filter(Boolean))];
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { tooLarge: true };
    throw error;
  }
}

async function filterOverrides(repo, signal) {
  const names = await git(repo.root, ['config', '--list', '--name-only', '--null'], { signal });
  const prefixes = new Set(names.toString('utf8').split('\0').flatMap(key => {
    const match = /^(filter\..+)\.(?:clean|smudge|process|required)$/.exec(key);
    return match ? [match[1]] : [];
  }));
  if (prefixes.size > 100) throw Error('Git 内容过滤器配置过多');
  return [...prefixes].flatMap(key => [`${key}.clean=`, `${key}.smudge=`, `${key}.process=`, `${key}.required=false`]);
}

function parseStatus(output, prefix = '') {
  return output.toString('utf8').split('\0').flatMap(item => {
    if (item.length < 4 || item[2] !== ' ') return [];
    const name = insideScope(item.slice(3), prefix);
    if (!name) return [];
    const [index, worktree] = item;
    const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + worktree);
    return [{ path: name, index, worktree, conflict }];
  });
}

async function statusFor(repo, config, signal, specific) {
  const output = await git(repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=dirty', '--', specific || repo.prefix || '.'], { config, signal });
  return parseStatus(output, repo.prefix);
}

async function gitStatus(workspace) {
  const repo = await findRepository(workspace);
  if (!repo || repo.missing) return { available: false, missing: Boolean(repo?.missing) };
  const config = await filterOverrides(repo);
  const [branch, rows] = await Promise.all([
    git(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => git(repo.root, ['symbolic-ref', '--short', 'HEAD'])),
    statusFor(repo, config)
  ]);
  return { available: true, branch: branch.toString('utf8').trim(), rows: rows.slice(0, maxStatus), total: rows.length, scoped: Boolean(repo.prefix) };
}

function assertChangePath(relative) {
  if (!relativeSegments(relative).length || relative.includes('\uFFFD')) throw Error('无效的 Git 文件路径');
}

async function gitDiff(workspace, relative, kind) {
  assertChangePath(relative);
  if (!['staged', 'working'].includes(kind)) throw Error('无效的 Git 差异类型');
  const repo = await findRepository(workspace);
  if (!repo || repo.missing) throw Error('此工作区没有 Git 仓库');
  const config = await filterOverrides(repo);
  const file = repo.prefix + relative;
  const [row] = (await statusFor(repo, config, undefined, file)).filter(entry => entry.path === relative);
  if (!row) return { patch: '', revision: null };
  if (row.conflict) return { patch: '', conflict: true, revision: null };
  let patch;
  try {
    if (row.index === '?' && kind === 'working') {
      // Use a snapshot of regular text instead of `git diff --no-index`, which can read through symlinks.
      const text = await previewWorkspace(workspace, relative);
      if (!text.revision) return { patch: '', unavailable: true, revision: null };
      patch = Buffer.from(createTwoFilesPatch('/dev/null', `b/${file}`, '', text.text, '', '', { context: 3 }));
    } else {
      patch = await git(repo.root, ['diff', ...diffOptions, ...(kind === 'staged' ? ['--cached'] : []), '--', file], { config, limit: maxDiff });
    }
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { patch: '', unavailable: true, revision: null };
    throw error;
  }
  if (!patch.length || patch.length > maxDiff) return { patch: '', unavailable: patch.length > maxDiff, revision: null };
  const revision = createHash('sha256').update(row.index + row.worktree + '\0').update(patch).digest('hex');
  return { patch: patch.toString('utf8'), revision };
}

async function updateIndex(workspace, relative, kind, revision, verifyScope) {
  assertChangePath(relative);
  if (!['stage', 'unstage'].includes(kind) || !/^[a-f0-9]{64}$/.test(revision || '')) throw Error('请先打开并审阅这份改动');
  const repo = await findRepository(workspace);
  if (!repo || repo.missing) throw Error('此工作区没有 Git 仓库');
  const config = await filterOverrides(repo);
  const file = repo.prefix + relative;
  if (kind === 'stage') {
    const attributes = await git(repo.root, ['check-attr', '-z', 'filter', '--', file], { config });
    const stat = await fs.lstat(path.join(workspace, ...relativeSegments(relative))).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw Error('请选择一个文件，目录和子模块需要在终端中管理');
    const filter = attributes.toString('utf8').split('\0')[2];
    if (filter && filter !== 'unspecified' && filter !== 'unset') throw Error('此文件使用 Git 内容过滤器，请在可信终端中暂存');
  }
  const current = await gitDiff(workspace, relative, kind === 'stage' ? 'working' : 'staged');
  if (current.revision !== revision) throw Error('Git 改动已变化，请刷新并重新审阅');
  verifyScope?.();
  if (kind === 'stage') {
    await git(repo.root, ['add', '--', file], { config });
    return;
  }
  const hasHead = await git(repo.root, ['rev-parse', '--verify', 'HEAD']).then(() => true, error => {
    if (error.code === 128 && String(error.stderr).includes('Needed a single revision')) return false;
    throw error;
  });
  verifyScope?.();
  await git(repo.root, hasHead ? ['restore', '--staged', '--', file] : ['rm', '--cached', '--', file], { config });
}

const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const gitText = async (root, args, options) => (await git(root, args, options)).toString('utf8').trim();

async function assertGitIdle(root) {
  const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG'];
  const gitDirectory = (await git(root, ['rev-parse', '--absolute-git-dir'])).toString('utf8').replace(/\r?\n$/, '');
  for (const name of operations) {
    const location = path.join(gitDirectory, name);
    if (await fs.stat(location).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw Error('Git 正在合并、变基或执行其他操作，请先在终端处理');
    }
  }
}

async function stagedSnapshot(workspace) {
  const repo = await findRepository(workspace);
  if (!repo || repo.missing || repo.prefix) throw Error('请打开 Git 仓库根目录后再提交');
  const root = repo.root;
  const ref = await gitText(root, ['symbolic-ref', '-q', 'HEAD']).catch(() => '');
  if (!ref.startsWith('refs/heads/')) throw Error('请先切换到一个本地分支再提交');
  await assertGitIdle(root);
  const signing = await gitText(root, ['config', '--bool', '--get', 'commit.gpgsign']).catch(error => {
    if (error.code === 1) return '';
    throw error;
  });
  if (signing === 'true') throw Error('此仓库启用了提交签名，请在终端提交');
  const parent = await gitText(root, ['rev-parse', '--verify', '-q', ref]).catch(error => {
    if (error.code === 1) return '';
    throw error;
  });
  const tree = await gitText(root, ['write-tree']).catch(() => { throw Error('无法读取暂存区，请先解决未合并的文件'); });
  if (!oid.test(tree) || (parent && !oid.test(parent))) throw Error('无法识别暂存区或分支版本');
  const revision = createHash('sha256').update([root, ref, parent, tree].join('\0')).digest('hex');
  return { root, ref, parent, tree, revision };
}

async function gitCommitPreview(workspace) {
  const snapshot = await stagedSnapshot(workspace);
  const { root, ref, parent, tree, revision } = snapshot;
  const emptyTree = createHash(tree.length === 40 ? 'sha1' : 'sha256').update('tree 0\0').digest('hex');
  let patch;
  try {
    patch = await git(root, ['diff', ...diffOptions, parent || emptyTree, tree, '--'], { limit: maxDiff });
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw Error('暂存差异超过审阅上限，请分批提交或使用终端');
    throw error;
  }
  if (!patch.length) throw Error('暂存区没有可提交的改动');
  return { branch: ref.slice('refs/heads/'.length), patch: patch.toString('utf8'), revision };
}

async function commitStaged(workspace, revision, message, verifyScope) {
  if (!/^[a-f0-9]{64}$/.test(revision || '') || typeof message !== 'string' || !message.trim()
      || message.length > 2000 || message.includes('\0')) throw Error('请审阅暂存区，并填写 1 至 2,000 字符的提交说明');
  const { root, ref, parent, tree, revision: current } = await stagedSnapshot(workspace);
  if (current !== revision) throw Error('暂存区或分支已变化，请重新审阅');
  verifyScope?.();
  let commit;
  try {
    commit = await gitText(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message.trim()]);
  } catch (error) {
    if (/identity|user\.email|user\.name/i.test(String(error.stderr))) throw Error('请先在 Git 中配置提交身份');
    throw Error('无法创建提交，请检查 Git 仓库状态');
  }
  if (!oid.test(commit)) throw Error('无法读取新提交编号');
  verifyScope?.();
  try {
    await git(root, ['update-ref', '--no-deref', '-m', `commit: ${message.trim().split(/\r?\n/, 1)[0].slice(0, 500)}`, ref, commit, parent || '0'.repeat(tree.length)]);
  } catch { throw Error('分支已变化或正在被其他应用更新，请重新审阅'); }
  return { commit, branch: ref.slice('refs/heads/'.length) };
}

async function branchHead(root) {
  const ref = await gitText(root, ['symbolic-ref', '-q', 'HEAD']).catch(() => '');
  const head = await gitText(root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
  return {
    branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '',
    head,
    revision: createHash('sha256').update([root, ref, head].join('\0')).digest('hex')
  };
}

async function branchRoot(workspace) {
  const repo = await findRepository(workspace);
  if (!repo || repo.missing || repo.prefix) throw Error('请打开 Git 仓库根目录后再管理分支');
  return repo;
}

async function gitBranches(workspace) {
  const { root } = await branchRoot(workspace);
  const current = await branchHead(root);
  const listed = await gitText(root, ['for-each-ref', '--count=251', '--sort=refname', '--format=%(refname:lstrip=2)%00%(objectname)', 'refs/heads/']);
  const branches = listed.split('\n').filter(Boolean).map(line => {
    const [name, commit] = line.split('\0');
    return { name, commit };
  });
  return { ...current, branches: branches.slice(0, 250), limited: branches.length > 250 };
}

async function switchGitBranch(workspace, { branch, create, revision, commit }, verifyScope) {
  if (typeof branch !== 'string' || branch.startsWith('-') || Buffer.byteLength(branch) > 240 || typeof create !== 'boolean') {
    throw Error('请输入有效的 Git 分支名');
  }
  const repo = await branchRoot(workspace);
  const { root } = repo;
  const ref = `refs/heads/${branch}`;
  try { await git(root, ['check-ref-format', ref]); }
  catch { throw Error('请输入有效的 Git 分支名'); }
  const config = await filterOverrides(repo);
  await assertGitIdle(root);
  const current = await branchHead(root);
  if (!current.head) throw Error('请先创建首次提交');
  if (current.revision !== revision) throw Error('当前分支已变化，请重新打开分支管理');
  const worktree = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'], { config });
  if (worktree.length) throw Error('Git 工作区有改动。请先提交或在终端妥善处理改动，再切换分支');
  const target = await gitText(root, ['show-ref', '--verify', '--hash', ref]).catch(() => '');
  if (create ? Boolean(target) : !oid.test(commit || '') || target !== commit) {
    throw Error(create ? '此本地分支已存在' : '目标分支已变化，请重新打开分支管理');
  }
  if (!create && config.length && current.head !== target) {
    const paths = (await git(root, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', current.head, target, '--'], { limit: 64000 })).toString('utf8').split('\0').filter(Boolean);
    if (paths.length) {
      const attributes = await git(root, ['check-attr', `--source=${target}`, '-z', 'filter', '--', ...paths]);
      const usesFilter = attributes.toString('utf8').split('\0').some((value, i) =>
        i % 3 === 2 && value !== 'unspecified' && value !== 'unset');
      if (usesFilter) throw Error('目标分支使用 Git 内容过滤器，请在终端切换');
    }
  }
  verifyScope?.();
  try {
    await git(root, ['switch', '--no-guess', '--no-recurse-submodules', '--no-overwrite-ignore', ...(create ? ['--no-track', '--create', branch] : [branch])], { config });
  } catch (error) {
    const reason = String(error.stderr || '');
    if (/would be overwritten/.test(reason)) throw Error('切换会覆盖本机文件，请在处理冲突后重试');
    if (/already (?:checked out|used by worktree)/.test(reason)) throw Error('该分支正在另一个 Git 工作树中使用');
    throw Error('Git 无法切换分支，请刷新并检查当前分支状态');
  }
  return { branch, created: create };
}

module.exports = { gitCandidates, gitStatus, gitDiff, updateIndex, gitCommitPreview, commitStaged, gitBranches, switchGitBranch };
