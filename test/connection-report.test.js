'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { mask, detect, modelsUrl } = require('../src/connection-intent');
const { checkConnection, saveReport } = require('../src/connection-report');
const { redactChatHistory } = require('../src/redact-chat-history');

test('pasted and redacted prompts route to a confirmed target, including old history', () => {
  const key = 'sk-' + randomUUID();
  const address = 'https://example.test';
  const prompt = [key,address,'测试一下这个，最好给我一个html版的报告就行'].join('\n');
  assert.deepEqual(detect(prompt), { address, key });
  assert.deepEqual(detect(mask(prompt)), { address, key: '' });
  assert.deepEqual(detect(prompt + ' https://second.test'), { address: '', key: '' });
  assert.deepEqual(detect('检测接口'), { address: '', key: '' });
  assert.equal(detect('为我的模型写十个单元测试'), null);
  assert.equal(detect('总结 https://example.test'), null);
  const old = [{title:prompt.slice(0,36),messages:[{content:prompt},{content:'done',updates:[{text:key}]}]}];
  assert.equal(redactChatHistory(old), true);
  assert(!JSON.stringify(old).includes(key.slice(0,20)));
  assert.equal(redactChatHistory(old), false);
});

test('normalizes common base URLs and explicit completion routes before confirmation', () => {
  for (const suffix of ['', '/', '/v1/', '/v1/models', '/v1/chat/completions', '/v1/responses']) {
    assert.equal(modelsUrl('https://example.test'+suffix), 'https://example.test/v1/models');
  }
  for (const url of ['http://example.test', 'https://example.test/?token=x', 'https://user@example.test/v1', 'file:///tmp/models', 'https://example.test/#x']) {
    assert.throws(() => modelsUrl(url));
  }
});

test('probes only the confirmed URL once and saves checked HTML for success and failure', async t => {
  const key = 'sk-' + randomUUID();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-check-'));
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization });
    const mode = req.url.split('/')[1];
    if (mode === 'deny') res.writeHead(401).end(key);
    else if (mode === 'redirect') res.writeHead(302,{Location:'/unexpected'}).end();
    else if (mode === 'invalid') res.end('{');
    else if (mode === 'large') res.end('x'.repeat(1024*1024+1));
    else if (mode === 'wrong') res.end('{"data":[{}]}');
    else res.end(JSON.stringify({data:[{id:key},{id:'model-b'}]}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await fs.rm(dir,{recursive:true,force:true}); });
  const root = 'http://127.0.0.1:'+server.address().port;
  for (const [mode, status, detail] of [['ok',200,'2 项'],['deny',401,'拒绝访问'],['redirect',302,'跳转'],['invalid',200,'JSON'],['large',200,'1 MiB'],['wrong',200,'格式']]) {
    const before = seen.length;
    const result = await checkConnection(root + '/' + mode, key);
    assert.equal(seen.length,before+1);
    assert.deepEqual(seen.at(-1),{path:'/'+mode+'/models',method:'GET',auth:'Bearer '+key});
    assert.equal(result.status,status);
    assert(result.detail.includes(detail));
    assert.equal(result.ok,mode==='ok');
    assert.equal(result.count,mode==='ok'?2:null);
    assert(Number.isFinite(result.elapsed));
    const saved = await saveReport(dir,result);
    const html = await fs.readFile(saved.path,'utf8');
    assert(!html.includes(key));
    assert(html.includes(result.detail));
    assert(html.includes(result.endpoint));
    assert(!html.includes('<script'));
  }
});
