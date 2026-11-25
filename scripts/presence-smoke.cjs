const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const http = require('node:http');
const { _electron: electron } = require('playwright');
const { Store } = require('../src/store');

(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-presence-'));
  let requests = 0, app;
  const firstQuestion = '想拍下雨夜的街道，怎么开始？';
  const firstAnswer = '先找一处有灯的屋檐，等一个人走进倒影。把镜头放低一点，让真实的街景和水面各占一半。';
  const longAnswer = Array.from({length: 12}, (_, i) => '### 取景笔记 ' + (i+1) + '\n\n' + firstAnswer).join('\n\n')
    + '\n\n```text\n' + 'sample-frame '.repeat(26) + '\n```';
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw).messages.at(-1);
    assert.equal(message.content, requests === 0 ? firstQuestion : '展开说说');
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: requests === 1 ? firstAnswer : longAnswer }, finish_reason: 'stop' }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    new Store(data).write('providers', [{ id: 'local', kind: 'ollama', name: '本地模型', model: 'local-chat',
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', stream: false }]);
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, XIAOXIAO_SMOKE_DIR: data, XIAOXIAO_SMOKE_SHOW: '1' } });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    const el = id => page.locator('#' + id);
    const checkFocus = id => page.waitForFunction(id => document.activeElement.id === id, id);
    const capture = async name => {
      const dir = process.env.XIAOXIAO_SMOKE_QA_DIR;
      if (!dir) return;
      await fs.mkdir(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, name + '.png'), scale: 'css' });
    };
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await el('presenceKnot').waitFor();
    await page.mouse.move(840, 405);
    await page.waitForFunction(() => {
      const value = document.querySelector('.presence-sculpture').style.transform;
      return value && value !== 'none' && !value.includes('rotateY(0.00deg)');
    });
    const brand = await page.locator('.presence-wordmark').boundingBox();
    assert(Math.abs(brand.x + brand.width / 2 - await page.evaluate(() => innerWidth / 2)) < 2);
    assert(brand.y >= 0 && brand.y + brand.height < 54);
    const firstDust = await el('silkDust').evaluate(node => node.toDataURL());
    await page.waitForFunction(first => document.getElementById('silkDust').toDataURL() !== first, firstDust);
    const firstFrame = await el('silkField').evaluate(node => node.toDataURL());
    await page.waitForFunction(first => document.getElementById('silkField').toDataURL() !== first, firstFrame);
    const film = process.env.XIAOXIAO_PRESENCE_FRAMES;
    if (film) {
      await fs.mkdir(film, { recursive: true });
      await page.waitForFunction(() => document.getElementById('presenceCpu').textContent.endsWith('%'));
      for (let i = 0; i < 64; i++) {
        if (i === 31) await el('presenceKnot').click();
        if (i === 38) await el('prompt').fill('一起聊聊今天的想法');
        if (i === 51) await page.keyboard.press('Escape');
        await page.mouse.move(650+155*Math.cos(i*.105), 350+80*Math.sin(i*.105));
        await page.screenshot({path: path.join(film, String(i).padStart(3,'0')+'.png'), scale: 'css'});
        await new Promise(resolve => setTimeout(resolve, 55));
      }
      await el('presenceKnot').click();
      await el('prompt').fill('');
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.activeElement.blur());
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await el('presenceKnot').waitFor();
    assert(await el('sidebar').isHidden());
    assert(await el('prompt').isHidden());
    await page.waitForFunction(() => document.getElementById('presenceCpu').textContent.endsWith('%'));
    assert.match(await el('presenceMemory').textContent(), /MiB$/);
    assert.equal(await el('presenceKnot').locator('img').evaluate(img => getComputedStyle(img).animationName), 'none');
    const paused = await el('silkDust').evaluate(async node => {
      await new Promise(requestAnimationFrame);
      const before = node.toDataURL();
      await new Promise(resolve => setTimeout(resolve, 160));
      return before === node.toDataURL();
    });
    assert(paused, 'Reduced motion keeps surface particles still');
    await capture('presence-home');
    await el('toggleSidebar').click();
    assert(await el('enterWorkspace').isVisible());
    await page.keyboard.press('Escape');
    await checkFocus('toggleSidebar');
    await el('presenceKnot').press('Enter');
    await checkFocus('prompt');
    assert(await el('presenceEntry').locator('#composer').isVisible());
    await el('prompt').fill('稍后再聊');
    await page.keyboard.press('Escape');
    await checkFocus('presenceKnot');
    await el('presenceKnot').click();
    assert.equal(await el('prompt').inputValue(), '稍后再聊');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900,600));
    await page.waitForFunction(() => innerWidth === 900);
    await capture('presence-compose-compact');
    await el('chooseModel').click();
    await el('modelMenu').waitFor();
    await page.keyboard.press('Escape');
    // Exercise both native focus states, independently of the macOS desktop foreground app.
    if (process.platform === 'darwin') {
      await app.evaluate(({ BrowserWindow, Menu }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const contents = win.webContents;
        const saved = [win.isFocused, contents.isFocused, Menu.sendActionToFirstResponder];
        win.isFocused = contents.isFocused = () => globalThis.presenceTestFocused === true;
        Menu.sendActionToFirstResponder = selector => { globalThis.presenceTestSelector = selector; };
        globalThis.restoreDictationTest = () => { [win.isFocused, contents.isFocused, Menu.sendActionToFirstResponder] = saved; };
      });
      assert.equal(await page.evaluate(() => nova.presence.dictate()), 'unfocused');
      assert.equal(await app.evaluate(() => globalThis.presenceTestSelector), undefined);
      await app.evaluate(() => { globalThis.presenceTestFocused = true; });
    }
    await el('dictate').click();
    await el('dictationHint').waitFor();
    await checkFocus('prompt');
    if (process.platform === 'darwin') {
      assert.equal(await app.evaluate(() => globalThis.presenceTestSelector), 'startDictation:');
      await app.evaluate(() => globalThis.restoreDictationTest());
    }
    assert.equal(requests, 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const flight = page.waitForSelector('.conversation-arrival-knot', { state: 'attached' });
    await el('prompt').fill(firstQuestion);
    await el('prompt').press('Enter');
    await flight;
    await page.locator('#chat .assistant').filter({ hasText: firstAnswer }).waitFor();
    await page.locator('.conversation-arrival-knot').waitFor({ state: 'detached' });
    assert(await el('presence').isHidden());
    assert(await el('sidebar').isHidden());
    assert.equal(requests, 1);
    const rows = await page.evaluate(() => window.nova.conversations.list());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent, false);
    await el('conversationField').waitFor();
    assert.equal(await page.locator('.main').evaluate(node => getComputedStyle(node).colorScheme), 'dark');
    await capture('conversation-night-compact');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320,860));
    await page.waitForFunction(() => innerWidth === 1320);
    const centered = await el('returnPresence').boundingBox();
    assert(Math.abs(centered.x + centered.width / 2 - 660) < 2);
    await capture('conversation-night');
    await el('chooseModel').click();
    assert.equal(await el('modelMenu').evaluate(node => getComputedStyle(node).colorScheme), 'dark');
    await page.keyboard.press('Escape');
    await el('settingsCompact').click();
    await el('generalTab').click();
    await el('conversationScene').selectOption('workspace');
    await el('conversationField').waitFor({ state: 'hidden' });
    assert.equal((await page.evaluate(() => nova.preferences.get())).conversationScene, 'workspace');
    await el('conversationScene').selectOption('silk');
    await el('conversationField').waitFor();
    await el('textSize').selectOption('large');
    await page.waitForFunction(() => document.documentElement.dataset.textSize === 'large');
    await el('closeSettings').click();
    await el('prompt').fill('展开说说');
    await el('prompt').press('Enter');
    await page.locator('#chat pre').waitFor();
    assert(await el('scrollArea').evaluate(node => node.scrollHeight > node.clientHeight));
    assert(await el('chatColumn').evaluate(node => node.scrollWidth <= node.clientWidth+1));
    await el('scrollArea').evaluate(node => { node.scrollTop = 0; });
    assert(await el('prompt').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.top > 0 && rect.bottom <= innerHeight;
    }));
    await el('prompt').fill('会话草稿');
    await el('returnPresence').click();
    await el('presenceKnot').click();
    assert.equal(await el('prompt').inputValue(), '会话草稿');
    await el('returnPresence').click();
    await el('toggleSidebar').click();
    await el('openGenerationStudio').click();
    assert(await el('generationStudio').isVisible());
    assert(await el('presence').isHidden());
    assert.deepEqual(errors, []);
    console.log('PASS: Silk home and chat transition, compact and wide conversation, long Markdown and large text, theme switch, model menu, reduced motion, telemetry, focus, dictation dispatch, drafts and studio navigation.');
  } finally {
    await app?.close();
    server.close();
    await fs.rm(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
