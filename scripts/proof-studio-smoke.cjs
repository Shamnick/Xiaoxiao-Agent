const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Store } = require('../src/store');
const { _electron: electron } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-proof-'));
  const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
  const calls = [];
  const slowRequest = Promise.withResolvers();
  const slowAborted = Promise.withResolvers();
  const retryRequest = Promise.withResolvers();
  const retryAborted = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({url:req.url,body});
    if (calls.length === 2 || calls.length === 3) {
      const [received, closed] = calls.length === 2 ? [slowRequest, slowAborted] : [retryRequest, retryAborted];
      received.resolve();
      res.once('close', () => closed.resolve());
      return;
    }
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({
      choices:[{message:{role:'assistant',content:'周末来工作室见。'},finish_reason:'stop'}]
    }));
  });
  let app;
  try {
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    new Store(data).write('providers',[{id:'fixture',kind:'openai-compatible',name:'隔离服务',model:'rewrite',
      baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',stream:false}]);
    const launch = () => electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: root,
      env: { ...process.env, XIAOXIAO_SMOKE_DIR: data, XIAOXIAO_SMOKE_SHOW: '1' } });
    app = await launch();
    let page = await app.firstWindow();
    page.setDefaultTimeout(9000);
    const errors = [], network = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/^https?:/.test(r.url())) network.push(new URL(r.url()).origin); });
    const node = id => page.locator('#' + id);
    const text = id => node(id).innerText();
    const focus = id => page.waitForFunction(id => document.activeElement.id === id, id);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await node('presenceKnot').click();
    await node('prompt').fill('保留我的对话草稿');
    await node('openProofFromKnot').click();
    await focus('proofTitleObject');
    const original = await text('proofTitleObject');
    const art = page.locator('.proof-art');
    const originalArt = await art.getAttribute('src');
    const output = process.env.XIAOXIAO_SMOKE_QA_DIR;
    if (output) await fs.mkdir(output,{recursive:true});
    async function exportPoster(label, cancelFirst = false) {
      const file = path.join(output || data,label+'.png');
      await node('proofExport').click();
      await node('proofDeliveryImage').waitFor();
      const expected = await node('proofDeliveryImage').getAttribute('src');
      if (cancelFirst) {
        const canceledFile = path.join(data,'canceled.png');
        await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:true,filePath:file});},canceledFile);
        await node('proofSavePng').click();
        await page.getByText('已取消，仍可继续保存。',{exact:true}).waitFor();
        assert.equal(await fs.stat(canceledFile).catch(()=>null),null);
      }
      await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
      await node('proofSavePng').click();
      await page.getByText('海报已保存。',{exact:true}).waitFor();
      const bytes = await fs.readFile(file);
      assert.equal(bytes.toString('base64'),expected.slice('data:image/png;base64,'.length));
      assert.equal(bytes.readUInt32BE(16),1440);
      assert.equal(bytes.readUInt32BE(20),900);
      const artPixels = await app.evaluate(({nativeImage},file)=>{
        const image = nativeImage.createFromPath(file);
        return image.crop({x:740,y:135,width:620,height:665}).toBitmap().toString('base64');
      },file);
      await page.keyboard.press('Escape');
      await focus('proofExport');
      return {bytes,artPixels};
    }
    const initial = await exportPoster('poster-original',true);
    await node('proofPrompt').fill('口语一点，底图留着');
    await node('proofPreview').click();
    await focus('proofTitleObject');
    assert.match(await text('proofStatus'), /标题、正文或旁白/);
    await page.keyboard.press('Enter');
    await focus('proofAccept');
    assert.equal(await text('proofBefore'), original);
    const changed = await text('proofAfter');
    assert.notEqual(changed, original);
    assert.equal(await text('proofTitleObject'), original);
    assert(await node('proofExport').isDisabled());
    if (output) {
      await fs.mkdir(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'proof-comparison.png'), scale: 'css' });
    }
    await page.keyboard.press('Enter');
    assert.equal(await text('proofTitleObject'), changed);
    assert.equal(await text('proofVoiceObject'), original);
    assert.equal(await art.getAttribute('src'), originalArt);
    const edited = await exportPoster('poster-edited');
    assert.notDeepEqual(edited.bytes, initial.bytes);
    assert.equal(edited.artPixels, initial.artPixels);
    await node('proofSync').click();
    await node('proofDiscard').click();
    assert.equal(await text('proofVoiceObject'), original);
    await node('proofSync').click();
    await node('proofAccept').click();
    assert.equal(await text('proofVoiceObject'), changed);
    await node('proofUndo').click();
    assert.equal(await text('proofVoiceObject'), original);
    assert.equal(await text('proofTitleObject'), changed);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    assert.equal(await text('proofTitleObject'), original);
    const reverted = await exportPoster('poster-reverted');
    assert.deepEqual(reverted.bytes,initial.bytes);
    await node('proofBrief').selectOption('invite');
    const otherTitle = await text('proofTitleObject');
    assert.notEqual(otherTitle, original);
    await node('proofVoiceObject').click();
    await node('proofPrompt').fill('自定义指令');
    await node('proofPreview').click();
    assert(await node('proofCompare').isHidden());
    assert.match(await text('proofStatus'), /本地改稿/);
    await node('proofPrompt').fill('改成：周五来工作室看看。');
    await node('proofPreview').click();
    await node('proofAccept').click();
    assert.equal(await text('proofVoiceObject'), '周五来工作室看看。');
    assert.equal(await text('proofTitleObject'), otherTitle);
    await node('proofBrief').selectOption('launch');
    assert.equal(await text('proofVoiceObject'), original);
    await page.keyboard.press('Escape');
    await focus('openProofFromKnot');
    assert.equal(await node('prompt').inputValue(), '保留我的对话草稿');
    await node('toggleSidebar').click();
    await node('openProofFromRail').click();
    await node('proofBrief').selectOption('invite');
    assert.equal(await text('proofVoiceObject'), '周五来工作室看看。');
    assert(await art.evaluate(img => img.complete && img.naturalWidth > 0));
    await node('proofClose').click();
    await focus('openProofFromRail');
    assert(await node('presence').isVisible());
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', e => errors.push(e.message));
    await node('presenceKnot').click();
    await node('openProofFromKnot').click();
    await node('proofBrief').selectOption('invite');
    await page.waitForFunction(() => document.querySelector('#proofVersion').textContent.endsWith('v1'));
    assert.equal(await text('proofVoiceObject'), '周五来工作室看看。');
    await node('proofVoiceObject').click();
    assert.equal(calls.length,0,'local proof operations must never send model requests');
    await node('proofModel').selectOption('fixture');
    await node('proofPrompt').fill('改得更亲切');
    await node('proofPreview').click();
    await focus('proofAccept');
    assert.equal(await text('proofAfter'),'周末来工作室见。');
    assert.equal(calls[0].url,'/v1/chat/completions');
    assert.deepEqual(calls[0].body.messages.map(m=>m.role),['system','user']);
    assert.deepEqual(JSON.parse(calls[0].body.messages[1].content),{target:'voice',selected:'周五来工作室看看。',instruction:'改得更亲切'});
    assert.equal(calls[0].body.tools,undefined);
    await node('proofDiscard').click();
    await node('proofPreview').click();
    const deadline = promise => Promise.race([promise,delay(9000,null,{ref:false}).then(()=>{throw Error('选区请求超时');})]);
    await deadline(slowRequest.promise);
    await node('proofPrompt').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    assert(await node('proofPreview').isDisabled(), 'A pending preview must disable duplicate submission');
    assert.equal(await node('proofForm').getAttribute('aria-busy'), 'true');
    // Exercise the IPC guard independently of the disabled form.
    await assert.rejects(page.evaluate(async () => {
      const proof = window.nova.proof;
      const base = (await proof.read({brief:'invite'})).id;
      return proof.preview({brief:'invite', base, target:'voice', instruction:'重复提交', providerId:'fixture'});
    }), /正在生成提案/);
    await node('proofStopPreview').click();
    await deadline(slowAborted.promise);
    await focus('proofPrompt');
    assert.equal(await node('proofPrompt').inputValue(), '改得更亲切');
    assert.equal(await text('proofVoiceObject'), '周五来工作室看看。');
    assert(await node('proofCompare').isHidden());
    assert.equal(await node('proofForm').getAttribute('aria-busy'), 'false');
    assert.equal(calls.length, 2, 'Only one HTTP request for the pending preview');
    await node('proofPreview').click();
    await deadline(retryRequest.promise);
    await node('proofBodyObject').click();
    await deadline(retryAborted.promise);
    assert(await node('proofCompare').isHidden());
    assert.equal(await text('proofTarget'),'修改海报正文');
    await node('proofVoiceObject').click();
    await node('proofAudio').click();
    await focus('generationAudioPrompt');
    assert.equal(await node('generationAudioPrompt').inputValue(), '周五来工作室看看。');
    if (process.platform === 'darwin') {
      await node('generationAudioModel').selectOption('macos-system-speech');
      await node('generationAudioLocalVoice').selectOption('Tingting');
      assert(await node('generationAudioEndpoint').isHidden());
      await node('runGeneration').click();
      await page.waitForFunction(() => document.querySelector('.creation-turn audio')?.duration > 0);
      const audio = path.join(output || data,'proof-voice.wav');
      await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},audio);
      await node('saveGeneration').click();
      await page.getByText('作品已导出。',{exact:true}).waitFor();
      const bytes = await fs.readFile(audio);
      assert.equal(bytes.toString('ascii',8,12),'WAVE');
      assert(bytes.length > 4096);
    }
    const check = await page.evaluate(async () => {
      const c = await nova.conversations.create({title:'测试分支'});
      const base = {brief:'invite',conversationId:c.id};
      const old = await nova.proof.read(base);
      const branch = await nova.conversations.branch({id:c.id});
      const fork = {...base,conversationId:branch.id};
      await nova.proof.change({...fork,base:old.id,operation:'edit',target:'body',text:'只在分支更新'});
      return [(await nova.proof.read(base)).current.body,(await nova.proof.read(fork)).current.body];
    });
    assert.notEqual(check[0],check[1]);
    assert.equal(check[1],'只在分支更新');
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    assert.equal(calls.length,3);
    console.log('PASS: PNG preview, export, cancel, unchanged artwork pixels, byte-identical rollback, scoped edits, branch, restart, model cancellation and narration.');
  } finally {
    try { await app?.close(); } finally { server.closeAllConnections(); server.close(); await fs.rm(data, { recursive: true, force: true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
