'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { imageSpec } = require('../src/image-spec');
const { generateAsset } = require('../src/generation');

test('model IDs select different 4K tiers and catalog overrides each parameter independently', () => {
  const pro = imageSpec('doubao-seedream-5-0-pro-260628');
  assert(pro.sizes.includes('2K') && !pro.sizes.includes('4K'));
  assert.deepEqual(pro.qualities, []);
  assert(imageSpec('doubao-seedream-5-0-260128').sizes.includes('4K'));
  assert(imageSpec('gpt-image-2').sizes.includes('3840x2160'));
  const catalog = imageSpec('gpt-image-2', {capabilities:{image_generation:{parameters:{properties:{
    size:{enum:['1024x1024']}, quality:{enum:[]}, n:{enum:[1,3,10]}
  }}}}});
  assert.deepEqual(catalog.sizes, ['1024x1024']);
  assert.deepEqual(catalog.qualities, []);
  assert.deepEqual(catalog.counts, [1,3]);
  assert.equal(catalog.sizeSource, '服务商目录');
  assert.deepEqual(imageSpec('my-gpt-image-2-alias').sizes, []);
});

const provider = {kind:'ollama',baseUrl:'http://localhost/v1',model:'special'};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=';
test('image job reports observed progress, exact received bytes, status and provider usage', async () => {
  const events = [], calls = [];
  let transferred = 0;
  const result = await generateAsset(provider, {kind:'image',prompt:'one'}, {pollDelayMs:1,onStatus:e=>events.push(e),
    request: async (url, init) => {
      calls.push(url);
      let payload;
      if (calls.length === 1) {
        assert.deepEqual(JSON.parse(init.body), {model:'special',prompt:'one'});
        payload = {status_url:'/v1/jobs/one', status:'queued'};
      } else if (calls.length === 2) payload = {status:'running', progress_percent:38};
      else payload = {data:[{b64_json:png}], usage:{total_tokens:17}};
      const raw = JSON.stringify(payload);
      transferred += Buffer.byteLength(raw);
      return new Response(raw,{headers:{'content-type':'application/json', 'content-length':String(Buffer.byteLength(raw))}});
    }});
  assert.deepEqual(calls, ['http://localhost/v1/images/generations','http://localhost/v1/jobs/one','http://localhost/v1/jobs/one']);
  assert.deepEqual(events.filter(e=>e.phase==='render').map(e=>e.percent), [null,38]);
  assert.equal(events.find(e=>e.phase==='headers').httpStatus,200);
  assert.equal(events.at(-1).bytes,transferred);
  assert.equal(result.totalTokens,17);
  assert.equal(result.data,png);
});

test('foreign status URL never receives the connection credential', async () => {
  let calls = 0;
  await assert.rejects(generateAsset(provider, {kind:'image',prompt:'one'}, {
    request:async()=>{ calls++; return Response.json({status_url:'https://other.invalid/task'}); }
  }), /当前 API 连接/);
  assert.equal(calls,1);
});
