'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { _electron } = require('playwright');
const { Store } = require('../src/store');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-metrics-'));
  const store = new Store(dir);
  const gate = Promise.withResolvers();
  const errors = [];
  let app, page, requests = 0;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      assert.equal(JSON.parse(raw).stream_options.include_usage, true);
      const n = ++requests;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
      send({ choices:[{ delta:{ content: n === 1 ? '已整理本周进展。' : n === 2 ? '第二份记录' : '已继续整理记录。' } }] });
      if (n === 1) await gate.promise;
      if (n !== 2) {
        send({ choices:[{ delta:{}, finish_reason:'stop' }] });
        send({ choices:[], usage:{ prompt_tokens:900, completion_tokens:50, total_tokens:950, prompt_tokens_details:{cached_tokens:n === 1 ? 630 : 0} } });
      }
      res.end();
    } catch (err) { errors.push(err.message); res.destroy(); }
  });
  const launch = async () => {
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath, args:executablePath ? [] : ['.'], cwd:root, env:{...process.env,XIAOXIAO_SMOKE_DIR:dir} });
    page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    page.on('pageerror', err => errors.push(err.message));
    await page.locator('#presenceKnot:enabled').waitFor();
  };
  const el = id => page.locator('#' + id);
  const expectText = (id, value) => page.waitForFunction(([id, value]) => document.getElementById(id).textContent === value, [id, value], {timeout:8000});
  const select = async title => {
    await page.keyboard.press('ControlOrMeta+k');
    await el('historyQuery').fill(title);
    await page.locator('#historyResults button').filter({has:page.getByText(title,{exact:true})}).filter({has:page.locator('strong').filter({hasText:new RegExp('^' + title + '$')})}).first().click();
    await expectText('conversationTitle', title);
  };
  const screenshot = async name => {
    const out = process.env.XIAOXIAO_SMOKE_QA_DIR;
    if (!out) return;
    await fs.mkdir(out, {recursive:true});
    await page.screenshot({path:path.join(out,name+'.png'),scale:'css'});
  };
  try {
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    store.write('providers',[{id:'local',kind:'openai-compatible',name:'本地测试',model:'fixture',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'}]);
    store.write('conversations',[{id:'legacy',title:'旧版工作记录',providerId:'local',messages:[{role:'user',content:'工作记录'},{role:'assistant',content:'已记录'}]}]);
    await launch();
    assert.equal(await el('conversationMetrics').isVisible(), false);
    await el('presenceKnot').click();
    const title = '整理本周进展';
    await el('prompt').fill(title);
    await el('prompt').press('Enter');
    await page.locator('#chat .assistant').getByText('已整理本周进展。',{exact:true}).waitFor();
    await expectText('metricSteps','1');
    await expectText('metricRounds','1');
    await expectText('metricTokens','—');
    assert.match(await el('metricContext').innerText(),/^≈\d+%$/);
    await select('旧版工作记录');
    await expectText('metricSteps','—');
    await expectText('metricTokens','—');
    gate.resolve();
    await page.waitForFunction(async()=>!(await nova.chat.runs()).length);
    await expectText('metricTokens','—');
    await select(title);
    await expectText('metricTokens','950');
    await expectText('metricCache','70%');
    const assertAccent = () => page.evaluate(() => {
      const bar = document.querySelector('#conversationMetrics');
      const icon = bar.querySelector('.metric-icon');
      const expected = document.createElement('i');
      expected.style.backgroundColor = 'var(--accent)';
      bar.append(expected);
      const matches = getComputedStyle(icon).backgroundColor === getComputedStyle(expected).backgroundColor;
      expected.remove();
      return matches;
    });
    assert(await assertAccent());
    await screenshot('conversation-metrics');
    await el('metricsToggle').focus();
    await page.keyboard.press('Enter');
    await el('metricsDetail').waitFor();
    assert.match(await el('metricCoverage').innerText(),/1 \/ 1/);
    assert.match(await el('metricBreakdown').innerText(),/900 \/ 50 tok/);
    assert.match(await el('metricFirstBody').innerText(),/\d+ (?:ms|s)/);
    assert.match(await el('metricElapsed').innerText(),/\d+ (?:ms|s)/);
    await screenshot('conversation-metrics-detail');
    assert.match(await el('metricCacheNote').innerText(),/630.*900/);
    const button = await el('metricsToggle').boundingBox(), panel = await el('metricsDetail').boundingBox();
    assert(panel.y >= button.y + button.height - 1 && Math.abs(panel.x + panel.width/2 - button.x - button.width/2) < 8,'detail anchored below metrics');
    await page.keyboard.press('Escape');
    await el('metricsDetail').waitFor({state:'hidden'});
    await el('prompt').fill('继续整理');
    await el('prompt').press('Enter');
    await el('resumeTask').waitFor();
    await expectText('metricRounds','2');
    await expectText('metricSteps','2');
    await expectText('metricTokens','≥950');
    await el('resumeTask').click();
    await expectText('metricSteps','3');
    await expectText('metricTokens','≥1.9K');
    await expectText('metricCache','35%');
    await expectText('metricRounds','2');
    const id = await el('conversationMetrics').getAttribute('data-conversation');
    const branch = await page.evaluate(id=>nova.conversations.branch({id,through:1}),id);
    // Restart to exercise both persisted independent sessions.
    await app.close(); app = null;
    store.write('preferences',{conversationScene:'workspace',appearance:'light'});
    await launch();
    await select(branch.title);
    await expectText('metricTokens','950');
    await expectText('metricRounds','1');
    await expectText('metricCache','70%');
    await select(title);
    await expectText('metricTokens','≥1.9K');
    await expectText('metricCache','35%');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(900,620));
    await page.waitForFunction(()=>window.innerWidth <= 900);
    assert(await assertAccent());
    await screenshot('conversation-metrics-light');
    await page.emulateMedia({colorScheme:'dark'});
    assert(await assertAccent());
    await screenshot('conversation-metrics-dark');
    // The normal workbench split can allocate just 300 px to chat.
    await el('chatColumn').evaluate(node=>{ node.style.flex = '0 0 300px'; });
    const btn = await el('metricsToggle').boundingBox(), col = await el('chatColumn').boundingBox();
    assert(btn.x >= col.x && btn.x+btn.width <= col.x+col.width+1);
    await el('metricsToggle').click();
    const detail = await el('metricsDetail').boundingBox();
    assert(detail.x >= 0 && detail.x + detail.width <= 900);
    assert.deepEqual(errors,[]);
    console.log('PASS: live usage, session switching, failed steps, continuation, branch cutoff, restart, keyboard details, and narrow/light/dark layouts.');
  } finally {
    gate.resolve();
    await app?.close();
    server.closeAllConnections();
    server.close();
    await fs.rm(dir,{force:true,recursive:true});
  }
})().catch(err=>{console.error(err);process.exitCode=1;});
