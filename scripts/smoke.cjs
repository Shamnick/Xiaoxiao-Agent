const {_electron:electron}=require('playwright');
const {createServer}=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xiaoxiao-smoke-'));
 let requests=0;
 const server=createServer(async(req,res)=>{
   let data='';for await(const c of req)data+=c;
   if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
   requests++;
   const body=JSON.parse(data);
   res.setHeader('content-type','text/event-stream');
   const event=e=>res.write('data: '+JSON.stringify(e)+'\n\n');
   if(body.messages.at(-1)?.content==='WAIT'){event({choices:[{delta:{content:'等待停止'}}]});return;}
   if(body.tools?.length&&!body.messages.some(m=>m.role==='tool')){
     event({choices:[{delta:{tool_calls:[{index:0,id:'tool1',function:{name:'list_files',arguments:'{"path":"."}'}}]},finish_reason:'tool_calls'}]});res.end();return;
   }
   event({choices:[{delta:{content:'**Xiaoxiao** '}}]});
   setTimeout(()=>{event({choices:[{delta:{content:'桌面测试成功 ✓'},finish_reason:'stop'}]});res.end();},100);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let app;
 const launch=()=>electron.launch({args:process.env.XIAOXIAO_SMOKE_EXECUTABLE?[]:['.'],...(process.env.XIAOXIAO_SMOKE_EXECUTABLE?{executablePath:process.env.XIAOXIAO_SMOKE_EXECUTABLE}:{}),cwd:path.resolve(__dirname,'..'),env:{...process.env,XIAOXIAO_SMOKE_DIR:dir}});
 try{
   app=await launch();let page=await app.firstWindow();
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.waitForFunction(()=>window.nova&&document.getElementById('modelSelect').options[0]?.text!=='正在加载模型…');
   const providerId=await page.evaluate(async baseUrl=>window.nova.providers.save({name:'本地测试',kind:'ollama',model:'fixture-model',baseUrl}),'http://127.0.0.1:'+server.address().port+'/v1');
   const workspace=path.join(dir,'workspace');await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'hello.txt'),'hello');
   await app.evaluate(async({dialog},workspace)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});},workspace);
   await page.evaluate(async id=>{
     const c=await window.nova.conversations.create({providerId:id,title:'集成测试'});
     await window.nova.conversations.save({id:c.id,agent:true});
   },providerId);
   await page.reload();
   await page.locator('#history button').filter({hasText:'集成测试'}).click();
   await page.locator('#workspace').click();
   await page.locator('#prompt').fill('列出工作目录并报告结果');
   await page.locator('#send').click();
   await page.waitForFunction(()=>document.getElementById('chat').textContent.includes('桌面测试成功 ✓')&&!document.getElementById('newChat').disabled);
   assert.equal(requests,2);
   assert.equal(await page.locator('#errorBanner').isVisible(),false);
   assert.equal(await page.locator('#activityPanel').isVisible(),true);
   const rows=await page.evaluate(()=>window.nova.conversations.list());
   assert.equal(rows[0].messages.length,2);assert.match(rows[0].messages[1].content,/测试成功/);
   await page.locator('#settings').click();await page.waitForFunction(()=>!document.getElementById('providerFields').disabled);
   assert.equal(await page.locator('#providerList').textContent().then(s=>s.includes('本地测试')),true);
   await page.locator('#closeSettings').click();
   await fs.mkdir(path.resolve('artifacts'),{recursive:true});
   await page.screenshot({path:path.resolve('artifacts/desktop-chat.png')});
   assert.deepEqual(errors,[]);
   assert.equal(await page.locator('#chat strong').first().textContent(),'Xiaoxiao');
   await page.locator('#renameConversation').click();
   await page.locator('#renameInput').fill('集成测试 · 已保存');
   await page.locator('#renameForm button[type=submit]').click();
   await page.waitForFunction(()=>document.getElementById('conversationTitle').textContent==='集成测试 · 已保存');
   const exported=path.join(dir,'export.md');
   await app.evaluate(({dialog},target)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:target});},exported);
   await page.locator('#exportConversation').click();
   await page.waitForFunction(()=>!document.getElementById('exportConversation').disabled);
   assert.match(await fs.readFile(exported,'utf8'),/桌面测试成功/);
   await page.locator('#prompt').fill('WAIT');
   await page.locator('#send').click();
   await page.waitForFunction(()=>document.getElementById('chat').textContent.includes('等待停止'));
   await page.locator('#stop').click();
   await page.waitForFunction(()=>!document.getElementById('newChat').disabled);
   const stopped=await page.evaluate(()=>window.nova.conversations.list());
   assert.equal(stopped[0].messages.at(-1).failed,true);
   assert.match(stopped[0].messages.at(-1).error,/停止/);
   await page.locator('#dismissError').click();

   await app.close();app=await launch();page=await app.firstWindow();
   await page.locator('#history button').filter({hasText:'集成测试'}).click();
   await page.waitForFunction(()=>document.getElementById('chat').textContent.includes('桌面测试成功 ✓'));
   assert.equal(await page.title(),'Xiaoxiao Agent');
   console.log('PASS: Desktop launch, provider IPC, workspace dialog, streamed tool loop, persisted history, settings UI, Markdown, rename/export, stop/persist, restart restore.');
 }finally{if(app)await app.close();server.closeAllConnections();server.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
