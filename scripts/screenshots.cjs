const enterWorkspace = require('./enter-workspace.cjs');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Store } = require('../src/store');

const root = path.resolve(__dirname, '..');
const qa = path.join(root, 'artifacts', 'ui-preview');
const docs = path.join(root, 'docs', 'images');
const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
const nativeShots = process.platform === 'darwin' && process.env.XIAOXIAO_SCREENSHOTS_NATIVE === '1';
const task = '整理发布资料';
const title = '产品发布检查清单';
const report = `# ${title}

## 发布前核对

产品页、随包文档和演示资料均已归档。发布前仍需确认隐私说明和最终安装包。

| 项目 | 状态 | 下一步 |
| --- | --- | --- |
| 产品截图 | 已确认 | 使用已归档的浅色与深色版本 |
| 隐私说明 | 待复核 | 确认数据保留范围与措辞 |
| 安装包 | 待复核 | 走一次全新安装和升级流程 |

## 发布后留档

- 保存发布说明、安装包与校验值。
- 在发布记录中补齐版本、时间和已知限制。`;

async function seedDemo(dir) {
  const store = new Store(dir);
  const workspace = path.join(dir, '发布资料');
  await fs.mkdir(workspace);
  const updatedAt = Date.now();
  store.write('providers', [
    { id: 'local', name: '本地助手', kind: 'ollama', model: 'demo-assistant', baseUrl: 'http://127.0.0.1:11434', stream: true },
    { id: 'team', name: '团队模型', kind: 'openai-compatible', model: 'demo-reasoner', baseUrl: 'https://example.com/v1', stream: true }
  ]);
  store.write('projects', [
    { id: 'release', name: '产品发布', workspace, instructions: '', sources: [], updatedAt },
    { id: 'research', name: '研究笔记', workspace: '', instructions: '', sources: [], updatedAt }
  ]);
  const base = { providerId: 'local', workspace: '', systemPrompt: '', messages: [] };
  store.write('conversations', [
    {
      ...base, id: 'launch-prep', title: task, projectId: 'release', agent: true, pinned: true, updatedAt,
      messages: [
        { role: 'user', content: '梳理发布资料，列出已确认和待确认的事项，再整理成一份可交付的检查清单。' },
        { role: 'assistant', content: '## 发布资料已梳理\n\n我将核对结果整理成了《产品发布检查清单》。\n\n- **产品截图**已经归档，包含浅色和深色两个版本。\n- **隐私说明**需要再核对一次数据保留范围。\n- **安装包**还需完成全新安装和覆盖升级测试。' }
      ],
      taskPlan: [
        { title: '核对发布资料', status: 'completed' },
        { title: '整理交付稿', status: 'completed' },
        { title: '确认安装包', status: 'pending' }
      ],
      draft: { title, markdown: report }
    },
    { ...base, id: 'copy-review', title: '复核产品页文案', projectId: 'release', agent: false, updatedAt: updatedAt - 1000 },
    { ...base, id: 'notes', title: '汇总访谈要点', projectId: 'research', agent: false, updatedAt: updatedAt - 2000 }
  ]);
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-preview-'));
  let app;
  try {
    await Promise.all([fs.mkdir(qa, { recursive: true }), fs.mkdir(docs, { recursive: true })]);
    app = await electron.launch({
      args: executablePath ? [] : ['.'], executablePath, cwd: root,
      env: { ...process.env, XIAOXIAO_SMOKE_DIR: dir, XIAOXIAO_SMOKE_SHOW: nativeShots ? '1' : '0' }
    });
    const page = await app.firstWindow();
    await enterWorkspace(page);
    page.setDefaultTimeout(12000);
    const ready = () => page.waitForFunction(() => window.nova &&
      document.querySelector('#modelSelect option')?.text !== '正在加载模型…' && !document.getElementById('newChat').disabled);
    const theme = async value => {
      await page.emulateMedia({ colorScheme: null });
      await app.evaluate(({ nativeTheme }, appearance) => { nativeTheme.themeSource = appearance; }, value);
      await page.waitForFunction(dark => matchMedia('(prefers-color-scheme: dark)').matches === dark, value === 'dark');
    };
    const compact = async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
      await page.waitForFunction(() => innerWidth === 900 && innerHeight <= 600);
    };
    const shot = async (dir, name, locator = page) => {
      await page.evaluate(() => document.activeElement?.blur());
      await locator.screenshot({ path: path.join(dir, `${name}.png`), scale: 'css', animations: 'disabled' });
      if (nativeShots && locator === page && (dir === docs || name === 'task-dark-compact')) {
        const source = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMediaSourceId());
        const windowId = /^window:(\d+):\d+$/.exec(source)?.[1];
        if (!windowId) throw new Error(`Cannot identify the demo window: ${source}`);
        execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-a', `-l${windowId}`, path.join(qa, `${name}-native.png`)]);
      }
    };
    const click = id => page.locator(`#${id}`).click();
    const settings = async () => {
      await click('settings');
      await page.waitForFunction(() => !document.getElementById('providerFields').disabled);
    };

    await ready();
    await theme('light');
    await page.locator('#connectModel').waitFor();
    await shot(qa, 'first-run-light');
    await seedDemo(dir);
    await page.reload();
    await enterWorkspace(page);
    await ready();
    await shot(docs, 'workspace');
    await click('chooseModel');
    await page.locator('#modelResults button').first().waitFor();
    await shot(docs, 'model-switcher');
    await page.keyboard.press('Escape');
    await page.locator('#modelMenu').waitFor({ state: 'hidden' });
    await click('composerToolsButton');
    await page.locator('#composerTools:popover-open').waitFor();
    await shot(qa, 'composer-tools-light');
    await page.keyboard.press('Escape');
    await page.locator('#composerTools').waitFor({ state: 'hidden' });

    await page.locator('#history .session-link').filter({ hasText: task }).click();
    await page.locator('#taskOutputs').waitFor();
    await shot(docs, 'task');
    await page.locator('.session-row[data-session="launch-prep"] .session-more').click();
    await page.locator('#sessionMenu:popover-open').waitFor();
    await shot(docs, 'session-actions');
    await page.keyboard.press('Escape');
    await click('draftShortcut');
    await shot(qa, 'draft-light');
    await click('closeDraft');
    await click('taskSummary');
    await shot(qa, 'inspector-light');
    await click('closeTaskPane');
    await settings();
    await shot(docs, 'preferences', page.locator('#settingsDialog'));
    await click('providerTab');
    await shot(docs, 'settings', page.locator('#settingsDialog'));
    await click('closeSettings');

    await theme('dark');
    await compact();
    await shot(qa, 'task-dark-compact');
    await click('toggleTaskPane');
    await shot(qa, 'inspector-dark-compact');
    await click('openDraft');
    await shot(qa, 'draft-dark-compact');
    await click('closeDraft');
    await click('closeTaskPane');
    await settings();
    await shot(qa, 'settings-dark-compact');
    await click('mcpTab');
    await shot(qa, 'mcp-dark-compact');
    await click('closeSettings');
    await click('toggleSidebar');
    await shot(qa, 'collapsed-dark-compact');
    await click('toggleSidebar');
    await click('newChat');
    await shot(qa, 'workspace-dark-compact');
    if (await page.locator('#brandName').evaluate(node => node.scrollWidth > node.clientWidth)) {
      throw Error('The app name is clipped in the compact sidebar');
    }

    const store = new Store(dir);
    for (const key of ['providers', 'projects', 'conversations']) store.write(key, []);
    await page.reload();
    await enterWorkspace(page);
    await ready();
    await page.locator('#connectModel').waitFor();
    await shot(qa, 'first-run-dark-compact');
    console.log(`Demo screenshots: ${docs}\nAppearance checks: ${qa}`);
  } finally {
    try { if (app) await app.close(); }
    finally { await fs.rm(dir, { force: true, recursive: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
