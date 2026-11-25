'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { previewWorkspace } = require('../src/workspace-files');
const { createWorkspaceFile, saveWorkspaceFile, workspaceAttachment } = require('../src/workspace-editor');
const { searchWorkspace } = require('../src/workspace-search');
const { gitStatus, gitDiff, updateIndex, gitCommitPreview, commitStaged, gitBranches, switchGitBranch } = require('../src/workspace-git');
const { createTools } = require('../src/tools');

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
async function fixture(t, withGit = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xx-workbench-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  if (withGit) {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Workbench fixture');
    git(root, 'config', 'user.email', 'fixture@local.invalid');
    git(root, 'config', 'commit.gpgsign', 'false');
  }
  const write = (file, text) => fs.writeFile(path.join(root, file), text);
  return { directory, root, write };
}

test('editor saves original line endings and permissions, detects stale versions and validates selected ranges', async t => {
  const { root, write } = await fixture(t);
  const filename = 'src/app.js';
  const file = path.join(root, filename);
  await write(filename, 'const a = 1;\r\nconst b = 2;\r\n');
  await fs.chmod(file, 0o755);
  const version = await previewWorkspace(root, filename);
  const slice = await workspaceAttachment(root, filename, version.revision, { from: 0, to: 13 });
  assert.equal(slice.name, 'src/app.js:1');
  assert.equal(slice.text, 'const a = 1;\n');
  await assert.rejects(workspaceAttachment(root, filename, version.revision, { from: 1, to: 999 }), /范围/);
  const newVersion = await saveWorkspaceFile(root, filename, version.revision, version.text.replace('a = 1', 'a = 3'));
  assert.notEqual(newVersion.revision, version.revision);
  assert.equal(await fs.readFile(file, 'utf8'), 'const a = 3;\r\nconst b = 2;\r\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
  await assert.rejects(saveWorkspaceFile(root, filename, version.revision, 'another change'), /磁盘上的文件已变化/);
  assert.equal(await fs.readFile(file, 'utf8'), newVersion.text);
  await assert.rejects(workspaceAttachment(root, filename, version.revision), /文件已更新/);
});

test('project search honors Git ignores, excludes typical credential files and returns literal matching lines', async t => {
  const { root, directory, write } = await fixture(t, true);
  await write('.gitignore', 'ignored/\n');
  await fs.mkdir(path.join(root, 'ignored'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await write('ignored/plain.txt', 'needle[1] not in index');
  await write('node_modules/dep.js', 'needle[1] dependency');
  await write('.env.local', 'needle[1] credential');
  await write('src/match[1].js', 'first\nneedle[1] nested\n');
  await write('outside.txt', 'needle[1] another file');
  await fs.writeFile(path.join(directory, 'external.txt'), 'needle[1] outside workspace');
  await fs.symlink(path.join(directory, 'external.txt'), path.join(root, 'outside-link.txt'));
  const result = await searchWorkspace(root, { query: 'NEEDLE[1]' });
  assert.deepEqual(result.matches.map(({ path, line }) => [path, line]), [['outside.txt', 1], ['src/match[1].js', 2]]);
  const scoped = await searchWorkspace(path.join(root, 'src'), { query: 'match[1]', kind: 'files' });
  assert.deepEqual(scoped.matches, [{ path: 'match[1].js' }]);
  await assert.rejects(searchWorkspace(root, { query: '\nx\ny' }), /搜索词/);
  const cancelled = AbortSignal.abort();
  await assert.rejects(searchWorkspace(root, { query: 'match', signal: cancelled }), { name: 'AbortError' });
});

test('Git stages literal paths, protects the worktree and avoids stale diffs and unrelated directories', async t => {
  const { root, write } = await fixture(t, true);
  await write('src/view[1] .js', 'const price = 10;\n');
  await write('outside.txt', 'original\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Create fixture');
  await write('src/view[1] .js', 'const price = 12;\n');
  await write('outside.txt', 'outside\n');
  const folder = path.join(root, 'src');
  const result = await gitStatus(folder);
  assert.equal(result.scoped, true);
  assert.deepEqual(result.rows.map(row => row.path), ['view[1] .js']);
  const preview = await gitDiff(folder, 'view[1] .js', 'working');
  assert.match(preview.patch, /\+const price = 12;/);
  await write('src/view[1] .js', 'const price = 15;\n');
  await assert.rejects(updateIndex(folder, 'view[1] .js', 'stage', preview.revision), /已变化/);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  const fresh = await gitDiff(folder, 'view[1] .js', 'working');
  await updateIndex(folder, 'view[1] .js', 'stage', fresh.revision);
  const staged = await gitDiff(folder, 'view[1] .js', 'staged');
  assert.match(staged.patch, /\+const price = 15;/);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'src/view[1] .js');
  await updateIndex(folder, 'view[1] .js', 'unstage', staged.revision);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  assert.equal(await fs.readFile(path.join(folder, 'view[1] .js'), 'utf8'), 'const price = 15;\n');
  await assert.rejects(gitDiff(folder, '../outside.txt', 'working'), /无效/);
});

test('local commits use the reviewed staged tree, retain unstaged text, and reject changed snapshots', async t => {
  const { root, write } = await fixture(t, true);
  await write('src/app.js', 'const version = 1;\n');
  git(root, 'add', '.');
  const first = await gitCommitPreview(root);
  assert.match(first.patch, /^\+const version = 1;/m);
  const { commit } = await commitStaged(root, first.revision, 'Create project');
  assert.equal(git(root, 'rev-parse', 'HEAD'), commit);

  await write('src/app.js', 'const version = 2;\n');
  git(root, 'add', '.');
  const stale = await gitCommitPreview(root);
  await write('src/app.js', 'const version = 3;\n');
  git(root, 'add', '.');
  await assert.rejects(commitStaged(root, stale.revision, 'Stale submission'), /已变化/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), commit);

  await assert.rejects(gitCommitPreview(path.join(root, 'src')), /根目录/);
  const reviewed = await gitCommitPreview(root);
  await write('src/app.js', 'const version = 4;\n');
  await commitStaged(root, reviewed.revision, 'Review staged changes');
  assert.equal(git(root, 'show', 'HEAD:src/app.js'), 'const version = 3;');
  assert.match(await fs.readFile(path.join(root, 'src/app.js'), 'utf8'), /version = 4/);
  assert.equal(git(root, 'status', '--porcelain'), 'M src/app.js');
  await assert.rejects(gitCommitPreview(root), /没有可提交/);
});

test('Git checks and diff do not execute the repository content filter or external diff on read', async t => {
  const { root, write, directory } = await fixture(t, true);
  await write('app.js', 'initial\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Create fixture');
  await write('.gitattributes', '*.js filter=example\n');
  await write('app.js', 'newer\n');
  const marker = path.join(directory, 'filter-executed');
  git(root, 'config', 'filter.example.clean', `touch '${marker}'; cat`);
  git(root, 'config', 'filter.example.required', 'true');
  git(root, 'config', 'diff.external', `touch '${marker}'`);
  assert((await gitStatus(root)).rows.some(row => row.path === 'app.js'));
  const review = await gitDiff(root, 'app.js', 'working');
  assert.match(review.patch, /\+newer/);
  await assert.rejects(updateIndex(root, 'app.js', 'stage', review.revision), /内容过滤器/);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('Agent targeted edits retain the rest of a large file and recheck it after review', async t => {
  const { root, write } = await fixture(t);
  const original = '// ' + 'context '.repeat(3000) + '\nconst status = "pending";\nconst retries = 1;\n';
  await write('src/app.js', original);
  const approvals = [];
  let duringReview = async () => {};
  const edit = (await createTools({ workspace: root, async approve(context) { approvals.push(context); await duringReview(); return true; } })).find(tool => tool.name === 'edit_file');
  await assert.rejects(edit.execute({ path: 'src/app.js', edits: [{ old_text: 'context', new_text: 'changed' }] }), /exactly one/);
  assert.equal(approvals.length, 0);
  const changes = { path: 'src/app.js', edits: [{ old_text: 'const retries = 1;', new_text: 'const retries = 2;' }] };
  duringReview = () => write('src/app.js', original + '// disk\n');
  await assert.rejects(edit.execute(changes), { code: 'WORKSPACE_CHANGED' });
  assert.equal(await fs.readFile(path.join(root, 'src/app.js'), 'utf8'), original + '// disk\n');
  duringReview = async () => {};
  await edit.execute(changes);
  assert.equal(await fs.readFile(path.join(root, 'src/app.js'), 'utf8'), original.replace('retries = 1', 'retries = 2') + '// disk\n');
  assert.deepEqual(approvals.at(-1).review.counts, { add: 1, remove: 1 });
  assert.deepEqual((await createTools({ workspace: root, readOnly: true })).map(tool => tool.name).sort(), ['list_files', 'read_file', 'search_workspace']);
});


test('creating a project file cannot replace an existing file or reach a linked folder', async t => {
  const { directory, root, write } = await fixture(t);
  const filename = 'src/new.js';
  await createWorkspaceFile(root, filename);
  assert.equal(await fs.readFile(path.join(root, filename), 'utf8'), '');
  await write(filename, 'keep this content');
  await assert.rejects(createWorkspaceFile(root, filename), /已存在/);
  assert.equal(await fs.readFile(path.join(root, filename), 'utf8'), 'keep this content');
  await assert.rejects(createWorkspaceFile(root, 'src/other/new.js'), /先创建/);
  await assert.rejects(createWorkspaceFile(root, '../outside.js'), /无效/);
  if (process.platform !== 'win32') {
    await fs.symlink(directory, path.join(root, 'link'));
    await assert.rejects(createWorkspaceFile(root, 'link/outside.js'), /链接/);
  }
});

test('local branch changes protect stale previews, untracked edits and ignored files', async t => {
  const { root, write } = await fixture(t, true);
  await write('.gitignore', 'ignored.txt\n');
  await write('src/app.js', 'const version = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initial version');
  const first = await gitBranches(root);
  const originalBranch = first.branch;
  await assert.rejects(switchGitBranch(path.join(root, 'src'), { branch: 'test', create: true, revision: first.revision }), /根目录/);
  await assert.rejects(switchGitBranch(root, { branch: '-C', create: true, revision: first.revision }), /有效/);
  await switchGitBranch(root, { branch: 'feature/local', create: true, revision: first.revision });
  assert.equal(git(root, 'branch', '--show-current'), 'feature/local');
  assert.equal(git(root, 'rev-parse', 'HEAD'), first.head);
  await assert.rejects(switchGitBranch(root, { branch: 'another', create: true, revision: first.revision }), /当前分支已变化/);
  await write('newfile', 'keep this');
  const second = await gitBranches(root);
  const toOriginal = { branch: originalBranch, commit: first.head, create: false, revision: second.revision };
  await assert.rejects(switchGitBranch(root, toOriginal), /工作区有改动/);
  assert.equal(await fs.readFile(path.join(root, 'newfile'), 'utf8'), 'keep this');
  await fs.rm(path.join(root, 'newfile'));
  await write('ignored.txt', 'tracked only on feature branch');
  git(root, 'add', '-f', 'ignored.txt');
  git(root, 'commit', '-qm', 'Track the fixture on the feature branch');
  const third = await gitBranches(root);
  await switchGitBranch(root, { ...toOriginal, revision: third.revision });
  await write('ignored.txt', 'private worktree file');
  const fourth = await gitBranches(root);
  const returnToFeature = { branch: 'feature/local', commit: third.head, create: false, revision: fourth.revision };
  await assert.rejects(switchGitBranch(root, { ...returnToFeature, commit: first.head }), /目标分支已变化/);
  await assert.rejects(switchGitBranch(root, returnToFeature), /覆盖本机文件/);
  assert.equal(await fs.readFile(path.join(root, 'ignored.txt'), 'utf8'), 'private worktree file');
  assert.equal(git(root, 'branch', '--show-current'), originalBranch);
});
