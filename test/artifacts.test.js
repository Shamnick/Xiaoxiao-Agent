const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { createArtifactTool } = require('../src/artifacts');
const { runAgent } = require('../src/providers');
const { replyFiles } = require('../src/reply-files');

test('cancel or stop during save leaves an existing file untouched', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xx-export-'));
  t.after(() => fs.rm(dir, {force:true,recursive:true}));
  const file = path.join(dir,'页.html');
  await fs.writeFile(file,'original');
  const input = {filename:'页.html', content:'replacement'};
  const canceled = createArtifactTool({choosePath:async () => null});
  assert.deepEqual(await canceled.execute(input), {canceled:true});
  const stop = new AbortController();
  const aborted = createArtifactTool({signal:stop.signal, choosePath:async () => { stop.abort(); return file; }});
  await assert.rejects(aborted.execute(input), {name:'AbortError'});
  assert.equal(await fs.readFile(file,'utf8'),'original');
  assert.deepEqual(await fs.readdir(dir),['页.html']);
});

test('only plain file names and matching text formats can be delivered', async () => {
  let choices = 0;
  const tool = createArtifactTool({choosePath:async () => { choices++; return '/unexpected.app'; }});
  for (const filename of ['../file.html','x/y.html','.hidden.html','result.exe','x\\file.html']) {
    await assert.rejects(tool.execute({filename,content:'text'}));
  }
  assert.equal(choices,0);
  await assert.rejects(tool.execute({filename:'safe.html',content:'text'}),/扩展名/);
});

test('a text-only connection explicitly rejecting tools still returns exportable HTML', async () => {
  const source = '<!doctype html><title>动画</title>';
  const markdown = '```html\n'+source+'\n```';
  let requests = 0;
  const answer = await runAgent({kind:'ollama',model:'test',baseUrl:'http://fixture'},[{role:'user',content:'HTML 文件'}], {
    tools:[createArtifactTool({choosePath:()=>assert.fail()})],
    request:async (_url,opts) => {
      const body = JSON.parse(opts.body);
      if (++requests === 1) {
        assert(body.tools);
        return Response.json({error:'model does not support tools'}, {status:400});
      }
      assert.equal(body.tools,undefined);
      return Response.json({choices:[{message:{content:markdown}}]});
    }
  });
  assert.equal(requests,2);
  assert.deepEqual(replyFiles(answer),[{filename:'动画.html', content:source+'\n'}]);
  assert.deepEqual(replyFiles(markdown.slice(0,-3)),[]);
});

test('canceled PDF printing leaves the previous document intact', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xx-pdf-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, '活动.pdf');
  await fs.writeFile(target, 'previous');
  const signal = new AbortController();
  const input = { filename: '活动.pdf', content: '新的日期' };
  const make = (choosePath, renderPdf) => createArtifactTool({ choosePath, renderPdf, signal: signal.signal });
  const dismissed = make(async () => null, () => assert.fail('printing after cancel'));
  assert.deepEqual(await dismissed.execute(input), { canceled: true });
  const interrupted = make(async () => target, async draft => {
    assert.deepEqual(draft, { title: '活动', markdown: '新的日期' });
    signal.abort();
    return Buffer.from('%PDF-');
  });
  await assert.rejects(interrupted.execute(input), { name: 'AbortError' });
  assert.equal(await fs.readFile(target, 'utf8'), 'previous');
  assert.deepEqual(await fs.readdir(root), ['活动.pdf']);
});
