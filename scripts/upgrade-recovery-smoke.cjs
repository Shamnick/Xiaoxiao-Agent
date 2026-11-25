'use strict';

// Run each signed package against a newly created profile on the same Mac.
const { _electron: electron } = require('playwright');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const enter = require('./enter-workspace.cjs');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=';
const oldExe = process.env.XIAOXIAO_OLD_EXECUTABLE;
const newExe = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
const qa = process.env.XIAOXIAO_SMOKE_QA_DIR;

async function run() {
  assert(oldExe && newExe && oldExe !== newExe, 'Set both executable paths to different packaged builds');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-upgrade-'));
  const profile = path.join(root, 'profile');
  const backup = path.join(root, 'backup');
  const restored = path.join(root, 'restored');
  let requests = 0, app, page;
  const server = http.createServer((req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/images/generations') return res.end(JSON.stringify({data:[{b64_json:png}]}));
    if (req.method === 'POST' && req.url === '/v1/chat/completions') return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'工作坊改到周五。'},finish_reason:'stop'}]}));
    res.writeHead(404).end();
  });
  async function launch(executablePath, dir) {
    app = await electron.launch({executablePath,args:[],env:{...process.env,XIAOXIAO_SMOKE_DIR:dir}});
    const info = await app.evaluate(({app})=>({version:app.getVersion(),dir:app.getPath('userData')}));
    assert.equal(info.dir, dir);
    page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    await enter(page);
    return info.version;
  }
  async function close() { if (app) { await app.close(); app = null; } }
  try {
    server.listen(0, '127.0.0.1');
    await once(server,'listening');
    const from = await launch(oldExe,profile);
    const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
    const ids = await page.evaluate(async baseUrl => {
      const providerId = await nova.providers.save({name:'升级验证',kind:'openai-compatible',baseUrl,model:'fixture',stream:false});
      await nova.preferences.set({key:'textSize',value:'large'});
      await nova.preferences.set({key:'defaultModel',value:providerId});
      const c = await nova.conversations.create({title:'升级前的会话',providerId});
      await nova.conversations.save({id:c.id,pinned:true});
      await nova.chat.send({conversationId:c.id,requestId:crypto.randomUUID(),text:'活动改到周五'});
      return {providerId,conversationId:c.id};
    },baseUrl);
    // Reload so the old creation workspace sees the saved connection.
    await page.reload();
    await enter(page);
    await page.locator('#openGenerationStudio').click();
    await page.locator('#generationImagePrompt').fill('升级前的作品');
    await page.locator('#runGeneration').click();
    await page.locator('.generation-result').waitFor();
    await page.locator('#generationImagePrompt').fill('升级前未提交的草稿');
    await close();
    await fs.cp(profile,backup,{recursive:true});
    const before = requests;
    assert.equal(before,2);
    async function verify(dir) {
      const version = await launch(newExe,dir);
      assert.notEqual(version,from);
      const result = await page.evaluate(async ids => {
        const c = (await nova.conversations.list()).find(row=>row.id===ids.conversationId);
        const p = (await nova.providers.list()).find(row=>row.id===ids.providerId);
        const prefs = await nova.preferences.get();
        return {title:c?.title,pinned:c?.pinned,text:c?.messages.map(m=>m.content),connection:p?.baseUrl,
          model:p?.model,defaultModel:prefs.defaultModel,textSize:prefs.textSize};
      },ids);
      assert.deepEqual(result,{title:'升级前的会话',pinned:true,text:['活动改到周五','工作坊改到周五。'],connection:baseUrl,
        model:'fixture',defaultModel:ids.providerId,textSize:'large'});
      await page.locator('#openGenerationStudio').click();
      await page.locator('#generationHistory button').filter({hasText:'升级前的作品'}).click();
      await page.locator('.generation-result').waitFor();
      assert.equal(await page.locator('#generationImagePrompt').inputValue(),'升级前未提交的草稿');
      const output = path.join(dir,'restored.png');
      await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},output);
      await page.locator('#saveGeneration').click();
      await page.getByText('作品已导出。',{exact:true}).waitFor();
      assert.equal((await fs.readFile(output)).toString('base64'),png);
      assert.equal(requests,before);
      await close();
      return version;
    }
    const to = await verify(profile);
    await fs.cp(backup,restored,{recursive:true});
    await verify(restored);
    const report = {from,to,platform:process.platform,arch:process.arch,upgrade:true,restored:true,
      verified:['messages','pin','model connection','preferences','media history','unsent draft','export bytes'],repeatRequests:requests-before};
    if (qa) {
      await fs.mkdir(qa,{recursive:true});
      await fs.writeFile(path.join(qa,'upgrade-'+from+'-to-'+to+'.json'),JSON.stringify(report,null,2));
    }
    console.log('PASS',report);
  } finally {
    try { await close(); } finally { server.closeAllConnections(); server.close(); await fs.rm(root,{recursive:true,force:true}); }
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
