'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../src/providers');
const { generateAsset } = require('../src/generation');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=';
const webp = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const provider = config({ kind: 'openai-compatible', name: 'local', model: 'media-model', baseUrl: 'http://127.0.0.1:3456/v1' });

test('generates an image from a standard JSON response', async () => {
  let requestUrl;
  const result = await generateAsset(provider, { kind: 'image', prompt: 'a red kite', endpoint: '/images/generations' }, {
    request: async (url, options) => {
      requestUrl = url;
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).model, 'media-model');
      return Response.json({ data: [{ b64_json: png }] });
    }
  });
  assert.equal(requestUrl, 'http://127.0.0.1:3456/v1/images/generations');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.data, png);
});

test('passes image count and creative options through and retains all returned images', async () => {
  const requested = [];
  const result = await generateAsset(provider, {
    kind: 'image', prompt: 'a quiet glass garden', count: 2, style: 'cinematic', negativePrompt: 'text, watermark'
  }, {
    request: async (_url, options) => {
      requested.push(JSON.parse(options.body));
      return Response.json({ data: [
        { b64_json: png },
        { b64_json: webp }
      ] });
    }
  });
  assert.equal(requested[0].n, 2);
  assert.match(requested[0].prompt, /电影感构图/);
  assert.match(requested[0].prompt, /text, watermark/);
  assert.equal(requested[0].style, undefined);
  assert.deepEqual(result.assets.map(asset => asset.data), [png, webp]);
  assert.equal(result.assets[1].filename, 'xiaoxiao-image.webp');
});

test('passes speech speed to the speech generation request', async () => {
  let body;
  await generateAsset(provider, { kind: 'audio', prompt: 'Hello', speed: 1.25 }, {
    request: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(Buffer.from('audio'), { headers: { 'content-type': 'audio/mpeg' } });
    }
  });
  assert.equal(body.speed, 1.25);
});

test('reads binary speech responses and polls video jobs', async () => {
  let calls = 0;
  const audio = await generateAsset(provider, { kind: 'audio', prompt: 'hello', format: 'mp3' }, {
    request: async () => new Response(Buffer.from('audio'), { headers: { 'content-type': 'audio/mpeg' } })
  });
  assert.equal(audio.mimeType, 'audio/mpeg');
  const video = await generateAsset(provider, { kind: 'video', prompt: 'a slow wave', pollEndpoint: '/videos/{id}' }, {
    pollDelayMs: 0,
    request: async (url, options) => {
      calls++;
      if (calls === 1) return Response.json({ id: 'job-1', status: 'queued' });
      assert.equal(url, 'http://127.0.0.1:3456/v1/videos/job-1');
      assert.equal(options.headers.authorization, undefined);
      return Response.json({ status: 'completed', data: [{ b64_json: Buffer.from('mp4').toString('base64') }] });
    }
  });
  assert.equal(video.mimeType, 'video/mp4');
  assert.equal(Buffer.from(video.data, 'base64').toString(), 'mp4');
});

test('rejects invalid relative generation paths', async () => {
  await assert.rejects(generateAsset(provider, { kind: 'image', prompt: 'x', endpoint: 'https://evil.invalid' }), /接口路径无效/);
});

test('persists a video receipt before fetching an inline download URL', async () => {
  const calls = [];
  await assert.rejects(generateAsset(provider, { kind: 'video', prompt: 'clip' }, {
    onVideoId: async id => { await Promise.resolve(); calls.push(id); },
    request: async (url, options) => {
      calls.push(options.method || 'GET');
      if (options.method === 'POST') return Response.json({ id: '', task_id: 'job-2', video_url: provider.baseUrl + '/clip' });
      return new Response(null, { status: 204 });
    }
  }), /结果为空/);
  assert.deepEqual(calls, ['POST', 'job-2', 'GET']);
});

test('keeps direct video delivery usable when an unrelated response ID cannot be polled', async () => {
  let recorded = false;
  const result = await generateAsset(provider, {kind:'video', prompt:'clip'}, {
    onVideoId: () => { recorded = true; },
    request: async () => Response.json({id:'group/invalid', video_base64:'AQ=='})
  });
  assert.equal(recorded, false);
  assert.equal(result.data, 'AQ==');
});

test('rejects empty binary media returned directly at submission', async () => {
  for (const kind of ['image', 'video', 'audio']) {
    await assert.rejects(generateAsset(provider, {kind, prompt:'sample'}, {
      request: async () => new Response(null, {status:204})
    }), /结果为空/);
  }
});

test('reference edits guard the selected destination, MIME and reserved fields before submission', async () => {
  const input = { kind:'image', prompt:'red', reference:{mimeType:'image/png',data:png},
    destination:{baseUrl:provider.baseUrl,model:provider.model} };
  let calls = 0;
  const request = async () => { calls++; return Response.json({}); };
  for (const [change, message] of [
    [{destination:{...input.destination, model:'changed'}}, /发送目标/],
    [{destination:{...input.destination, baseUrl:'https://other.invalid'}}, /发送目标/],
    [{reference:{...input.reference, mimeType:'image/jpeg'}}, /原图/],
    [{options:{image:'other'}}, /所选原图/], [{options:{model:'other'}}, /模型与提示词/],
    [{editEndpoint:'https://other.invalid/'}, /接口路径/]
  ]) await assert.rejects(generateAsset(provider,{...input,...change},{request}), message);
  assert.equal(calls,0);
});


test('an HTTP 200 error document cannot be delivered as an image', async () => {
  const input = {kind:'image',prompt:'test'};
  await assert.rejects(generateAsset(provider,input,{request:async () => new Response('<html>Error</html>')}), /没有返回.*图片/);
  await assert.rejects(generateAsset(provider,input,{request:async () => Response.json({data:[{b64_json:'ZXJyb3I='}]})}), /没有返回.*图片/);
});
