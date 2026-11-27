const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { Store } = require('../src/store');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-delivery-'));
  const title = '骑行';
  const html = '<!doctype html><meta charset="utf-8"><title>骑行</title><svg></svg>';
  const first = '做一个可打开的 HTML 文件';
  const addition = '请使用蓝色';
  const artifactPath = path.join(dir, '骑行.html');
  const releaseFirst = Promise.withResolvers();
  const releaseHeaders = Promise.withResolvers();
  const releaseFile = Promise.withResolvers();
  const requests = [];
  const initialPdf = '秋季工作坊在一楼展厅举行。活动安排在周四，预算 500 元，做成一页 PDF。';
  const changePdf = '改到周五并删掉预算';
  const pdfCases = {
    normal: '秋季工作坊，一楼展厅，周四，预算 500 元。请做成一页 PDF。',
    cancel: '将材料写入 PDF，我会取消保存。',
    recover: '将材料写入 PDF，我会在写入后中断并继续。'
  };
  const pdfSource = '# 秋季工作坊\n\n地点：一楼展厅。日期：周四。预算 500 元。';
  const pdfOutput = path.join(dir, 'pdf-check');
  const resumeGoal = '保存检查点网页，再说明完成情况';
  let resumeAttempts = 0;
  const errors = [];
  let app;
  const server = http.createServer(async (req,res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const message = body.messages.at(-1);
      requests.push(message);
      assert(body.stream);
      assert.deepEqual(body.tools.map(x => x.function.name), ['save_artifact']);
      if (message.content === addition) await releaseHeaders.promise;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const event = (delta, finish_reason) => res.write('data: ' + JSON.stringify({ choices: [{delta, finish_reason}] })+'\n\n');
      if (message.content === first) {
        event({content:'我来制作'});
        await releaseFirst.promise;
        event({content:'这个网页。'}, 'stop');
      } else if (message.content === addition) {
        const args = JSON.stringify({filename:title+'.html', content:html});
        event({tool_calls:[{index:0,id:'save',function:{name:'save_artifact',arguments:args.slice(0,15)}}]});
        await releaseFile.promise;
        event({tool_calls:[{index:0,function:{arguments:args.slice(15)}}]}, 'tool_calls');
      } else if (message.content === initialPdf) {
        event({content:'正在整理材料。'});
        // Keep the old inference open until the real client cancels its fetch.
        await new Promise(resolve => res.once('close', resolve));
        return;
      } else if (message.content === changePdf) {
        event({tool_calls:[{index:0,id:'pdf-save',function:{name:'save_artifact',arguments:JSON.stringify({filename:'活动安排.pdf',content:'# 秋季工作坊\n\n地点：一楼展厅。日期：周五。'})}}]}, 'tool_calls');
      } else if (message.tool_call_id === 'pdf-save') {
        assert.equal(JSON.parse(message.content).verification,'matched');
        event({content:'活动安排已保存。'}, 'stop');
      } else if (Object.values(pdfCases).includes(message.content)) {
        const kind = Object.keys(pdfCases).find(key => pdfCases[key] === message.content);
        event({tool_calls:[{index:0, id:kind, function:{name:'save_artifact',
          arguments:JSON.stringify({filename:kind + '.pdf', content:pdfSource})}}]}, 'tool_calls');
      } else if (['normal','cancel','recover'].includes(message.tool_call_id)) {
        const receipt = JSON.parse(message.content);
        if (message.tool_call_id === 'cancel') {
          assert.deepEqual(receipt, { canceled:true, saved:false });
          event({content:'保存已取消。'}, 'stop');
        } else {
          assert.equal(receipt.verification, 'matched');
          if (message.tool_call_id === 'recover') {
            event({content:'PDF 已写入，等待后续回复。'});
            await new Promise(resolve => res.once('close', resolve));
            return;
          }
          event({content:'已交付工作坊简报。'}, 'stop');
        }
      } else if (message.role === 'user' && message.content.startsWith('Continue the interrupted task') &&
          JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)).originalRequest === pdfCases.recover) {
        const receipt = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
        assert.deepEqual(receipt.savedFiles, ['recover.pdf']);
        assert.equal(receipt.recentToolCalls.filter(tool => tool.name === 'save_artifact' && tool.finished).length, 1);
        event({content:'已恢复，请打开原 PDF。'}, 'stop');
      } else if (message.content === resumeGoal) {
        event({tool_calls:[{index:0,id:'recover-file',function:{name:'save_artifact',arguments:JSON.stringify({filename:'进度.html', content:html})}}]}, 'tool_calls');
      } else if (message.tool_call_id === 'recover-file') {
        event({content:'已写入磁盘，'}, 'length');
      } else if (typeof message.content === 'string' && message.content.startsWith('Continue the interrupted task')) {
        const receipt = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
        assert.deepEqual(receipt.savedFiles, ['进度.html']);
        assert.equal(receipt.originalRequest, resumeGoal);
        assert.equal(receipt.recentToolCalls.filter(t => t.name === 'save_artifact' && t.finished).length, 1);
        if (resumeAttempts++ === 0) {
          assert.equal(receipt.partialAnswer, '已写入磁盘，');
          event({content:'正在核对。'}, 'length');
        } else {
          assert.match(receipt.partialAnswer, /已写入磁盘，[\s\S]*正在核对。/);
          event({content:'恢复完成，网页已保存。'}, 'stop');
        }
      } else {
        assert.equal(message.role,'tool');
        assert.deepEqual(JSON.parse(message.content), { saved:true, filename:'骑行.html', bytesWritten:Buffer.byteLength(html), verification:'matched' });
        event({content:'已保存网页。'}, 'stop');
      }
      res.end();
    } catch (err) { errors.push(err.message); res.destroy(); }
  });
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const store = new Store(dir);
    store.write('providers',[{id:'local',kind:'ollama',name:'本地测试',model:'本地模型',stream:true,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'}]);
    store.write('conversations',[{id:'old',title:'历史 HTML',providerId:'local',agent:false,messages:[
      {role:'user',content:'生成 HTML'}, {role:'assistant',content:'网页代码\n\n```html\n'+html+'\n```'}
    ]}]);
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    const launch = () => electron.launch({executablePath, args: executablePath ? [] : ['.'], cwd:path.resolve(__dirname,'..'), env:{...process.env,XIAOXIAO_SMOKE_DIR:dir}});
    app = await launch();
    let page = await app.firstWindow();
    page.on('pageerror',err=>errors.push(err.message));
    page.setDefaultTimeout(10000);
    await page.locator('#presenceKnot').click();
    await page.locator('#prompt').fill(first);
    await page.locator('#prompt').press('Enter');
    await page.locator('#chat .assistant').getByText('我来制作', {exact:true}).waitFor();
    assert(await page.locator('#stop').isEnabled(), 'First text is visible before the server completes the turn');
    await page.locator('#prompt').fill(addition);
    await page.locator('#prompt').press('Enter');
    await page.getByText('补充要求 · 已排队，等待下一次请求', {exact:true}).waitFor();
    assert.equal(requests.length,1);
    const choose = target => app.evaluate(({dialog,shell},file) => {
      dialog.showSaveDialog = async () => ({canceled:false,filePath:file});
      shell.openPath = async file => { globalThis.openedChatArtifact = file; return ''; };
    },target);
    await choose(artifactPath);
    releaseFirst.resolve();
    await page.getByText('补充要求 · 正在等待服务响应', {exact:true}).waitFor();
    releaseHeaders.resolve();
    await page.locator('#runStatus').filter({hasText:'正在生成文件内容'}).waitFor();
    await page.getByText('补充要求 · 模型服务已响应', {exact:true}).waitFor();
    releaseFile.resolve();
    const open = page.getByRole('button',{name:'打开 · 骑行.html',exact:true});
    await open.click();
    assert.equal(await app.evaluate(()=>globalThis.openedChatArtifact),artifactPath);
    assert.equal(await fs.readFile(artifactPath,'utf8'),html);
    assert.equal(requests.length,3);
    const rows = await page.evaluate(()=>nova.conversations.list());
    assert.equal(rows.find(x=>x.id!=='old').messages.at(-1).updates[0].text,addition);
    await page.locator('#toggleSidebar').click();
    await page.locator('#history [data-session="old"] .session-link').click();
    const backup = path.join(dir,'历史.html');
    await choose(backup);
    await page.getByRole('button',{name:'另存为 · 骑行.html',exact:true}).click();
    await page.getByRole('button',{name:'打开 · 历史.html',exact:true}).click();
    assert.equal(await app.evaluate(()=>globalThis.openedChatArtifact),backup);
    assert.equal(await fs.readFile(backup,'utf8'),html+'\n');
    assert.equal(requests.length,3);
    const checkpointFile = path.join(dir, '进度.html');
    await choose(checkpointFile);
    await page.locator('#prompt').fill(resumeGoal);
    await page.locator('#prompt').press('Enter');
    const resume = page.locator('#resumeTask');
    await resume.waitFor();
    assert.equal(await fs.readFile(checkpointFile, 'utf8'), html);
    await resume.click();
    await page.locator('#chat .assistant').getByText('正在核对。', {exact:true}).waitFor();
    await resume.click();
    await page.locator('#chat .assistant').getByText('恢复完成，网页已保存。', {exact:true}).waitFor();
    await page.locator('#chat .assistant').last().getByRole('button',{name:'打开 · 进度.html', exact:true}).click();
    assert.equal(await app.evaluate(()=>globalThis.openedChatArtifact),checkpointFile);
    assert.equal(resumeAttempts,2);
    assert.equal(requests.length,7);
    const pdfPath = path.join(dir, '活动安排.pdf');
    await choose(pdfPath);
    await page.locator('#prompt').fill(initialPdf);
    await page.locator('#prompt').press('Enter');
    await page.locator('#chat .assistant').getByText('正在整理材料。', {exact:true}).waitFor();
    await page.locator('#prompt').fill(changePdf);
    await page.locator('#steerNow').click();
    await page.getByRole('button',{name:'打开 · 活动安排.pdf',exact:true}).click();
    assert.equal(await app.evaluate(()=>globalThis.openedChatArtifact),pdfPath);
    const pdf = await fs.readFile(pdfPath);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    if (process.platform === 'darwin') {
      const script = "ObjC.import('PDFKit'); function run(argv) { return ObjC.unwrap($.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])).string); }";
      const contents = require('node:child_process').execFileSync('/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', script, pdfPath], { encoding:'utf8' });
      for (const term of ['秋季工作坊','一楼展厅','周五']) assert(contents.includes(term), term);
      assert.doesNotMatch(contents, /周四|预算|500/);
    }
    await page.getByText('立即改向 · 模型服务已响应', {exact:true}).waitFor();
    assert.equal(requests.length,10);
    await fs.mkdir(pdfOutput);
    const send = async prompt => {
      await page.locator('#prompt').fill(prompt);
      await page.locator('#prompt').press('Enter');
    };
    const countSaveCalls = async () => app.evaluate(() => globalThis.pdfSaveCalls);
    const setSaveResult = async target => app.evaluate(({dialog, shell}, target) => {
      globalThis.pdfSaveCalls = 0;
      dialog.showSaveDialog = async () => {
        globalThis.pdfSaveCalls++;
        return target ? {canceled:false,filePath:target} : {canceled:true};
      };
      shell.openPath = async file => { globalThis.openedChatArtifact = file; return ''; };
    }, target);
    const finished = async () => page.locator('#stop').waitFor({state:'hidden'});
    const readPdf = async file => {
      const bytes = await fs.readFile(file);
      assert.equal(bytes.subarray(0,5).toString(), '%PDF-');
      if (process.platform === 'darwin') {
        const script = "ObjC.import('PDFKit'); function run(a){const d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0]));return JSON.stringify({pages:Number(d.pageCount),text:ObjC.unwrap(d.string)});}";
        const sample = JSON.parse(require('node:child_process').execFileSync('/usr/bin/osascript',
          ['-l','JavaScript','-e',script,file], {encoding:'utf8'}));
        assert.equal(sample.pages, 1);
        for (const term of ['秋季工作坊','一楼展厅','周四','500']) assert(sample.text.includes(term), term);
      }
      return bytes;
    };

    await finished();
    const normalFile = path.join(pdfOutput,'normal.pdf');
    await setSaveResult(normalFile);
    await send(pdfCases.normal);
    await page.getByRole('button',{name:'打开 · normal.pdf',exact:true}).click();
    await finished();
    assert.equal(await countSaveCalls(), 1);
    await readPdf(normalFile);
    await setSaveResult(null);
    await send(pdfCases.cancel);
    await page.locator('#chat .assistant').getByText('保存已取消。',{exact:true}).waitFor();
    await finished();
    assert.equal(await countSaveCalls(), 1);
    assert.deepEqual(await fs.readdir(pdfOutput), ['normal.pdf']);
    assert.equal(await page.locator('#chat .assistant').last().locator('.reply-files button').count(), 0);

    const recoverFile = path.join(pdfOutput,'recover.pdf');
    await setSaveResult(recoverFile);
    await send(pdfCases.recover);
    await page.locator('#chat .assistant').getByText('PDF 已写入，等待后续回复。',{exact:true}).waitFor();
    const beforeRestart = await readPdf(recoverFile);
    const metadata = await fs.stat(recoverFile);
    assert.equal(await countSaveCalls(), 1);
    const exited = require('node:events').once(app.process(), 'exit');
    assert(app.process().kill('SIGKILL'));
    await exited;
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', err => errors.push(err.message));
    page.setDefaultTimeout(10000);
    await setSaveResult(null);
    await require('./enter-workspace.cjs')(page);
    await page.locator('#history [data-session="old"] .session-link').click();
    await page.locator('#resumeTask').click();
    await page.locator('#chat .assistant').getByText('已恢复，请打开原 PDF。',{exact:true}).waitFor();
    await finished();
    await page.locator('#chat .assistant').last().getByRole('button',{name:'打开 · recover.pdf'}).click();
    assert.equal(await app.evaluate(()=>globalThis.openedChatArtifact),recoverFile);
    assert.equal(await countSaveCalls(), 0);
    assert.deepEqual(await fs.readdir(pdfOutput).then(files=>files.sort()), ['normal.pdf','recover.pdf']);
    assert.deepEqual(await readPdf(recoverFile),beforeRestart);
    const recoveredMetadata = await fs.stat(recoverFile);
    assert.equal(recoveredMetadata.ino,metadata.ino);
    assert.equal(recoveredMetadata.mtimeMs,metadata.mtimeMs);
    assert.equal(requests.length,17);
    assert.deepEqual(errors,[]);
    const evidenceDir = process.env.XIAOXIAO_SMOKE_QA_DIR;
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive:true });
      await fs.copyFile(pdfPath, path.join(evidenceDir,'redirected-workshop.pdf'));
      await fs.copyFile(normalFile, path.join(evidenceDir,'original-workshop.pdf'));
    }
    console.log('PASS: Chat first SSE text before completion, mid-stream instructions, tool input progress, standalone HTML file delivery, open action legacy reply export, and retaining a saved file across two truncated replies and manual resumes. PDF generation, redirect, cancel and restart recovery verified against the real files and save counts.');
  } finally {
    releaseFirst.resolve(); releaseHeaders.resolve(); releaseFile.resolve();
    await app?.close(); server.closeAllConnections(); server.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
