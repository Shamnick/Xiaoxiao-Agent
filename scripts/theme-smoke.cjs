const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const enterWorkspace = require('./enter-workspace.cjs');
const { Store } = require('../src/store');

async function run() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-theme-'));
  const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
  const output = process.env.XIAOXIAO_SMOKE_QA_DIR;
  let app;
  try {
    const store = new Store(data);
    // An existing light preference survives the upgrade, even with the silk scene enabled.
    store.write('preferences', { appearance: 'light', conversationScene: 'silk' });
    const projectDir = path.join(data, 'workspace');
    await fs.mkdir(projectDir);
    store.write('projects', [{ id: 'studio', name: '创作笔记', workspace: projectDir }]);
    store.write('conversations', [{ id: 'brief', title: '雨夜街景', agent: true, projectId: 'studio',
      messages: [{ role: 'user', content: '帮我整理雨夜街景的拍摄思路。' },
        { role: 'assistant', content: '先找一盏有倒影的路灯。把镜头放低，让灯光和行人一起进入画面。' }], updatedAt: Date.now() }]);
    app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, XIAOXIAO_SMOKE_DIR: data } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.emulateMedia({ colorScheme: null, reducedMotion: 'reduce' });
    await enterWorkspace(page);
    await page.locator('#history .session-link').filter({ hasText: '雨夜街景' }).click();
    const click = id => page.locator('#' + id).click();
    const style = selector => page.locator(selector).evaluate(node => {
      const s = getComputedStyle(node);
      return { scheme: s.colorScheme, text: s.getPropertyValue('--text').trim(), focus: s.getPropertyValue('--focus').trim(),
        surface: s.getPropertyValue('--surface').trim(), accent: s.getPropertyValue('--accent').trim() };
    });
    const shot = async name => {
      if (!output) return;
      await fs.mkdir(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'theme-' + name + '.png'), scale: 'css', animations: 'disabled' });
    };
    let light, artwork;
    for (const mode of ['light', 'dark']) {
      if (mode === 'dark') {
        await click('settings');
        await click('generalTab');
        await page.locator('#appearance label').filter({ hasText: '深色' }).click();
        await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
        await click('closeSettings');
      }
      const palette = await style('html');
      assert.equal(palette.scheme, mode);
      if (mode === 'light') light = palette;
      else assert.notEqual(light.accent, palette.accent);
      const same = async selector => {
        await page.locator(selector).waitFor();
        assert.deepEqual(await style(selector), palette, selector + ' • ' + mode);
      };
      await same('#chat');
      await shot('chat-' + mode);
      await click('settings');
      await click('generalTab');
      await same('#settingsDialog');
      await shot('settings-' + mode);
      await click('closeSettings');
      const rail = await style('#sidebar');
      assert.equal(await page.locator('#brandHome img').evaluate(img => new URL(img.currentSrc).pathname.split('/').pop()), 'silk-knot.png');
      await click('openGenerationStudio');
      await same('.generation-main');
      assert.deepEqual(await style('.generation-sidebar'), rail);
      for (const kind of ['Image', 'Video', 'Audio']) {
        await click('generationTab' + kind);
        await same('#generationPanel' + kind);
      }
      await click('generationTabImage');
      await page.waitForFunction(() => {
        const canvas = document.querySelector('#creationField canvas');
        if (!canvas.clientWidth) return false;
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        return data.some((alpha, i) => i % 4 === 3 && alpha !== 0);
      });
      await shot('studio-' + mode);
      await click('manageGenerationModels');
      await same('#providerPanel');
      await click('closeSettings');
      await click('closeGenerationStudio');
      await click('developmentMode');
      await same('#editorEmpty');
      await shot('workbench-' + mode);
      await click('developmentMode');
      await click('openMediaLab');
      await same('#mediaLab');
      await click('closeMediaLab');
      await click('openProofFromRail');
      await same('#proofStudio');
      const colors = await page.locator('#proofPoster').evaluate(node => [getComputedStyle(node).background, getComputedStyle(node).color]);
      if (mode === 'light') artwork = colors;
      else assert.deepEqual(colors, artwork);
      await shot('proof-' + mode);
      await click('proofExport');
      await same('#proofDelivery');
      await click('proofDeliveryClose');
      await click('proofClose');
    }
    await click('openGenerationStudio');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
    await click('openCreationSettings');
    const sheet = page.locator('#creationSettingsDialog');
    assert.deepEqual(await style('#creationSettingsDialog'), await style('html'));
    assert(await sheet.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await shot('compact-settings');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement.id === 'openCreationSettings');
    console.log('PASS: persisted light and live dark theme across chat, studio tabs, both rails, editor, settings, visual lab and proof export; compact sheet and focus return.');
  } finally {
    await app?.close();
    await fs.rm(data, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
