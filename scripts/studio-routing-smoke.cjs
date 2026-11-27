'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {createServer} = require('node:http');
const {_electron: electron} = require('playwright');
const {Store} = require('../src/store');
const enterWorkspace = require('./enter-workspace.cjs');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-routing-'));
  const requests = [];
  const ids = ['gpt-image-test', 'sora-test', 'tts-test'];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return res.end(JSON.stringify({data:ids.map(id => ({id}))}));
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const {model} = JSON.parse(raw);
    requests.push([req.url, model]);
    // No generation service or credentials needed to inspect the app's actual POST.
    res.writeHead(422).end('Fixture has received the request');
  });
  let app;
  async function launch(expected = 'chat') {
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    app = await electron.launch({executablePath, args:executablePath ? [] : ['.'], cwd:path.resolve(__dirname,'..'),
      env:{...process.env, XIAOXIAO_SMOKE_DIR:dir}});
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await enterWorkspace(page);
    await page.locator('#openGenerationStudio').click();
    await page.locator('#generationImageModel option[value="'+expected+'"]').waitFor({state:'attached'});
    return page;
  }
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const store = new Store(dir);
    const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
    store.write('providers', ['chat','other'].map(id => ({id, name:id, kind:'ollama', model:id, baseUrl})));
    let page = await launch();
    await page.locator('#generationImageModel').selectOption('chat');
    await page.locator('#generationImagePrompt').fill('旧会话失败轮次');
    await page.locator('#runGeneration').click();
    await page.locator('.creation-turn[data-state=failed]').waitFor();
    assert.deepEqual(requests, [['/v1/images/generations', 'chat']]);
    await page.locator('#generationNew').click();
    async function choose(kind, model) {
      await page.locator('#choose'+kind+'Model').click();
      await page.locator('#imageCatalogList').selectOption(model);
      await page.locator('#imageCatalogUse').click();
      await page.locator('#imageModelDialog').waitFor({state:'hidden'});
      return page.locator('#generation'+kind+'Model').inputValue();
    }
    const imageId = await choose('Image', ids[0]);
    const openOld = () => page.locator('#generationHistory button').filter({hasText:'旧会话失败轮次'}).click();
    await page.locator('#generationPanelImage details summary').click();
    await page.locator('#generationImageEndpoint').fill('/custom-image');
    await openOld();
    assert.equal(await page.locator('#generationImageEndpoint').inputValue(), '/custom-image');
    assert.equal(await page.locator('#generationImageModel').inputValue(), imageId, 'opening history reverted the configured image model');
    await page.locator('.creation-turn button[aria-label*="重新生成"]').click();
    await page.locator('.creation-turn[data-state=failed]').nth(1).waitFor();
    assert.deepEqual(requests[1], ['/v1/custom-image', ids[0]]);
    const original = await page.evaluate(async () => (await archiveOperation('readonly', r => r.getAll())).find(r => r.fields.generationImageModel === 'chat'));
    assert.equal(original.modelLabel, 'chat');
    const picked = {};
    for (const [i, kind] of ['Video','Audio'].entries()) {
      await page.locator('#generationTab'+kind).click();
      picked[kind] = await choose(kind, ids[i+1]);
      await page.locator('#generation'+kind+'Prompt').fill('检查路由 '+kind);
      await page.locator('#runGeneration').click();
      await page.locator('.creation-turn[data-state=failed]').waitFor();
      assert.deepEqual(requests.at(-1), [i ? '/v1/audio/speech' : '/v1/videos',ids[i+1]]);
    }
    await app.close(); app = null;
    page = await launch();
    assert.equal(await page.locator('#generationImageModel').inputValue(), imageId);
    await openOld();
    assert.equal(await page.locator('#generationImageEndpoint').inputValue(), '/custom-image');
    for (const kind of ['Video','Audio']) {
      await page.locator('#generationTab'+kind).click();
      await page.locator('#generationNew').click();
      assert.equal(await page.locator('#generation'+kind+'Model').inputValue(), picked[kind]);
    }
    await page.locator('#manageGenerationModels').click();
    await page.locator('#providerList button').filter({hasText:'other'}).click();
    await page.locator('#providerForm [name=name]').fill('other edited');
    await page.locator('#providerSubmit').click();
    await page.locator('#settingsStatus').filter({hasText:'已保存'}).waitFor();
    await page.locator('#closeSettings').click();
    assert.equal(await page.locator('#modelSelect').inputValue(), 'chat', 'saving an unrelated connection switched the chat');
    // Deleting a saved route must require a new choice, even if other connections remain.
    await page.evaluate(() => nova.providers.delete('chat'));
    await page.locator('#closeGenerationStudio').click();
    await page.locator('#openGenerationStudio').click();
    await page.waitForFunction(() => document.getElementById('generationAudioModel').value === '');
    await page.locator('#generationAudioPrompt').fill('已删除模型');
    assert(await page.locator('#runGeneration').isDisabled());
    if (process.platform === 'darwin') {
      await page.locator('#generationAudioModel').selectOption('macos-system-speech');
      await app.close(); app = null;
      page = await launch('other');
      await page.locator('#generationTabAudio').click();
      assert.equal(await page.locator('#generationAudioModel').inputValue(), 'macos-system-speech');
    }
    assert.equal(requests.length, 4);
    console.log('PASS: exact studio routes, retry after switching model, historical receipt, catalog, restart, independent chat, removed model and local voice.');
  } finally {
    await app?.close();
    server.closeAllConnections(); server.close();
    await fs.rm(dir, {recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
