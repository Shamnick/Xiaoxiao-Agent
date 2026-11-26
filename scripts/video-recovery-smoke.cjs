'use strict';
const { _electron: electron } = require('playwright');
const { Store } = require('../src/store');
const enter = require('./enter-workspace.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');

async function waitForNetworkEvent(event, label) {
  let timer;
  try {
    return await Promise.race([event, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Timed out waiting for ' + label)), 12000);
    })]);
  } finally { clearTimeout(timer); }
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'xiaoxiao-video-resume-'));
  const seen = [];
  const clip = await fs.readFile(path.join(__dirname, 'fixtures', 'moving-square.mp4'));
  let complete = false;
  let delivery;
  let heldQuery;
  let closedQuery;
  const server = http.createServer((req,res) => {
    seen.push(req.method + ' ' + req.url);
    if (req.method === 'POST' && req.url === '/v1/videos/delivery-task/cancel') {
      const status = delivery === 'confirm-cancel' ? 'cancelled' : 'pending';
      return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'delivery-task',status}));
    }
    if (delivery) {
      if (req.method === 'POST' && req.url === '/v1/videos') {
        return res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({
          id:'delivery-task', video_url:`http://127.0.0.1:${server.address().port}/first-download`
        }));
      }
      if (req.url === '/first-download') return res.writeHead(503).end();
      if (req.url === '/v1/videos/delivery-task') {
        if (delivery === 'hold') {
          res.once('close', closedQuery);
          heldQuery();
          return;
        }
        if (delivery === 'offline') return res.writeHead(503).end();
        return res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({status:'completed'}));
      }
      if (req.url === '/v1/videos/delivery-task/content') {
        return res.writeHead(200, {'content-type':'video/mp4'}).end(delivery === 'ready' ? clip : undefined);
      }
      return res.writeHead(404).end();
    }
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
    const connection = {id:'local',model:'fixture',kind:'ollama',name:'本地验证',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'};
    db.write('providers',[connection]);
    let page = await launch();
    await page.locator('#generationTabVideo').click();
    await page.locator('#generationVideoPrompt').fill('恢复验证');
    await page.locator('#runGeneration').click();
    // Do not kill on an unresolved Promise. Wait for the receipt actually written by the main process.
    for (const deadline = Date.now() + 12000; ; ) {
      if (Object.values(db.read('video-receipts', {})).some(receipt => receipt.remoteId === 'original-task')) break;
      assert(Date.now() < deadline, 'Original video receipt did not reach disk');
      await delay(25);
    }
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

    const start = seen.length;
    delivery = 'offline';
    await page.locator('#generationNew').click();
    await page.locator('#generationVideoPrompt').fill('找回下载失败的视频');
    await page.locator('#runGeneration').click();
    const preview = page.locator('.creation-preview');
    const resume = page.getByRole('button', {name:'继续查询原视频'});
    await preview.filter({hasText:'读取生成结果失败 HTTP 503'}).waitFor();
    await resume.waitFor();
    await app.close();
    page = await launch();
    await page.locator('#generationHistory button').filter({hasText:'找回下载失败的视频'}).click();
    const retry = page.getByRole('button', {name:'继续查询原视频'});
    const turn = page.locator('.creation-preview');

    db.write('providers', [{...connection, baseUrl:connection.baseUrl + '/changed'}]);
    await retry.click();
    await turn.filter({hasText:'原连接已更改'}).waitFor();
    assert.deepEqual(seen.slice(start), ['POST /v1/videos', 'GET /first-download']);
    db.write('providers', [connection]);
    await retry.click();
    await turn.filter({hasText:'视频任务查询失败 HTTP 503'}).waitFor();

    delivery = 'empty';
    await retry.click();
    await turn.filter({hasText:'视频结果为空'}).waitFor();
    assert(await page.locator('#saveGeneration').isHidden());

    delivery = 'hold';
    const started = new Promise(resolve => { heldQuery = resolve; });
    const stopped = new Promise(resolve => { closedQuery = resolve; });
    await retry.click();
    await turn.filter({hasText:'正在查询视频任务 · 第 1 次'}).waitFor();
    await waitForNetworkEvent(started, 'status GET');
    await page.locator('#cancelGeneration').click();
    await turn.filter({hasText:'已停止本机等待'}).waitFor();
    await waitForNetworkEvent(stopped, 'status GET disconnect');

    delivery = 'ready';
    await retry.click();
    await page.waitForFunction(() => {
      const video = document.querySelector('.creation-turn video');
      return video?.videoWidth === 64 && video.videoHeight === 64 && video.duration > 0;
    });
    await app.evaluate(({dialog}, file) => { dialog.showSaveDialog = async () => ({canceled:false, filePath:file}); }, output);
    await page.locator('#saveGeneration').click();
    await page.getByText('作品已导出。',{exact:true}).waitFor();
    assert.deepEqual(await fs.readFile(output), clip);
    const status = 'GET /v1/videos/delivery-task';
    const content = status + '/content';
    assert.deepEqual(seen.slice(start), ['POST /v1/videos', 'GET /first-download', status, status, content, status, status, content]);
    assert.equal(Object.values(await page.evaluate(() => nova.generation.receipts())).includes('accepted'), false);
    console.log('PASS: 1 POST, 4 status GETs, 3 download GETs, 0 requests to changed route. Recovered after 503, empty file, restart and stop; decoded 64×64 MP4 and matched exported bytes.');
    await page.locator('#generationNew').click();
    await page.locator('#generationPanelVideo summary').click();
    await page.locator('#generationVideoCancelEndpoint').fill('/videos/{id}/cancel');
    await page.locator('#generationVideoPrompt').fill('取消原服务任务');
    await page.locator('#runGeneration').click();
    const cancel = page.getByRole('button', {name:'取消服务端任务'});
    await cancel.waitFor();
    const offset = seen.length;
    page.once('dialog', dialog => dialog.dismiss());
    await cancel.click();
    assert.equal(seen.length, offset);
    db.write('providers', [{...connection, baseUrl:connection.baseUrl + '/changed'}]);
    page.once('dialog', dialog => dialog.accept());
    await cancel.click();
    await page.locator('.creation-preview').filter({hasText:'原连接已更改'}).waitFor();
    assert.equal(seen.length, offset);
    db.write('providers', [connection]);
    page.once('dialog', dialog => dialog.accept());
    await cancel.click();
    await page.locator('.creation-preview').filter({hasText:'服务尚未确认'}).waitFor();
    delivery = 'confirm-cancel';
    page.once('dialog', dialog => dialog.accept());
    await cancel.click();
    await page.locator('.creation-preview').filter({hasText:'服务已确认取消'}).waitFor();
    await app.close();
    page = await launch();
    await page.locator('#generationHistory button').filter({hasText:'取消原服务任务'}).click();
    await page.locator('.creation-preview').filter({hasText:'服务已确认取消'}).waitFor();
    assert(await page.getByRole('button', {name:'继续查询原视频'}).isHidden());
    assert.deepEqual(seen.slice(offset), Array(2).fill('POST /v1/videos/delivery-task/cancel'));
    console.log('PASS: remote cancellation stayed on the original task and route; pending and confirmed results survived without resubmission.');
  } finally { await app?.close(); server.closeAllConnections(); server.close(); await fs.rm(dir,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
