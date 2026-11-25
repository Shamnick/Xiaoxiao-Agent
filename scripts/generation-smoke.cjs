const enterWorkspace = require('./enter-workspace.cjs');
'use strict';

const { _electron: electron } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');

const root = path.resolve(__dirname, '..');
const qa = process.env.XIAOXIAO_SMOKE_QA_DIR;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=';

async function run() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-generation-smoke-'));
  let app;
  const requests = [];
  const imagePrompts = [], videoPrompts = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url === '/v1/images/generations') {
        imagePrompts.push(body.prompt);
        if (body.prompt === '模拟失败' && imagePrompts.filter(prompt => prompt === '模拟失败').length === 1) {
          return res.writeHead(503).end();
        }
        if (body.n === 2) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ b64_json: png }, { b64_json: png }] }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      }
      if (req.url === '/v1/videos') {
        videoPrompts.push(body.prompt);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'fixture-video', status: 'queued' }));
      }
      if (req.url === '/v1/audio/speech') {
        assert.equal(body.input, '欢迎来到创作中心');
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(Buffer.from('fixture audio'));
      }
      res.writeHead(404).end();
      return;
    }
    if (req.url === '/v1/videos/fixture-video') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'completed' }));
    }
    if (req.url === '/v1/videos/fixture-video/content') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
    }
    res.writeHead(404).end();
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    new Store(data).write('providers', [{
      id: 'fixture-vision', name: '媒体测试服务', model: 'fixture-generation', kind: 'ollama',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, stream: false
    }]);
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    app = await electron.launch({
      args: executablePath ? [] : ['.'], executablePath, cwd: root,
      env: { ...process.env, XIAOXIAO_SMOKE_DIR: data }
    });
    const page = await app.firstWindow();
    await enterWorkspace(page);
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => typeof document.getElementById('openGenerationStudio').onclick === 'function');
    await page.locator('#openGenerationStudio').click();
    try { await page.locator('#generationStudio').waitFor(); }
    catch (error) {
      console.error('Generation UI diagnostics:', JSON.stringify(await page.evaluate(() => ({
        opened: document.getElementById('generationStudio').open,
        clickHandler: typeof document.getElementById('openGenerationStudio').onclick,
        generationApi: typeof window.nova.generation?.onEvent
      }))), errors);
      throw error;
    }
    if (qa) {
      await fs.mkdir(qa, { recursive: true });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.screenshot({ path: path.join(qa, 'generation-studio-light.png'), scale: 'css' });
      await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
      await page.locator('#openCreationSettings').waitFor();
      await page.screenshot({ path: path.join(qa, 'creation-layout.png'), scale: 'css' });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.locator('#openCreationSettings').click();
      await page.screenshot({ path: path.join(qa, 'creation-settings-dark.png'), scale: 'css' });
      await page.keyboard.press('Escape');
      await page.locator('#creationSettingsDialog').waitFor({state:'hidden'});
      await page.emulateMedia({ colorScheme: 'light' });
      await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
    }

    await page.locator('#generationPreset').click();
    await page.locator('#generationPresetMenu:popover-open').waitFor();
    assert.equal(await page.locator('#generationPresetMenu button').count(), 4);
    await page.locator('#generationPresetMenu button').first().click();
    assert.match(await page.locator('#generationImagePrompt').inputValue(), /产品摄影/);
    await page.locator('#generationFocus').click();
    assert.equal(await page.locator('#generationStudio').evaluate(dialog => dialog.classList.contains('generation-focus')), true);
    await page.locator('#generationFocus').click();

    await page.locator('#generationImagePrompt').fill('一个玻璃质感的海面');
    await page.locator('#runGeneration').click();
    await page.locator('.generation-result').waitFor();
    assert.equal(await page.locator('.generation-result').getAttribute('alt'), '生成的图片 1');
    assert.equal(await page.locator('.generation-result').evaluate(image => image.naturalWidth), 1);
    await page.screenshot({ path: path.join(data, 'generation-image.png') });

    const saved = path.join(data, 'generated-image.png');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, saved);
    await page.locator('#saveGeneration').click();
    await page.waitForFunction(() => document.getElementById('generationStatus').textContent === '作品已导出。');
    assert.equal((await fs.readFile(saved)).toString('base64'), png);

    await page.locator('#generationImageCount').selectOption('2');
    await page.locator('#generationImagePrompt').fill('光线改成黄昏，两张构图');
    await page.locator('#runGeneration').click();
    await page.locator('.creation-turn').nth(1).locator('.generation-result').nth(1).waitFor();
    assert.match(imagePrompts[1], /一个玻璃质感的海面[\s\S]+光线改成黄昏/);
    const batch = page.locator('.creation-turn').nth(1);
    await batch.getByRole('button', { name: '查看第 1 张大图' }).press('Enter');
    await page.locator('#creationGallery[open]').waitFor();
    assert.equal(await page.locator('#galleryPosition').textContent(), '1 / 2');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#galleryImage').getAttribute('alt'), '生成的图片 2');
    assert(await page.locator('#galleryNext').isDisabled());
    await page.locator('#galleryScale').click();
    assert.equal(await page.locator('#galleryImage').evaluate(image => image.clientWidth), 1);
    await page.locator('#gallerySave').click();
    await page.getByText('图片已导出', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('creationGallery').open && document.activeElement.getAttribute('aria-label') === '查看第 2 张大图');
    const exportDirectory = path.join(data, 'batch-export');
    await fs.mkdir(exportDirectory);
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, exportDirectory);
    await page.locator('#saveGeneration').click();
    await page.waitForFunction(() => document.getElementById('generationStatus').textContent.startsWith('已导出 2 张图片'));
    const batchFolders = (await fs.readdir(exportDirectory)).filter(entry => entry.startsWith('Xiaoxiao-image-'));
    assert.equal(batchFolders.length, 1);
    assert.equal((await fs.readdir(path.join(exportDirectory, batchFolders[0]))).length, 2);

    await page.locator('#generationTabVideo').click();
    await page.locator('#generationVideoPrompt').fill('海浪慢慢涌向岸边');
    await page.locator('#runGeneration').click();
    try { await page.locator('video.generation-result').waitFor(); }
    catch (error) {
      console.error('Video generation diagnostics:', await page.locator('#generationStatus').textContent(), requests, errors);
      throw error;
    }
    await page.waitForFunction(() => document.getElementById('generationStatus').textContent === '生成完成，可以播放或保存文件。');

    await page.locator('#generationVideoPrompt').fill('镜头拉远');
    await page.locator('#runGeneration').click();
    await page.locator('.creation-turn').nth(1).locator('video').waitFor();
    assert.match(videoPrompts[1], /海浪慢慢涌向岸边[\s\S]+镜头拉远/);
    assert.doesNotMatch(videoPrompts[1], /玻璃/);
    await page.locator('#generationTabAudio').click();
    await page.locator('#generationAudioPrompt').fill('欢迎来到创作中心');
    await page.locator('#runGeneration').click();
    await page.locator('audio.generation-result-audio').waitFor();
    await page.waitForFunction(() => document.getElementById('generationStatus').textContent === '生成完成，可以播放或保存文件。');
    await page.locator('#generationTabImage').click();
    const imageField = page.locator('#generationImagePrompt');
    const history = page.locator('#generationHistory .generation-history-item');
    assert.equal(await imageField.inputValue(), '');
    await page.locator('.generation-result').nth(2).waitFor();
    assert.equal(await history.count(), 3);
    await imageField.fill('未发出的草稿');
    const first = page.locator('.creation-turn').first();
    await first.getByRole('button', {name:'编辑这轮提示词'}).click();
    assert.equal(await imageField.inputValue(), imagePrompts[0]);
    await page.locator('#cancelCreationEdit').click();
    assert.equal(await imageField.inputValue(), '未发出的草稿');
    await first.getByRole('button', {name:'重新生成这一轮'}).click();
    await page.locator('.creation-turn').nth(2).locator('img').waitFor();
    assert.equal(imagePrompts[2], imagePrompts[0]);
    assert.equal(await imageField.inputValue(), '未发出的草稿');
    await first.getByRole('button', {name:'编辑这轮提示词'}).click();
    await imageField.fill('海边的塔');
    await page.locator('#runGeneration').click();
    await page.locator('.creation-turn').nth(3).locator('img').waitFor();
    assert.equal(imagePrompts[3], '海边的塔');
    assert.equal(await imageField.inputValue(), '未发出的草稿');
    await page.locator('#generationNew').click();
    assert.equal(await page.locator('.creation-turn').count(), 0);
    await imageField.fill('模拟失败');
    await page.locator('#runGeneration').click();
    await page.locator('.creation-turn[data-state=failed]').waitFor();
    await page.getByRole('button', {name:'重新生成这一轮'}).click();
    await page.locator('.creation-turn').nth(1).locator('img').first().waitFor();
    assert.equal(imagePrompts.at(-1), '模拟失败');
    await history.filter({hasText:'一个玻璃质感的海面'}).click();
    assert.equal(await imageField.inputValue(), '未发出的草稿');
    assert.equal(await page.locator('.creation-turn').count(), 4);
    await page.reload();
    await enterWorkspace(page);
    await page.locator('#openGenerationStudio').click();
    await history.filter({hasText:'一个玻璃质感的海面'}).click();
    await page.locator('.creation-turn').last().locator('img').waitFor();
    assert.equal(await page.locator('.creation-question').count(), 4);
    assert.equal(await history.count(), 4);
    assert.equal(await imageField.inputValue(), '未发出的草稿');
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
    await page.locator('#openCreationSettings').waitFor();
    assert(await page.locator('#creationInspector').isHidden());
    await page.locator('#generationNew').click();
    await imageField.fill('未生成的封面草稿');
    await page.locator('#openCreationSettings').click();
    await page.locator('#creationSettingsDialog[open] #generationImageSize').selectOption('1024x1536');
    await page.keyboard.press('Escape');
    await page.locator('#creationSettingsDialog').waitFor({state:'hidden'});
    await page.waitForFunction(() => document.activeElement.id === 'openCreationSettings');
    await page.reload();
    await enterWorkspace(page);
    await page.locator('#openGenerationStudio').click();
    await history.filter({hasText:'未生成的封面草稿'}).click();
    assert.equal(await imageField.inputValue(), '未生成的封面草稿');
    await page.locator('#openCreationSettings').click();
    assert.equal(await page.locator('#generationImageSize').inputValue(), '1024x1536');
    await page.locator('#creationSettingsDialog').getByRole('button', {name:'完成'}).click();
    const stage = await page.locator('#generationOutput').boundingBox();
    const composer = await page.locator('#generationComposer').boundingBox();
    assert(stage.width > 520 && Math.abs(stage.x - composer.x) < 2);
    assert(composer.y + composer.height <= 600);
    if (qa) await page.screenshot({path:path.join(qa, 'creation-compact.png'), scale:'css'});
    await imageField.fill('');
    await history.filter({hasText:'未生成的封面草稿'}).waitFor({state:'detached'});
    await page.locator('#generationFocus').click();
    await page.locator('#openCreationSettings').click();
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
    assert(await page.locator('#creationSettingsDialog').isVisible());
    await page.keyboard.press('Escape');
    await page.locator('#generationFocus').click();
    assert(await page.locator('#creationInspector').isVisible());
    assert.deepEqual(errors, []);
    console.log('PASS: Image, asynchronous video, and speech generation, result previews, and generated-file export.');
  } finally {
    if (app) await app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(data, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
