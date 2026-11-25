const enterWorkspace = require('./enter-workspace.cjs');
'use strict';

const { _electron: electron } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Store } = require('../src/store');

const root = path.resolve(__dirname, '..');
const qa = process.env.XIAOXIAO_SMOKE_QA_DIR;
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
const priceFile = 'src/pricing.js';
const original = `/** Calculate the order summary for the checkout screen. */
export const shippingRates = {
  standard: 8,
  express: 16,
};

const FREE_SHIPPING_THRESHOLD = 80;

export function summarizeOrder(items, method = 'standard') {
  const subtotal = items.reduce((total, item) => {
    return total + item.price * item.quantity;
  }, 0);
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD
    ? 0
    : shippingRates[method];

  return { subtotal, shipping, total: subtotal + shipping };
}
`;
const policy = '# 配送规则\n\n- 普通配送 ¥8，加急配送 ¥16。\n- 满 ¥80 包邮。测试需覆盖临界订单金额。\n';
const planResult = '已核对配送规则和实现。建议将门槛集中配置，并测试低于、等于和高于门槛的订单。';
const nextEdit = 'const FREE_SHIPPING_THRESHOLD = 99;';
const observed = {};

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/development-preview') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<title>Northstar Store</title><main><h1>Northstar Store</h1><a href="/preview-status">Development status</a></main><script src="/preview.js"></script>');
    }
    if (req.url === '/preview-status') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<main>Development server ready</main>');
    }
    if (req.url === '/preview.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('document.body.dataset.ready = "true";');
    }
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'));
    const tools = body.tools?.map(tool => tool.function.name) || [];
    const results = Object.fromEntries(body.messages.filter(row => row.role === 'tool').map(row => [row.tool_call_id, row.content]));
    const user = body.messages.find(row => row.role === 'user').content;
    res.setHeader('content-type', 'text/event-stream');
    const send = (delta, finish) => res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
    const call = (...tools) => send({ tool_calls: tools.map(([name, id, args], index) => ({ index, id, function: { name, arguments: JSON.stringify(args) } })) }, 'tool_calls');
    const answer = content => send({ content }, 'stop');
    if (body.messages[0].content.includes('You are a code editor.')) {
      const input = JSON.parse(user);
      assert.deepEqual(tools, []);
      assert.equal(input.source.file, priceFile);
      if (input.instruction) {
        assert.equal(input.source.selected, 'const FREE_SHIPPING_THRESHOLD = 85;');
        assert.equal(input.instruction, '将门槛改为 90');
        return answer(JSON.stringify({ text: 'const FREE_SHIPPING_THRESHOLD = 90;' }));
      }
      assert.equal(input.source.selected, '');
      if (input.source.before.endsWith('// externalx')) observed.automatic = true;
      return answer(JSON.stringify({ text: ' // 满额包邮' }));
    }
    if (body.messages[0].content.includes('This is a planning turn.')) {
      observed.planTools = tools;
      assert(!tools.some(name => ['write_file', 'edit_file', 'run_command', 'read_public_web'].includes(name)));
      assert(tools.includes('ask_user'));
      if (body.messages.filter(row => row.role === 'user').at(-1).content.includes('审查附加的 Git 差异')) {
        if (!results.diff) return call(['read_selected_document', 'diff', { index: 1 }]);
        assert.match(results.diff, /\+const FREE_SHIPPING_THRESHOLD = 99;/);
        if (results.diff.includes('README.md')) {
          assert.match(results.diff, /\+满 ¥99 包邮。/);
          observed.stagedReview = true;
          return answer('已联合审查配送代码和 README。');
        }
        observed.reviewed = true;
        return answer('审查建议：为包邮门槛增加边界测试。');
      }
      if (!results.details) return call(['search_workspace', 'details', { query: 'FREE_SHIPPING_THRESHOLD' }]);
      if (!results.rules) return call(['read_selected_document', 'code', { index: 1 }], ['read_selected_document', 'rules', { index: 2 }]);
      assert.match(results.details, /src\/pricing\.js/);
      assert.match(results.code, /FREE_SHIPPING_THRESHOLD/);
      assert(!results.code.includes('summarizeOrder'));
      assert.equal(results.rules, policy);
      return answer(planResult);
    }
    if (body.messages.some(row => row.role === 'user' && row.content.includes('请按上一轮的方案执行'))) {
      observed.executeTools = tools;
      assert(tools.includes('edit_file'));
      if (!results.change) return call(['edit_file', 'change', { path: priceFile, edits: [{ old_text: 'const FREE_SHIPPING_THRESHOLD = 85;', new_text: nextEdit }] }]);
      assert.match(results.change, /bytesWritten/);
      return answer('已更新配送门槛。');
    }
    answer(user);
  } catch (error) {
    console.error('Mock model fixture failed:', error.message);
    res.destroy();
  }
});

async function run() {
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-workbench-smoke-')));
  let app;
  try {
    const project = path.join(data, 'northstar-store');
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.mkdir(path.join(project, 'docs'));
    await fs.writeFile(path.join(project, priceFile), original);
    await fs.writeFile(path.join(project, 'docs/shipping.md'), policy);
    await fs.writeFile(path.join(project, 'README.md'), '# Northstar Store\n\n本地结算示例项目。\n');
    await fs.writeFile(path.join(project, '.gitignore'), '.env*\n');
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'add', '.');
    git(project, '-c', 'user.name=Workbench', '-c', 'user.email=fixture@local.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Create demonstration project');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const store = new Store(data);
    store.write('providers', [{ id: 'fixture', name: '开发助手', model: 'local-fixture', kind: 'ollama', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }]);
    store.write('projects', [{ id: 'northstar', name: 'Northstar Store', workspace: project, instructions: '优先验证包邮门槛。', sources: [] }]);
    store.write('conversations', [{ id: 'agent', title: '改进结算与配送规则', projectId: 'northstar', agent: true, providerId: 'fixture', updatedAt: Date.now(), messages: [] }]);
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    app = await electron.launch({ args: executablePath ? [] : ['.'], executablePath, cwd: root, env: { ...process.env, XIAOXIAO_SMOKE_DIR: data } });
    const page = await app.firstWindow();
    await enterWorkspace(page);
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy/.test(message.text())) errors.push(`${JSON.stringify(message.location())} ${message.text()}`); });
    const control = id => page.locator(`#${id}`);
    const click = id => control(id).click();
    const waitText = (id, text) => control(id).getByText(text, { exact: false }).first().waitFor();
    const appearance = value => app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, value);
    const shortcut = key => page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+${key}`);
    const capture = async name => {
      if (!qa) return;
      await fs.mkdir(qa, { recursive: true });
      await page.screenshot({ path: path.join(qa, `${name}.png`), scale: 'css', animations: 'disabled' });
    };
    const search = async (query, name) => {
      await click('projectSearchButton');
      await control('projectQuery').fill(query);
      await control('projectSearchResults').getByRole('button', { name }).first().click();
    };
    await appearance('light');
    await control('history').locator('.session-link').filter({ hasText: '改进结算与配送规则' }).click();
    await shortcut('2');
    await control('editorEmpty').waitFor();
    assert.equal(await control('developmentMode').getAttribute('aria-pressed'), 'true');
    await capture('workbench-empty-light');
    await click('createEditorFile');
    await control('newWorkspaceFilePath').fill(priceFile);
    await click('createWorkspaceFileNow');
    await waitText('newWorkspaceFileStatus', '目标文件已存在');
    assert.equal(await fs.readFile(path.join(project, priceFile), 'utf8'), original);
    const temporaryFile = 'src/workbench-draft.md';
    await control('newWorkspaceFilePath').fill(temporaryFile);
    await click('createWorkspaceFileNow');
    await waitText('filePreviewName', 'workbench-draft.md');
    await control('fileLines').getByRole('textbox', { name: '代码编辑器' }).waitFor();
    assert.equal(await fs.readFile(path.join(project, temporaryFile), 'utf8'), '');
    await control('editorTabs').getByRole('button', { name: `关闭 ${temporaryFile}` }).click();
    await fs.rm(path.join(project, temporaryFile));
    await click('developmentMode');
    await control('editorEmpty').waitFor({ state: 'hidden' });
    await shortcut('Shift+f');
    await control('projectQuery').fill('FREE_SHIPPING_THRESHOLD');
    await waitText('projectSearchStatus', '2 个结果');
    await capture('workspace-search-light');
    await control('projectSearchResults').getByRole('button', { name: /pricing.js:7/ }).click();
    await waitText('editorPosition', '第 7 行');
    const editor = page.getByRole('textbox', { name: '代码编辑器' });
    await editor.press('Backspace');
    await page.keyboard.insertText('const FREE_SHIPPING_THRESHOLD = 85;');
    await waitText('editorState', '未保存');
    assert.equal(await fs.readFile(path.join(project, priceFile), 'utf8'), original);
    // Switching files retains draft edits.
    await search('临界订单', /shipping.md:4/);
    await waitText('fileLines', '临界订单金额');
    await control('editorTabs').getByRole('button', { name: 'pricing.js', exact: true }).click();
    await waitText('fileLines', 'FREE_SHIPPING_THRESHOLD = 85');
    await shortcut('s');
    await waitText('editorState', '已保存');
    const saved = original.replace('= 80;', '= 85;');
    assert.equal(await fs.readFile(path.join(project, priceFile), 'utf8'), saved);
    // Conflict keeps both the unsaved draft and the user's external version.
    await page.keyboard.insertText('\n// unsaved');
    await fs.writeFile(path.join(project, priceFile), saved + '// external\n');
    await click('saveEditor');
    await waitText('previewStatus', '磁盘上的文件已变化');
    await waitText('fileLines', '// unsaved');
    assert.equal(await fs.readFile(path.join(project, priceFile), 'utf8'), saved + '// external\n');
    await click('refreshPreview');
    await control('editorDiscard').getByRole('button', { name: '放弃修改' }).click();
    await waitText('fileLines', '// external');
    // Acceptance updates the buffer only, and its undo history survives switching tabs.
    await search('const FREE_SHIPPING_THRESHOLD = 85', /pricing.js:7/);
    await editor.press('ArrowRight');
    await editor.press('Alt+Slash');
    await waitText('codeAssistStatus', 'Tab 采纳');
    assert.match(await control('fileLines').locator('.cm-ghost-code').textContent(), /满额包邮/);
    await capture('editor-assist-light');
    await editor.press('Escape');
    assert.equal(await control('codeAssistStrip').isVisible(), false);
    await click('codeComplete');
    await waitText('codeAssistStatus', 'Tab 采纳');
    await editor.press('Tab');
    await waitText('editorState', '未保存');
    await search('临界订单', /shipping.md:4/);
    await control('editorTabs').getByRole('button', { name: 'pricing.js', exact: true }).click();
    await shortcut('z');
    await waitText('editorState', '已保存');
    await search('const FREE_SHIPPING_THRESHOLD = 85', /pricing.js:7/);
    await shortcut('i');
    await control('codeInstruction').fill('将门槛改为 90');
    await click('submitCodeEdit');
    await waitText('codeEditAfter', 'FREE_SHIPPING_THRESHOLD = 90');
    await capture('editor-rewrite-light');
    await click('applyCodeEdit');
    await waitText('fileLines', 'FREE_SHIPPING_THRESHOLD = 90');
    assert.equal(await fs.readFile(path.join(project, priceFile), 'utf8'), saved + '// external\n');
    await shortcut('z');
    await waitText('editorState', '已保存');
    await search('// external', /pricing.js:/);
    await editor.press('ArrowRight');
    await editor.press('Enter');
    await page.keyboard.insertText('const  = ;');
    await control('editorIssues').waitFor();
    await click('editorIssues');
    await control('fileLines').locator('.cm-panel-lint').waitFor();
    await control('fileLines').locator('.cm-panel-lint button').click();
    await editor.focus();
    await shortcut('z');
    if ((await control('editorState').textContent()) === '未保存') await shortcut('z');
    await waitText('editorState', '已保存');
    assert.equal(await control('autoComplete').getAttribute('aria-pressed'), 'false');
    await search('// external', /pricing.js:/);
    await editor.press('ArrowRight');
    await click('autoComplete');
    await editor.press('x');
    await waitText('codeAssistStatus', 'Tab 采纳');
    assert.equal(observed.automatic, true);
    await click('autoComplete');
    await shortcut('z');
    await waitText('editorState', '已保存');
    await click('workspaceGitButton');
    await control('gitEntries').getByRole('button', { name: /pricing.js/ }).click();
    await waitText('gitDiffBody', '+const FREE_SHIPPING_THRESHOLD = 85;');
    await capture('workspace-git-light');
    await click('gitIndexAction');
    await waitText('gitEntries', '已暂存');
    assert.equal(git(project, 'diff', '--cached', '--name-only'), priceFile);
    await control('gitEntries').getByRole('button', { name: /pricing.js/ }).click();
    await waitText('gitReviewTitle', '已暂存的改动');
    await click('gitIndexAction');
    await waitText('gitEntries', '未暂存');
    assert.equal(git(project, 'diff', '--cached', '--name-only'), '');
    // Reference a selection and a second file, then complete a read-only plan.
    await search('const FREE_SHIPPING_THRESHOLD', /pricing.js:7/);
    await waitText('editorPosition', '第 7 行');
    await click('splitAgent');
    await click('inspectorFiles');
    const directory = control('fileEntries').getByRole('button', { name: 'src', exact: true });
    await directory.press('ArrowRight');
    assert.equal(await directory.getAttribute('aria-expanded'), 'true');
    await control('fileEntries').getByRole('button', { name: 'pricing.js', exact: true }).waitFor();
    await directory.press('ArrowLeft');
    assert.equal(await directory.getAttribute('aria-expanded'), 'false');
    await directory.press('ArrowRight');
    await control('fileEntries').getByRole('button', { name: 'pricing.js', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => {
      const x = id => document.getElementById(id).getBoundingClientRect().left;
      return x('taskPane') < x('filePreview') && x('filePreview') < x('chatColumn');
    }), true);
    await click('attachSelection');
    await waitText('attachmentLabel', 'src/pricing.js:7');
    await control('prompt').press('@');
    await control('projectQuery').fill('shipping');
    await control('projectSearchResults').getByRole('button', { name: /shipping.md/ }).click();
    await waitText('attachmentLabel', 'docs/shipping.md');
    await click('planMode');
    await control('prompt').fill('先规划如何统一包邮门槛与验证用例。');
    await click('send');
    await waitText('chat', planResult);
    assert(observed.planTools.includes('search_workspace'));
    await waitText('continuePlan', '按计划执行');
    await capture('editor-agent-light');
    await click('continuePlan');
    assert.match(await control('prompt').inputValue(), /按上一轮的方案执行/);
    assert.equal(await control('taskMode').getAttribute('aria-pressed'), 'true');
    await click('send');
    await click('openChangeReview');
    await waitText('changeReviewBody', nextEdit);
    await capture('workbench-approval-light');
    await click('applyReviewedWrite');
    await waitText('chat', '已更新配送门槛');
    assert(observed.executeTools.includes('edit_file'));
    assert.match(await fs.readFile(path.join(project, priceFile), 'utf8'), /THRESHOLD = 99/);
    await control('stop').waitFor({ state: 'hidden' });

    const diskFile = path.join(project, priceFile);
    const afterAgent = await fs.readFile(diskFile, 'utf8');
    const beforeAgent = saved + '// external\n';
    assert.equal(afterAgent, beforeAgent.replace('= 85;', '= 99;'));
    await waitText('fileLines', 'THRESHOLD = 99');
    await editor.press('End');
    await page.keyboard.insertText('// unsaved restore test');
    await waitText('editorState', '未保存');
    const editorLeft = () => control('filePreview').evaluate(element => element.getBoundingClientRect().left);
    const beforeInspector = await editorLeft();
    await click('changesShortcut');
    assert.equal(await editorLeft(), beforeInspector);
    const changeRecord = control('changesList').getByRole('button', { name: /pricing.js/ });
    await changeRecord.first().click();
    await click('restoreFilePreview');
    await waitText('reviewStatus', '未保存的编辑');
    await click('closeChangeReview');
    await editor.focus();
    await shortcut('z');
    await waitText('editorState', '已保存');
    await changeRecord.first().click();
    await click('restoreFilePreview');
    await waitText('changeReviewTitle', '恢复文件');
    await waitText('changeReviewBody', '+ const FREE_SHIPPING_THRESHOLD = 85;');
    await capture('workbench-restore-light');
    await click('cancelFileRestore');
    await waitText('changeReviewTitle', '写入记录');
    assert.equal(await fs.readFile(diskFile, 'utf8'), afterAgent);
    await click('restoreFilePreview');
    await waitText('changeReviewTitle', '恢复文件');
    await fs.writeFile(diskFile, afterAgent + '// newer external edit\n');
    await click('applyFileRestore');
    await waitText('reviewStatus', '磁盘版本已变化');
    assert.match(await fs.readFile(diskFile, 'utf8'), /newer external edit/);
    await fs.writeFile(diskFile, afterAgent);
    await click('applyFileRestore');
    await control('changeReviewDialog').waitFor({ state: 'hidden' });
    await waitText('changesList', '已恢复');
    await waitText('fileLines', 'THRESHOLD = 85');
    assert.equal(await fs.readFile(diskFile, 'utf8'), beforeAgent);
    await changeRecord.first().click();
    await click('restoreFilePreview');
    await waitText('changeReviewBody', '+ const FREE_SHIPPING_THRESHOLD = 99;');
    await click('applyFileRestore');
    await control('changeReviewDialog').waitFor({ state: 'hidden' });
    await waitText('fileLines', 'THRESHOLD = 99');
    assert.equal(await fs.readFile(diskFile, 'utf8'), afterAgent);

    if (!(await control('gitBrowser').isVisible())) await click('workspaceGitButton');
    await control('gitEntries').getByRole('button', { name: /pricing.js/ }).click();
    await waitText('gitDiffBody', '+const FREE_SHIPPING_THRESHOLD = 99;');
    await click('gitReviewAgent');
    await waitText('attachmentLabel', '未暂存差异');
    assert.equal(await control('planMode').getAttribute('aria-pressed'), 'true');
    assert.match(await control('prompt').inputValue(), /审查附加的 Git 差异/);
    await click('send');
    await waitText('chat', '为包邮门槛增加边界测试');
    assert.equal(observed.reviewed, true);
    await control('stop').waitFor({ state: 'hidden' });
    await control('gitEntries').getByRole('button', { name: /pricing.js/ }).click();
    await click('gitIndexAction');
    await fs.appendFile(path.join(project, 'README.md'), '\n满 ¥99 包邮。\n');
    await click('refreshGit');
    await control('gitEntries').getByRole('button', { name: /README.md/ }).click();
    await click('gitIndexAction');
    await click('openGitCommit');
    await waitText('gitCommitPatch', '+const FREE_SHIPPING_THRESHOLD = 99;');
    await waitText('gitCommitPatch', '+满 ¥99 包邮。');
    await click('reviewGitCommit');
    await waitText('attachmentLabel', '暂存区差异');
    assert.equal(await control('planMode').getAttribute('aria-pressed'), 'true');
    await click('send');
    await waitText('chat', '已联合审查配送代码和 README');
    await control('stop').waitFor({ state: 'hidden' });
    assert.equal(observed.stagedReview, true);
    assert.equal(git(project, 'diff', '--cached', '--name-only'), `README.md\n${priceFile}`);
    await click('openGitCommit');
    await waitText('gitCommitPatch', '+满 ¥99 包邮。');
    await control('gitCommitMessage').fill('Update the shipping threshold');
    await capture('workspace-commit-light');
    await click('gitCommitNow');
    await waitText('gitStatus', '已创建本地提交');
    assert.equal(git(project, 'log', '-1', '--format=%s'), 'Update the shipping threshold');
    assert.equal(git(project, 'status', '--porcelain'), '');

    await editor.press('End');
    await page.keyboard.insertText('// unsaved branch test');
    await waitText('editorState', '未保存');
    await click('openGitBranches');
    await waitText('gitBranchCurrent', '当前分支 main');
    await control('gitBranchName').fill('feature/shipping');
    await click('gitCreateBranch');
    await waitText('gitBranchStatus', '有未保存的编辑');
    await click('closeGitBranch');
    await editor.focus();
    await shortcut('z');
    await waitText('editorState', '已保存');
    await click('openGitBranches');
    await control('gitBranchName').fill('feature/shipping');
    await capture('workspace-branches-light');
    await click('gitCreateBranch');
    await waitText('gitStatus', '已新建并切换到 feature/shipping');
    assert.equal(git(project, 'branch', '--show-current'), 'feature/shipping');
    await fs.writeFile(diskFile, afterAgent.replace('= 99;', '= 100;'));
    await fs.writeFile(path.join(project, 'docs', 'branch-only.md'), '# feature only\n');
    git(project, 'add', '.');
    git(project, '-c', 'user.name=Workbench', '-c', 'user.email=fixture@local.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Try a new threshold');
    await search('feature only', /branch-only.md/);
    await waitText('fileLines', 'feature only');
    await click('openGitBranches');
    await control('gitBranchSelect').selectOption('main');
    await click('gitSwitchNow');
    await waitText('gitStatus', '已切换到 main');
    await waitText('previewStatus', '文件已移动或删除');
    await control('editorTabs').getByRole('button', { name: '关闭 docs/branch-only.md' }).click();
    await control('editorTabs').getByRole('button', { name: 'pricing.js', exact: true }).click();
    await waitText('fileLines', 'THRESHOLD = 99');
    assert.equal(await fs.readFile(diskFile, 'utf8'), afterAgent);

    // Start the terminal explicitly, verify the real PTY and preserve the session when collapsed.
    await click('terminalButton');
    await click('startTerminal');
    await waitText('terminalLocation', process.platform === 'win32' ? 'cmd' : /zsh|bash|sh|fish/);
    const terminal = control('terminalScreens').locator('.xterm-helper-textarea');
    await terminal.waitFor();
    if (process.platform !== 'win32') {
      await terminal.focus();
      await page.keyboard.insertText("printf '%s\\n' workbench-ready > .terminal-proof; pwd");
      await page.keyboard.press('Enter');
      const proof = path.join(project, '.terminal-proof');
      for (let i = 0; i < 50; i++) {
        if (await fs.readFile(proof, 'utf8').catch(() => '') === 'workbench-ready\n') break;
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      assert.equal(await fs.readFile(proof, 'utf8'), 'workbench-ready\n');
    }
    await capture('editor-terminal-light');
    await click('hideTerminal');
    await click('terminalButton');
    assert.equal(await control('stopTerminal').isVisible(), true);
    await click('stopTerminal');
    await click('hideTerminal');
    await click('openProjectPreview');
    await control('projectPreviewUrl').fill('https://example.test/');
    await click('startProjectPreview');
    await waitText('projectPreviewStatus', '请输入本机网页地址');
    const address = `http://127.0.0.1:${server.address().port}/development-preview`;
    await control('projectPreviewUrl').fill(address);
    const opened = app.waitForEvent('window');
    await click('startProjectPreview');
    const web = await opened;
    await web.getByRole('heading', { name: 'Northstar Store' }).waitFor();
    await web.locator('body[data-ready="true"]').waitFor();
    assert.equal(await web.evaluate(() => typeof window.nova), 'undefined');
    assert.equal(await web.evaluate(() => typeof window.require), 'undefined');
    await web.getByRole('link', { name: 'Development status' }).click();
    await web.getByText('Development server ready').waitFor();
    await app.evaluate(({ BrowserWindow }, location) => {
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === location)?.close();
    }, new URL('/preview-status', address).href);
    await control('projectPreviewDialog').waitFor({ state: 'hidden' });
    await appearance('dark');
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
    await page.waitForFunction(() => innerWidth <= 900);
    await shortcut('p');
    await control('projectQuery').fill('pricing');
    await control('projectSearchResults').getByRole('button', { name: /pricing.js/ }).click();
    await waitText('fileLines', 'THRESHOLD = 99');
    await capture('editor-dark-compact');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: Project search, editor undo, inline and automatic completion, rewrite and diagnostics, read-only planning and single/multi-file review, reviewed edits and conflict-safe restoration, file creation, local Git commits and branches, local web preview, project PTY, and compact dark layout.');
  } catch (error) {
    if (qa && app) await (await app.firstWindow()).screenshot({ path: path.join(qa, 'workbench-failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
      await app.close();
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(data, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
