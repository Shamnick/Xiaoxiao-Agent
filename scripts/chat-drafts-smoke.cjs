'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');
const { Store } = require('../src/store');
const enterWorkspace = require('./enter-workspace.cjs');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-chat-drafts-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const read = request.tools?.some(tool => tool.function.name === 'read_selected_document') &&
      request.messages.at(-1).role === 'user';
    const message = read ? {role:'assistant', content:null, tool_calls:[{id:'read',type:'function',
      function:{name:'read_selected_document',arguments:'{"index":1}'}}]} : {role:'assistant',content:'已收好。'};
    res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({
      choices:[{message,finish_reason:read ? 'tool_calls' : 'stop'}]
    }));
  });
  let app, page;
  const el = id => page.locator('#' + id);
  const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
  async function launch() {
    app = await electron.launch({executablePath, args:executablePath ? [] : ['.'],
      cwd:path.resolve(__dirname,'..'), timeout:20000, env:{...process.env,XIAOXIAO_SMOKE_DIR:dir}});
    page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    await enterWorkspace(page);
  }
  const session = id => page.locator('#history [data-session="' + id + '"] .session-link').click();
  const project = name => el('projectList').getByRole('button',{name,exact:true}).click();
  const file = path.join(dir,'项目摘要.txt');
  async function attach() {
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
    await el('composerToolsButton').click();
    await el('attach').click();
    await el('attachmentLabel').getByText('项目摘要.txt').waitFor();
  }
  try {
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const store = new Store(dir);
    store.write('projects',[{id:'p',name:'创作',sources:[]}]);
    store.write('providers',[{id:'local',kind:'openai-compatible',name:'本机',model:'fixture',
      baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',stream:false}]);
    store.write('conversations',['a','b'].map(id=>({id,title:'会话 '+id,providerId:'local',messages:[],updatedAt:Date.now()})));
    await fs.writeFile(file,'文件内容只应在重新选择后送达');
    await launch();
    await el('prompt').fill('首页文稿');
    await project('创作');
    await el('prompt').fill('项目文稿');
    await project('全部会话');
    await session('a');
    const fakeKey = 'sk-' + 'qaonly12345678';
    await el('prompt').fill('第一份 ' + fakeKey);
    await attach();
    await session('b');
    await el('prompt').fill('第二份独立草稿');
    await app.close();
    await launch();
    assert.equal(await el('prompt').inputValue(),'首页文稿');
    await project('创作');
    assert.equal(await el('prompt').inputValue(),'项目文稿');
    await project('全部会话');
    await session('b');
    assert.equal(await el('prompt').inputValue(),'第二份独立草稿');
    await el('conversationMenu').click();
    await el('deleteConversation').click();
    await el('confirmDelete').click();
    await page.locator('#deleteDialog').waitFor({state:'hidden'});
    await session('a');
    assert.equal(await el('prompt').inputValue(),'第一份 [已隐藏密钥]');
    assert(await el('attachmentLabel').isHidden());
    assert(await el('missingReferences').isVisible());
    assert(await el('send').isDisabled());
    await el('prompt').press('Enter');
    assert.equal(requests.length,0);
    const persisted = await page.evaluate(()=>JSON.stringify(localStorage));
    assert(!persisted.includes(fakeKey));
    assert(!persisted.includes('第二份独立草稿'));
    assert(!persisted.includes('文件内容只应在重新选择后送达'));
    await el('prompt').fill('按附件总结');
    await attach();
    await el('send').click();
    await el('chat').getByText('已收好。',{exact:true}).waitFor();
    assert.equal(requests.length,2);
    assert.equal(requests[1].messages.at(-1).role,'tool');
    assert(requests[1].messages.at(-1).content.includes('文件内容只应在重新选择后送达'));
    await app.close();
    await launch();
    await session('a');
    assert.equal(await el('prompt').inputValue(),'');
    assert(await el('missingReferences').isHidden());
    assert.equal(requests.length,2);

    // Hold chat:send after the renderer captures its submission. Edit and
    // change views before the main process acknowledges the original text.
    await app.evaluate(({ipcMain}) => {
      const listener = ipcMain._invokeHandlers.get('chat:send');
      if (!listener) throw Error('Missing test IPC handler');
      ipcMain.removeHandler('chat:send');
      ipcMain.handle('chat:send', async (...args) => {
        await new Promise(resolve => { globalThis.releaseDraftQA = resolve; });
        return listener(...args);
      });
    });
    await el('prompt').fill('发送这条');
    await el('prompt').press('Enter');
    await el('prompt').fill('等待时补写的下一条');
    await project('创作');
    await app.evaluate(()=>globalThis.releaseDraftQA());
    await page.waitForFunction(async () => (await nova.conversations.list()).find(c=>c.id==='a')?.messages.at(-1)?.role === 'assistant' &&
      (await nova.conversations.list()).find(c=>c.id==='a').messages.some(m=>m.content==='发送这条'));
    await app.close();
    await launch();
    await session('a');
    assert.equal(await el('prompt').inputValue(),'等待时补写的下一条');
    await attach();
    await app.close();
    await launch();
    await session('a');
    await el('forgetReferences').click();
    await el('send').click();
    await page.waitForFunction(async () => (await nova.conversations.list()).find(c=>c.id==='a')?.messages.some(m=>m.content==='等待时补写的下一条'));
    await page.waitForFunction(async () => {
      const c = (await nova.conversations.list()).find(c=>c.id==='a');
      return !c.pendingRun && c.messages.at(-1).role === 'assistant';
    });
    assert.equal(requests.at(-1).messages.at(-1).content,'等待时补写的下一条');
    assert(!requests.at(-1).tools?.some(tool=>tool.function.name==='read_selected_document'));
    console.log('PASS: home, project and session drafts survive restart, references require reselection, redaction, deletion and acknowledged send.');
  } finally {
    await app?.close().catch(()=>{});
    server.closeAllConnections();
    server.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
