'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');
const { Store } = require('../src/store');
const enterWorkspace = require('./enter-workspace.cjs');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-check-'));
  const evidence = process.env.XIAOXIAO_SMOKE_QA_DIR;
  const secret = 'sk-' + randomUUID();
  const requests = [];
  const errors = [];
  const server = http.createServer((req, res) => {
    requests.push({ path:req.url, method:req.method, authorized:req.headers.authorization === 'Bearer ' + secret });
    if (requests.at(-1).authorized) res.end(JSON.stringify({data:[{id:'demo-a'},{id:'demo-b'}]}));
    else res.writeHead(401).end('private fixture detail');
  });
  let app;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = 'http://127.0.0.1:'+server.address().port;
    const text = [secret,address,'测试一下这个，最好给我一个html版的报告就行'].join('\n');
    const store = new Store(dir);
    store.write('conversations',[{id:'old',title:text.slice(0,36),messages:[
      {role:'user', content:text},{role:'assistant', content:'保存操作已取消。'}
    ]}]);
    async function launch() {
      const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
      app = await electron.launch({executablePath,args:executablePath ? [] : ['.'],cwd:path.resolve(__dirname,'..'),env:{...process.env,XIAOXIAO_SMOKE_DIR:dir}});
      const page = await app.firstWindow();
      page.setDefaultTimeout(10000);
      page.on('pageerror',err=>errors.push(err.message));
      await app.evaluate(({shell})=>{ shell.openPath = async file => {globalThis.openedReport=file;return '';}; });
      return page;
    }
    let page = await launch();
    await page.locator('#presenceKnot:enabled').click();
    const send = async () => {
      await page.locator('#prompt').fill(text);
      await page.locator('#send').click();
      await page.locator('#connectionDialog[open]').waitFor();
      assert.equal(await page.locator('#connectionTarget').textContent(),'GET '+address+'/v1/models');
      assert.equal(await page.locator('#connectionKey').inputValue(),secret);
      assert(!(await page.locator('#prompt').inputValue()).includes(secret));
    };
    await send();
    await page.keyboard.press('Escape');
    await page.locator('#connectionDialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('#connectionKey').inputValue(),'');
    assert.equal(requests.length,0);
    assert.equal(store.read('conversations').length,1);
    await send();
    await page.locator('#runConnection').click();
    const open = () => page.getByRole('button',{name:'打开 · 接口检测报告.html',exact:true});
    await open().click();
    const file = await app.evaluate(()=>globalThis.openedReport);
    const html = await fs.readFile(file,'utf8');
    assert(html.includes('模型列表检查通过') && html.includes('模型列表返回 2 项'));
    assert(!html.includes(secret));
    assert.equal(await page.locator('#metricSteps').textContent(),'0');
    assert.equal(await page.locator('#metricRounds').textContent(),'0');
    assert.equal(await page.locator('#prompt').inputValue(),'');
    const saved = store.read('conversations');
    assert(!JSON.stringify(saved).includes(secret.slice(0,20)));
    const id = saved.find(row=>row.id!=='old').id;
    const oldRows = saved.find(row=>row.id==='old');
    assert(oldRows.title.includes('已隐藏密钥'));
    assert.deepEqual(requests,[{path:'/v1/models', method:'GET', authorized:true}]);
    if (evidence) {
      await fs.mkdir(evidence,{recursive:true});
      await fs.copyFile(file,path.join(evidence,'接口检测验收报告.html'));
    }
    await app.close();
    app = null;
    page = await launch();
    await enterWorkspace(page);
    await page.locator('#history [data-session="'+id+'"] .session-link').click();
    await open().click();
    assert.equal(await app.evaluate(()=>globalThis.openedReport),file);
    const legacy = page.locator('#history [data-session="old"] .session-link');
    await legacy.click();
    await page.getByRole('button',{name:'重新检测接口'}).click();
    assert.equal(await page.locator('#connectionKey').inputValue(),'');
    await page.locator('#runConnection').click();
    await open().click();
    const failure = await fs.readFile(await app.evaluate(()=>globalThis.openedReport),'utf8');
    assert(failure.includes('401') && failure.includes('模型列表检查未通过'));
    assert(!failure.includes('private fixture detail'));
    assert.deepEqual(requests.at(1),{path:'/v1/models',method:'GET',authorized:false});
    assert.equal(requests.length,2);
    await page.locator('#composerToolsButton').click();
    await page.getByRole('button',{name:'接口检测',exact:true}).click();
    await page.locator('#connectionAddress').fill('https://example.test/v1?token=test');
    await page.locator('#runConnection').click();
    assert(await page.locator('#connectionAddress').evaluate(el=>!el.validity.valid));
    await page.locator('#cancelConnection').click();
    assert.equal(requests.length,2);
    assert.deepEqual(errors,[]);
    console.log('PASS: ordinary chat, no model configured, consent and cancel, safe target, verified 200/401 HTML, redacted legacy retry, reopen after restart, no model usage.');
  } finally {
    await app?.close();
    server.closeAllConnections(); server.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
