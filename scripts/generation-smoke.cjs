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
// Distinct, lossless test images made in the renderer; no remote media calls.
async function seascapeFixtures(page) {
  return page.evaluate(() => [
    ['#344f73', '#aacddb', '#f4e7cd', '#5e8599'],
    ['#4f4a75', '#e2a688', '#ffe0a3', '#7e758a'],
    ['#353e63', '#bd93aa', '#ffceb4', '#706c91']
  ].map(([sky, horizon, light, sea], i) => {
    const canvas = document.createElement('canvas');
    canvas.width = 560;
    canvas.height = 440;
    const ctx = canvas.getContext('2d');
    const fill = (top, bottom, y1, y2) => {
      const gradient = ctx.createLinearGradient(0, y1, 0, y2);
      gradient.addColorStop(0, top);
      gradient.addColorStop(1, bottom);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, y1, 560, y2 - y1);
    };
    fill(sky, horizon, 0, 260);
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(345 + i * 42, 130 + i * 31, 34, 0, Math.PI * 2);
    ctx.fill();
    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath();
      ctx.moveTo(0, 260);
      for (let x = 0; x <= 560; x += 2) {
        const y = 190 + 20 * layer + 27 * Math.sin(x / 129 + layer + i / 3) + 8 * Math.cos(x / 46 + layer);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(560, 260);
      ctx.fillStyle = sky;
      ctx.globalAlpha = .28 + layer * .22;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    fill(horizon, sea, 260, 440);
    for (let y = 262; y < 440; y += 2) {
      const offset = 345 + i * 42 + 11 * Math.sin(y * 1.4);
      const width = 7 + (y - 260) * .22 * (.6 + .4 * Math.cos(y / 2));
      ctx.fillStyle = light;
      ctx.globalAlpha = .5 - (y - 260) / 450;
      ctx.fillRect(offset - width, y, width * 2, 1);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }));
}

async function run() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-generation-smoke-'));
  let app, png, variants;
  const requests = [];
  const edits = [];
  let releaseFirst;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  const imagePrompts = [], videoPrompts = [], audioPrompts = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/v1/models') {
      return res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({data:[{id:'fixture-chat'},{id:'fixture-generation',capabilities:{image:{sizes:['1024x1024','1024x1536','3840x2160'],qualities:['high'], counts:[1,2,4]}}},{id:'gpt-image-fixture'}]}));
    }
    if (req.url === '/v1/images/edits' && req.method === 'POST') {
      const form = await new Response(req, {headers: req.headers}).formData();
      const image = form.get('image');
      edits.push({ prompt: form.get('prompt'), model: form.get('model'), name: image.name,
        data: Buffer.from(await image.arrayBuffer()).toString('base64') });
      return res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({data:[{b64_json:variants[1]}]}));
    }
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url === '/v1/images/generations') {
        imagePrompts.push(body.prompt);
        if (imagePrompts.length === 1) {
          assert.equal(body.size, '3840x2160');
          assert.equal(body.quality, 'high');
          assert(!Object.hasOwn(body, 'style'));
          await firstResponse;
        }
        if (body.prompt === '模拟失败' && imagePrompts.filter(prompt => prompt === '模拟失败').length === 1) {
          return res.writeHead(503).end();
        }
        if (body.n === 2) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: variants.map(b64_json => ({ b64_json })) }));
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
        audioPrompts.push(body.input);
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
    [png, ...variants] = await seascapeFixtures(page);
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

    await page.locator('#generationEvidence').filter({hasText:'请选择'}).waitFor();
    const chatModel = await page.locator('#modelSelect').inputValue();
    await page.locator('#chooseImageModel').click();
    await page.locator('#imageCatalogList option').first().waitFor({state:'attached'});
    assert.equal(await page.locator('#imageCatalogList option').first().textContent(), 'gpt-image-fixture');
    await page.locator('#imageCatalogList').selectOption('gpt-image-fixture');
    await page.locator('#imageCatalogUse').click();
    await page.locator('#imageModelDialog').waitFor({state:'hidden'});
    assert.match(await page.locator('#generationImageModel option:checked').textContent(), /gpt-image-fixture/);
    assert.equal(await page.locator('#modelSelect').inputValue(), chatModel);
    await page.locator('#generationImageModel').selectOption('fixture-vision');
    await page.locator('#generationPreset').click();
    await page.locator('#generationPresetMenu:popover-open').waitFor();
    assert.equal(await page.locator('#generationPresetMenu button').count(), 4);
    await page.locator('#generationPresetMenu button').first().click();
    assert.match(await page.locator('#generationImagePrompt').inputValue(), /产品摄影/);
    await page.locator('#generationFocus').click();
    assert.equal(await page.locator('#generationStudio').evaluate(dialog => dialog.classList.contains('generation-focus')), true);
    await page.locator('#generationFocus').click();

    await page.locator('#generationImageSize').selectOption('3840x2160');
    await page.locator('#generationImageQuality').selectOption('high');
    assert.equal(await page.locator('#generationImageStyle').count(), 0);
    await page.locator('#generationImagePrompt').fill('一个玻璃质感的海面');
    await page.locator('#runGeneration').click();
    const live = page.locator('.creation-telemetry');
    await live.getByText('等待服务响应', {exact:true}).waitFor();
    const timer = live.locator('[data-metric="0"] dd');
    const initialTime = await timer.textContent();
    await page.waitForFunction(t => document.querySelector('.creation-telemetry dd')?.textContent !== t, initialTime);
    assert.equal(await live.locator('progress').getAttribute('value'), null);
    if (qa) await page.screenshot({path:path.join(qa,'image-live-metrics.png'), scale:'css'});
    releaseFirst();
    await page.locator('.generation-result').waitFor();
    await live.getByText('生成完成', {exact:true}).waitFor();
    assert.equal(await live.locator('[data-metric="2"] dd').textContent(), '200');
    await page.getByText('560 × 440 · PNG', {exact:true}).waitFor();
    assert.equal(await page.locator('.generation-result').getAttribute('alt'), '生成的图片 1');
    assert.equal(await page.locator('.generation-result').evaluate(image => image.naturalWidth), 560);
    await page.locator('#generationEvidence').filter({hasText:'有可预览的作品'}).waitFor();
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
    assert.equal(await page.locator('#galleryImage').evaluate(image => image.clientWidth), 560);
    await page.locator('#gallerySave').click();
    await page.getByText('图片已导出', { exact: true }).waitFor();
    assert.equal((await fs.readFile(saved)).toString('base64'), variants[1]);
    const compare = page.getByRole('button', { name: '版本对比' });
    await compare.press('Enter');
    const left = page.getByRole('region', { name: '左图' });
    const right = page.getByRole('region', { name: '右图' });
    const leftMenu = left.getByRole('combobox');
    const rightMenu = right.getByRole('combobox');
    async function verifySide(pane, label, bytes) {
      const choice = pane.getByRole('combobox');
      assert.equal(await choice.inputValue(), label);
      const image = pane.getByRole('img');
      await image.waitFor();
      assert.equal(await image.evaluate(img => img.src.split(',')[1]), bytes);
    }
    await verifySide(left, '第 1 轮 · 图 1', png);
    await verifySide(right, '第 2 轮 · 图 2', variants[1]);
    assert.equal(await leftMenu.locator('option').count(), 3);
    assert(await leftMenu.locator('option').nth(2).isDisabled());
    await rightMenu.focus();
    // Native select popups differ on macOS and Linux. Check the gallery leaves
    // their arrow keys alone, then choose an option through the native control.
    assert(await rightMenu.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowLeft', bubbles: true, cancelable: true
    }))));
    await rightMenu.selectOption({ index: 1 });
    await verifySide(right, '第 2 轮 · 图 1', variants[0]);
    await rightMenu.press('Tab');
    await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === '导出右图原件');
    assert.equal(await left.locator('p').textContent(), '一个玻璃质感的海面');
    assert.equal(await right.locator('p').textContent(), '光线改成黄昏，两张构图');
    if (qa) {
      await page.mouse.move(0, 0);
      await page.locator('#creationGallery').screenshot({path:path.join(qa, 'image-comparison-light.png'), scale:'css', animations:'disabled'});
      await page.emulateMedia({ colorScheme: 'dark' });
      await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
      await page.locator('#creationGallery').screenshot({path:path.join(qa, 'image-comparison-dark.png'), scale:'css', animations:'disabled'});
      await page.emulateMedia({ colorScheme: 'light' });
      await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
    }
    await page.getByRole('button', { name: '交换左右' }).press('Enter');
    await verifySide(left, '第 2 轮 · 图 1', variants[0]);
    await verifySide(right, '第 1 轮 · 图 1', png);
    for (const [pane, side, bytes] of [[left, '左', variants[0]], [right, '右', png]]) {
      await pane.getByRole('button', { name: '导出' + side + '图原件' }).click();
      await page.getByText(side + '图已导出', { exact: true }).waitFor();
      assert.equal((await fs.readFile(saved)).toString('base64'), bytes);
    }
    await compare.click();
    assert.equal(await page.locator('#galleryPosition').textContent(), '2 / 2');
    await compare.press('Enter');
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
    await page.locator('#generationVideoModel').selectOption('fixture-vision');
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
    await page.locator('#generationAudioModel').selectOption('fixture-vision');
    await page.locator('#generationAudioPrompt').fill('欢迎来到创作中心');
    await page.locator('#runGeneration').click();
    await page.locator('audio.generation-result-audio').waitFor();
    await page.waitForFunction(() => document.getElementById('generationStatus').textContent === '生成完成，可以播放或保存文件。');
    const speech = page.locator('#generationAudioPrompt');
    const excerpt = page.locator('#generateSpeechExcerpt');
    const script = '欢迎来到创作中心\n\n  第二段有一句旁白。\n结尾。';
    await page.locator('#generationPanelAudio details summary').click();
    await page.locator('#generationAudioOptions').fill('{"input":"高级参数里的旧全文"}');
    await speech.fill(script);
    await speech.evaluate(field => field.setSelectionRange(13,13));
    await page.getByRole('button', {name:'生成第 2 段'}).click();
    const audioTurn = page.locator('.creation-turn').nth(1);
    await audioTurn.locator('audio').waitFor();
    assert.equal(await audioTurn.locator('.creation-excerpt-label').innerText(), '第 2 段');
    assert.equal(await speech.inputValue(), script);
    await speech.evaluate(field => {
      const start = field.value.indexOf('一句');
      field.setSelectionRange(start, start + 4);
    });
    await page.getByRole('button', {name:'生成选区'}).click();
    await page.locator('.creation-turn').nth(2).locator('audio').waitFor();
    assert.deepEqual(audioPrompts, ['欢迎来到创作中心','第二段有一句旁白。','一句旁白']);
    await speech.evaluate(field => field.setSelectionRange(field.value.indexOf('\n') + 1, field.value.indexOf('\n') + 1));
    await page.waitForFunction(() => document.getElementById('generateSpeechExcerpt').disabled);
    await page.locator('#generationTabImage').click();
    assert(await excerpt.isHidden());
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
    await page.locator('#generationImageCount').selectOption('1');
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
    await page.locator('#generationImageCount').selectOption('1');
    await imageField.fill('模拟失败');
    await page.locator('#runGeneration').click();
    await page.locator('.creation-turn[data-state=failed]').waitFor();
    await page.locator('.image-issue').getByRole('button', {name:'调整模型与参数'}).click();
    assert.equal(await imageField.inputValue(), '模拟失败');
    assert.equal(imagePrompts.filter(p => p === '模拟失败').length, 1);
    if (qa) await page.screenshot({path:path.join(qa,'image-recovery.png'),scale:'css'});
    await page.locator('#cancelCreationEdit').click();
    await page.getByRole('button', {name:'重新生成这一轮'}).click();
    await page.locator('.creation-turn').nth(1).locator('img').first().waitFor();
    assert.equal(imagePrompts.at(-1), '模拟失败');
    await page.locator('.creation-thumbnail').first().click();
    await page.locator('#creationGallery[open]').waitFor();
    assert(await compare.isHidden());
    await page.keyboard.press('Escape');
    await history.filter({hasText:'一个玻璃质感的海面'}).click();
    assert.equal(await imageField.inputValue(), '未发出的草稿');
    assert.equal(await page.locator('.creation-turn').count(), 4);
    // Simulate a pre-0.6.10 record, then reopen with the first turn offscreen.
    const legacyId = await first.locator('.creation-preview').getAttribute('data-id');
    await page.evaluate(async id => {
      await archiveOperation('readwrite', records => {
        const request = records.get(id);
        request.onsuccess = () => {
          const row = request.result;
          delete row.imageIndices;
          records.put(row);
        };
      });
    }, legacyId);
    await page.reload();
    await enterWorkspace(page);
    await page.locator('#openGenerationStudio').click();
    await history.filter({hasText:'欢迎来到创作中心'}).click();
    assert.equal(await speech.inputValue(), script);
    assert.deepEqual(await page.locator('.creation-excerpt-label').allTextContents(), ['第 2 段','选区']);
    await history.filter({hasText:'一个玻璃质感的海面'}).click();
    await page.locator('.creation-turn').last().locator('img').waitFor();
    assert.equal(await page.locator('.creation-question').count(), 4);
    await page.locator('.creation-turn').last().locator('.creation-thumbnail').click();
    await compare.click();
    await leftMenu.selectOption({ index: 0 });
    await verifySide(left, '第 1 轮 · 图 1', png);
    assert.equal(await rightMenu.locator('option').count(), 5);
    await page.keyboard.press('Escape');
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
    // An imported file is local until submit. A fresh thread has no attachment.
    const uploads = page.locator('#generationReferenceFile');
    const ref = page.locator('#generationReferenceLabel');
    await uploads.setInputFiles({name:'封面.png', mimeType:'image/png', buffer:Buffer.from(png, 'base64')});
    await ref.filter({hasText:'封面.png'}).waitFor();
    await page.locator('#generationEvidence').filter({hasText:'未验证'}).waitFor();
    assert.match(await ref.textContent(), /127\.0\.0\.1/);
    await page.locator('#generationNew').click();
    assert(await ref.isHidden());
    await history.filter({hasText:'封面.png'}).click();
    await ref.waitFor();
    await page.reload();
    await enterWorkspace(page);
    await page.locator('#openGenerationStudio').click();
    await history.filter({hasText:'封面.png'}).click();
    assert.equal(edits.length, 0);
    const original = page.getByRole('img', {name:'本轮参考图 · 封面.png'});
    await original.waitFor();
    assert.equal(await original.evaluate(img => img.src.split(',')[1]), png);
    await imageField.fill('保留轮廓，改成暖色');
    if (qa) {
      await page.emulateMedia({colorScheme:'dark'});
      await page.screenshot({path:path.join(qa,'reference-edit-dark.png'), scale:'css', animations:'disabled'});
      await page.emulateMedia({colorScheme:'light'});
      await page.screenshot({path:path.join(qa,'reference-edit-light.png'), scale:'css', animations:'disabled'});
    }
    await page.getByRole('button', {name:'提交改图'}).click();
    await page.locator('.creation-turn').first().locator('img').waitFor();
    assert.deepEqual(edits[0], {prompt:'保留轮廓，改成暖色', model:'fixture-generation',name:'reference.png',data:png});
    assert(await ref.isHidden());
    await page.locator('.creation-thumbnail').first().click();
    await page.getByRole('button', {name:'用作参考图'}).press('Enter');
    await ref.filter({hasText:'第 1 轮 · 图 1'}).waitFor();
    await page.locator('#generationEvidence').filter({hasText:'有可预览的作品'}).waitFor();
    await imageField.fill('只改背景');
    await page.getByRole('button', {name:'提交改图'}).click();
    await page.locator('.creation-turn').nth(1).locator('img').waitFor();
    assert.equal(edits[1].data, variants[1]);
    assert.equal(edits[1].prompt, '只改背景');
    await page.locator('.creation-turn').first().getByRole('button', {name:'重新生成这一轮'}).click();
    await page.locator('.creation-turn').nth(2).locator('img').waitFor();
    assert.equal(edits[2].data, png);
    await page.locator('.creation-turn').first().getByRole('button', {name:'编辑这轮提示词'}).click();
    await ref.filter({hasText:'封面.png'}).waitFor();
    await page.getByRole('button', {name:'移除参考图'}).click();
    assert(await ref.isHidden());
    await page.locator('#cancelCreationEdit').click();
    console.log('PASS: Reference image import, draft recovery, multipart edits, version reuse, scoped retries and removal.');
    assert.deepEqual(errors, []);
    console.log('PASS: Image, video and speech generation, cross-round image comparison, keyboard navigation, scoped history and original-file exports.');
  } finally {
    if (app) await app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(data, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
