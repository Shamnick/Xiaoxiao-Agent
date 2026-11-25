'use strict';
const { _electron: electron } = require('playwright');
const { Store } = require('../src/store');
const enter = require('./enter-workspace.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const assert = require('node:assert/strict');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'xiaoxiao-video-resume-'));
  const seen = [];
  let complete = false;
  const server = http.createServer((req,res) => {
    seen.push(req.method + ' ' + req.url);
    if (req.method === 'POST') {
      if (seen.filter(s=>s.startsWith('POST')).length > 1) return req.socket.destroy();
      return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'original-task'}));
    }
    if (req.url.endsWith('/content')) return res.writeHead(200,{'content-type':'video/mp4'}).end('test video bytes');
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({status:complete?'completed':'pending'}));
  });
  let app;
  const launch = async () => {
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    app = await electron.launch({executablePath,args:executablePath?[]:['.'],cwd:path.resolve(__dirname,'..'),
      env:{...process.env,XIAOXIAO_SMOKE_DIR:dir}});
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    await enter(page);
    await page.locator('#openGenerationStudio').click();
    return page;
  };
  try {
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const db = new Store(dir);
    db.write('providers',[{id:'local',model:'fixture',kind:'ollama',name:'本地验证',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'}]);
    let page = await launch();
    await page.locator('#generationTabVideo').click();
    await page.locator('#generationVideoPrompt').fill('恢复验证');
    await page.locator('#runGeneration').click();
    await page.waitForFunction(async()=>Object.values(await nova.generation.receipts()).includes('accepted'));
    const exited = once(app.process(),'exit');
    app.process().kill('SIGKILL');
    await exited;
    complete = true;
    page = await launch();
    await page.locator('#generationHistory button').filter({hasText:'恢复验证'}).click();
    await page.getByRole('button',{name:'继续查询原视频'}).click();
    await page.locator('.creation-turn video').waitFor();
    const output = path.join(dir,'恢复的视频.mp4');
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},output);
    await page.locator('#saveGeneration').click();
    await page.getByText('作品已导出。',{exact:true}).waitFor();
    assert.equal(await fs.readFile(output,'utf8'),'test video bytes');
    assert.equal(seen.filter(s=>s.startsWith('POST')).length,1);
    assert(seen.includes('GET /v1/videos/original-task/content'));
    await page.locator('#generationNew').click();
    await page.locator('#generationVideoPrompt').fill('提交响应丢失');
    await page.locator('#runGeneration').click();
    await page.locator('.creation-preview').filter({hasText:'提交结果未知'}).waitFor();
    page.once('dialog', dialog=>dialog.dismiss());
    await page.getByRole('button',{name:'重新生成这一轮'}).click();
    assert.equal(seen.filter(s=>s.startsWith('POST')).length,2);
    console.log('PASS: video survives process kill, resumes original job with GET, exports exact bytes, and warns on a lost submission response.');
  } finally { await app?.close(); server.closeAllConnections(); server.close(); await fs.rm(dir,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
