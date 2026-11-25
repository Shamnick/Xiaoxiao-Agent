'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../src/providers');
const { generateAsset } = require('../src/generation');

const provider = config({ kind: 'openai-compatible', name: 'local', model: 'media-model', baseUrl: 'http://127.0.0.1:3456/v1' });

test('generates an image from a standard JSON response', async () => {
  let requestUrl;
  const result = await generateAsset(provider, { kind: 'image', prompt: 'a red kite', endpoint: '/images/generations' }, {
    request: async (url, options) => {
      requestUrl = url;
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).model, 'media-model');
      return Response.json({ data: [{ b64_json: Buffer.from('png').toString('base64') }] });
    }
  });
  assert.equal(requestUrl, 'http://127.0.0.1:3456/v1/images/generations');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(Buffer.from(result.data, 'base64').toString(), 'png');
});

test('passes image count and creative options through and retains all returned images', async () => {
  const requested = [];
  const result = await generateAsset(provider, {
    kind: 'image', prompt: 'a quiet glass garden', count: 2, style: 'cinematic', negativePrompt: 'text, watermark'
  }, {
    request: async (_url, options) => {
      requested.push(JSON.parse(options.body));
      return Response.json({ data: [
        { b64_json: Buffer.from('first').toString('base64') },
        { b64_json: Buffer.from('second').toString('base64') }
      ] });
    }
  });
  assert.equal(requested[0].n, 2);
  assert.match(requested[0].prompt, /电影感构图/);
  assert.match(requested[0].prompt, /text, watermark/);
  assert.equal(requested[0].style, undefined);
  assert.deepEqual(result.assets.map(asset => Buffer.from(asset.data, 'base64').toString()), ['first', 'second']);
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
