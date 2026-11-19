const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xiaoxiao-preview-'));
 let app;
 try{
  app=await electron.launch({args:['.'],cwd:path.resolve(__dirname,'..'),env:{...process.env,XIAOXIAO_SMOKE_DIR:dir}});
  const page=await app.firstWindow();
  await page.waitForFunction(()=>window.nova&&!document.getElementById('newChat').disabled);
  await page.evaluate(async()=>{
   await window.nova.providers.save({name:'Claude · 工作助手',kind:'anthropic',model:'填写你的模型 ID',baseUrl:'https://api.anthropic.com/v1'});
   await window.nova.providers.save({name:'Ollama · 本地模型',kind:'ollama',model:'填写本地模型名'});
  });
  await page.reload();await page.waitForFunction(()=>document.getElementById('modelSelect').options.length===2&&!document.getElementById('newChat').disabled);
  await page.screenshot({path:path.resolve('docs/images/workspace.png'),scale:'css'});
  await page.locator('#settings').click();await page.waitForFunction(()=>!document.getElementById('providerFields').disabled);
  await page.screenshot({path:path.resolve('docs/images/settings.png'),scale:'css'});
  console.log('Screenshots saved without personal data or credentials.');
 }finally{if(app)await app.close();await fs.rm(dir,{force:true,recursive:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
