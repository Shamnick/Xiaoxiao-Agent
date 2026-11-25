'use strict';

// Exercise the installed app through ordinary chat. Without --live this script
// uses a loopback fixture and never reads the user's provider configuration.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { Store } = require('../src/store');

const model = 'gpt-6.2-astra';
const root = path.resolve(__dirname, '..');
const scenarioNames = ['normal', 'redirect', 'cancel', 'recover'];
const brief = '秋季工作坊将在一楼展厅举行，日期周四，预算 500 元。请用这些材料制作一页 PDF，请用简体中文并保存为 workshop.pdf。';
const revision = '改到周五，删去预算和金额，保留活动名和地点。只交付修改后的 PDF。';
const live = process.argv.slice(2).includes('--live');
if (process.argv.slice(2).some(arg => arg !== '--live')) throw Error('仅支持 --live，默认运行本地测试。');

async function fixture() {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    assert.equal(body.model, model);
    assert.equal(body.max_completion_tokens, 768);
    const last = body.messages.at(-1);
    const revised = body.messages.some(m => m.content === revision);
    const content = revised ? '# 秋季工作坊\n\n一楼展厅，周五。' : '# 秋季工作坊\n\n一楼展厅，周四。预算 500 元。';
    const saved = last.role === 'tool' && JSON.parse(last.content);
    const event = saved || last.content.startsWith('Continue the interrupted task')
      ? {delta:{content:saved?.canceled ? '已取消保存。' : '可以打开文件了。'},finish_reason:'stop'}
      : {delta:{tool_calls:[{index:0,id:'make-pdf',function:{name:'save_artifact',arguments:JSON.stringify({filename:'workshop.pdf',content})}}]},finish_reason:'tool_calls'};
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end('data: ' + JSON.stringify({choices:[event]}) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {baseUrl:'http://127.0.0.1:' + server.address().port, close(){server.closeAllConnections();server.close();}};
}

function inspectPdf(file, revised) {
  const script = "ObjC.import('PDFKit'); function run(a){const d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0]));return JSON.stringify({pages:Number(d.pageCount),text:ObjC.unwrap(d.string)});}";
  const data = JSON.parse(execFileSync('/usr/bin/osascript',['-l','JavaScript','-e',script,file],{encoding:'utf8'}));
  assert.equal(data.pages,1);
  const compact = data.text.normalize('NFKC').replace(/\s/g,'');
  for (const term of ['秋季工作坊','一楼展厅']) assert(compact.includes(term), 'PDF 缺少'+term);
  assert((revised ? /周五|星期五/ : /周四|星期四/).test(compact),'日期不符');
  if (revised) assert(!/周四|星期四|预算|500|五百/.test(compact),'PDF 仍保留旧信息');
  else assert(/500|五百/.test(compact),'PDF 缺少金额');
  return {pages:data.pages,contentChecked:true};
}

// This function runs only inside the isolated Electron test process. Production
// credentials stay in Electron. The report contains timings/counts only.
async function instrument({app, safeStorage, dialog, shell}, opts) {
  const io = process.getBuiltinModule('node:fs');
  const { baseUrl, profile, name, output, live, ledger, unitRate, restarted, costBoundFen, cumulative } = opts;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const headers = {};
  if (live) {
    const row = JSON.parse(io.readFileSync(profile,'utf8'))[0];
    headers.Authorization = 'Bearer ' + safeStorage.decryptString(Buffer.from(row.apiKey,'base64'));
  }
  const getUsage = async (preflight = true) => {
    const response = await nativeFetch(new URL('/v1/usage',baseUrl),{headers,redirect:'error',signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw Error('额度查询返回 HTTP '+response.status);
    const usage = await response.json();
    if (preflight) {
      if (usage.isValid !== true) throw Error('测试 Key 当前不可用');
      if (!costBoundFen && (usage.mode !== 'quota_limited' || !Number.isFinite(usage.quota?.remaining) ||
            usage.quota.remaining <= 0 || usage.unit !== opts.expectedUnit ||
            !(unitRate > 0) || usage.quota.remaining * unitRate > 20)) {
        throw Error('需要核实当前分组的单次费用上界，或采用人民币 20 元以内的有效剩余额度。');
      }
    }
    globalThis.qaRemaining = usage.quota?.remaining;
    return typeof usage.quota?.used === 'number' ? usage.quota.used : null;
  };
  const before = live ? await getUsage() : null;
  let calls=0, firstRequestAt=null, firstResponseAt=null, saveCount=0, opened=false;
  globalThis.qaStats=()=>({calls,saveCount,opened,firstRequestAt,httpHeadersMs:firstResponseAt && firstResponseAt-firstRequestAt});
  globalThis.qaUsed=async()=>live ? getUsage(false) : null;
  globalThis.fetch=async(url,init={})=>{
    if (String(url)!==baseUrl+'/chat/completions' || init.method!=='POST') throw Error('非验收端点');
    const body=JSON.parse(init.body);
    if(body.model!=='gpt-6.2-astra' || !body.stream || body.tools?.some(t=>t.function.name!=='save_artifact')) throw Error('验收范围不匹配');
    if(init.signal?.aborted) throw init.signal.reason;
    const entries=io.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean);
    if(entries.length>=12 || calls>=4) throw Error('达到验收请求数上限');
    body.max_completion_tokens=768;
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > 8192) throw Error('验收请求正文超过 8192 字节');
    if (live) {
      const prior = JSON.parse(io.readFileSync(cumulative,'utf8'));
      // A reservation is never released for cancellations, transport errors or
      // crashes. Repeated invocations share the same phase-two budget ledger.
      const next = costBoundFen || 0;
      if (prior.mode !== (costBoundFen ? 'rate' : 'key') || !Number.isSafeInteger(prior.fen) ||
          prior.fen < 0 || prior.fen + next > 2000) throw Error('费用预留达到本轮总预算或核算方式已更改');
      if (!costBoundFen) {
        const used = await getUsage();
        if (!Number.isFinite(used) || used < 0 || !Number.isFinite(prior.firstUsed ?? used) ||
            used < (prior.firstUsed ?? used) || (used - (prior.firstUsed ?? used) + globalThis.qaRemaining) * unitRate > 20) {
          throw Error('测试 Key 的累计用量或额度已变化，需重新核对本轮上限');
        }
        prior.firstUsed ??= used;
      }
      io.writeFileSync(cumulative+'.tmp',JSON.stringify({...prior,fen:prior.fen+next}),{mode:0o600});
      io.renameSync(cumulative+'.tmp',cumulative);
    }
    const start=Date.now();
    // Record attempts before dispatch, including canceled and interrupted calls.
    io.appendFileSync(ledger,JSON.stringify({scenario:name,at:start,restarted})+'\n');
    calls++;
    firstRequestAt ??= start;
    const response=await nativeFetch(url,{...init,body:serialized});
    firstResponseAt ??= Date.now();
    // Synchronize the UI action at a real HTTP response. Do not synthesize or
    // alter model content. Cancellation of the app fetch cancels the old stream.
    const pause=(name==='redirect' && !restarted && calls===1) ||
      (name==='recover' && !restarted && body.messages.at(-1).role==='tool');
    if(pause && response.ok) {
      globalThis.qaAtBoundary=true;
      await new Promise((resolve,reject)=>{
        const abort=()=>reject(init.signal.reason);
        if(init.signal.aborted) abort();
        else init.signal.addEventListener('abort',abort,{once:true});
      });
    }
    return response;
  };
  dialog.showSaveDialog=async()=>{
    saveCount++;
    if(name==='cancel' || restarted || saveCount>1) return {canceled:true};
    return {canceled:false,filePath:output};
  };
  shell.openPath=async file=>{if(file!==output) throw Error('打开了其他文件'); opened=true;return '';};
  return {before,version:app.getVersion()};
}

async function main() {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xiaoxiao-phase2-'));
  const reportRoot=path.join(root,'artifacts','phase-two',live?'live':'fixture');
  await fs.mkdir(reportRoot,{recursive:true});
  const reportDir=await fs.mkdtemp(path.join(reportRoot,'run-'));
  const ledger=path.join(reportDir,'requests.jsonl');
  await fs.writeFile(ledger,'',{mode:0o600,flag:'wx'});
  const report={model,mode:live?'live':'fixture',cases:[],requests:0};
  const unitRate=Number(process.env.XIAOXIAO_QA_CNY_PER_UNIT_CEILING);
  const expectedUnit=process.env.XIAOXIAO_QA_BILLING_UNIT;
  const costBoundFen = Number(process.env.XIAOXIAO_QA_MAX_FEN_PER_REQUEST || 0);
  const cumulative = path.join(reportRoot, 'budget.json');
  const lock = path.join(reportRoot, '.running');
  let local, app, budgetLock;
  try {
    let provider;
    if(live){
      if (!Number.isSafeInteger(costBoundFen) || costBoundFen < 0 || costBoundFen > 2000 ||
          (!costBoundFen && (!expectedUnit || !Number.isFinite(unitRate) || unitRate <= 0))) {
        throw Error('须先提供核实过的单次费用上界或额度单位换算上界');
      }
      budgetLock = await fs.open(lock,'wx',0o600);
      // Tie a hard-quota run to one credential even across process restarts.
      // The encrypted credential itself is never copied into the budget report.
      const source=path.join(os.homedir(),'Library/Application Support/Xiaoxiao Agent/providers.json');
      const row=JSON.parse(await fs.readFile(source,'utf8')).find(x=>x.name==='测试' && x.model===model && x.kind==='openai-compatible');
      const approvedOrigin = (process.env.XIAOXIAO_QA_APPROVED_ORIGIN ||
        await fs.readFile(path.join(root, 'artifacts/phase-two/approved-origin.txt'), 'utf8')).trim();
      const origin = new URL(approvedOrigin);
      if (origin.protocol !== 'https:' || origin.origin !== approvedOrigin || !row?.encrypted || !row.apiKey ||
          ![approvedOrigin, approvedOrigin + '/v1'].includes(row.baseUrl.replace(/\/+$/, ''))) throw Error('测试连接与已授权网关不匹配');
      const keyFingerprint = require('node:crypto').createHash('sha256').update(row.apiKey).digest('hex');
      const mode = costBoundFen ? 'rate' : 'key';
      try {
        await fs.writeFile(cumulative,JSON.stringify({mode,fen:0,keyFingerprint}),{flag:'wx',mode:0o600});
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const prior = JSON.parse(await fs.readFile(cumulative,'utf8'));
      if (prior.mode !== mode || (mode === 'key' && prior.keyFingerprint !== keyFingerprint)) throw Error('本轮费用记录绑定了不同的核算方式或测试 Key');
      provider={id:'qa',model,kind:row.kind,name:row.name,baseUrl:row.baseUrl.replace(/\/+$/,''),stream:true,encrypted:true,apiKey:row.apiKey};
    }else{
      local=await fixture();
      provider={id:'qa',model,kind:'openai-compatible',name:'本地夹具',baseUrl:local.baseUrl,stream:true};
    }
    const executablePath=process.env.XIAOXIAO_SMOKE_EXECUTABLE || '/Applications/Xiaoxiao Agent.app/Contents/MacOS/Xiaoxiao Agent';
    for (const name of scenarioNames) {
      const result={name,passed:false};
      report.cases.push(result);
      const data=path.join(dir,name), files=path.join(reportDir,name), output=path.join(files,'workshop.pdf');
      const store=new Store(data);
      store.write('providers',[provider]);
      await fs.mkdir(files);
      let page, before;
      const collect = async () => {
        const {firstRequestAt,...stats}=await app.evaluate(()=>globalThis.qaStats());
        const firstTextAt = await page.evaluate(()=>window.qaFirstTextAt);
        return {...stats,firstTextMs:firstTextAt && firstRequestAt ? firstTextAt-firstRequestAt : null};
      };
      const launch=async restarted=>{
        const env={...process.env,XIAOXIAO_SMOKE_DIR:data};
        delete env.ELECTRON_RUN_AS_NODE;
        app=await electron.launch({executablePath,args:[],env});
        page=await app.firstWindow();
        page.setDefaultTimeout(60000);
        await page.evaluate(()=>{
          window.qaFirstTextAt=null;
          window.nova.chat.onEvent(event=>{
            if(event.type==='text' && event.text?.trim()) window.qaFirstTextAt ??= Date.now();
          });
        });
        const info=await app.evaluate(instrument,{baseUrl:provider.baseUrl,output,name,profile:path.join(data,'providers.json'),live,unitRate,expectedUnit,ledger,restarted,costBoundFen,cumulative});
        if (!restarted) before=info.before;
        report.version=info.version;
      };
      await launch(false);
      await page.locator('#presenceKnot').click();
      await page.locator('#prompt').fill(brief);
      await page.locator('#prompt').press('Enter');
      if (['redirect','recover'].includes(name)){
        // Check for a completed/failed run instead of waiting out the deadline
        // if a provider never calls save_artifact.
        const deadline=Date.now()+75000;
        while(!await app.evaluate(()=>Boolean(globalThis.qaAtBoundary))){
          if(Date.now()>deadline || store.read('conversations',[]).some(c=>c.messages.at(-1)?.role==='assistant' && !c.pendingRun)) throw Error('模型未到达预期的改向或恢复步骤');
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      }
      let originalBytes, originalStat;
      if (name==='redirect') {
        await page.locator('#prompt').fill(revision);
        await page.locator('#steerNow').click();
      }
      if(name==='recover'){
        originalBytes=await fs.readFile(output); originalStat=await fs.stat(output);
        inspectPdf(output,false);
        result.beforeRestart=await collect();
        assert.equal(result.beforeRestart.saveCount,1);
        const child=app.process(), exited=once(child,'exit');
        assert(child.kill('SIGKILL')); await exited; app=null;
        await launch(true);
        await require('./enter-workspace.cjs')(page);
        await page.locator('#history .session-link').click();
        await page.locator('#resumeTask').click();
      }
      await page.waitForFunction(()=>document.querySelector('#chat .assistant') && document.getElementById('stop').hidden && !document.getElementById('newChat').disabled,null,{timeout:75000});
      const conversation=store.read('conversations',[])[0], last=conversation.messages.at(-1);
      assert.equal(last.role,'assistant');
      if(last.failed)throw Error('服务或任务执行失败：'+String(last.error||'未知错误').slice(0,120));
      if(name==='cancel'){
        assert.match(last.content,/取消|未保存|没有保存/);
        assert.deepEqual(last.artifacts || [],[]);
        assert.deepEqual(await fs.readdir(files),[]);
      }else{
        assert.deepEqual(await fs.readdir(files),['workshop.pdf']);
        Object.assign(result,inspectPdf(output,name==='redirect'));
        await page.locator('#chat .assistant').last().getByRole('button',{name:'打开 · workshop.pdf',exact:true}).click();
        if(name==='recover'){
          assert.deepEqual(await fs.readFile(output),originalBytes);
          const stat=await fs.stat(output);
          assert.equal(stat.ino,originalStat.ino);assert.equal(stat.mtimeMs,originalStat.mtimeMs);
        }
      }
      result.run=await collect();
      assert.equal(result.run.saveCount,name==='recover'?0:1);
      assert.equal(result.run.opened,name!=='cancel');
      if(live){const end=await app.evaluate(()=>globalThis.qaUsed()); result.observedQuotaUsedDelta=Number.isFinite(before)&&Number.isFinite(end)?end-before:null;}
      result.passed=true;
      await app.close();app=null;
    }
  }catch(error){
    report.error=String(error.message).split('\n')[0].slice(0,240);
    throw error;
  }finally{
    report.requests=(await fs.readFile(ledger,'utf8')).trim().split('\n').filter(Boolean).length;
    await fs.writeFile(path.join(reportDir,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(reportDir, report.cases.filter(x=>x.passed).length+'/'+scenarioNames.length,'cases;',report.requests,'transport requests;',report.mode);
    try{await app?.close();}finally{
      local?.close();await fs.rm(dir,{recursive:true,force:true});
      if (budgetLock) {await budgetLock.close();await fs.unlink(lock);}
    }
  }
}
main().catch(error=>{console.error(String(error.message).split('\n')[0]);process.exitCode=1;});
