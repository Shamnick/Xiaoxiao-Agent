'use strict';

const { headers } = require('./providers');

const MAX_JSON = 4 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;
const defaults = Object.freeze({
  image: '/images/generations',
  video: '/videos',
  audio: '/audio/speech'
});

function endpoint(baseUrl, value, fallback) {
  const path = String(value || fallback).trim();
  if (!path || path.length > 240 || !path.startsWith('/') || path.includes('://') || path.includes('..')) {
    throw Error('生成接口路径无效，请填写以 / 开头的相对路径');
  }
  const url = new URL(path.slice(1), baseUrl.replace(/\/$/, '') + '/');
  if (url.origin !== new URL(baseUrl).origin) throw Error('生成接口路径无效');
  return url.href;
}

async function readLimited(response, limit, label) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) throw Error(`${label}超过 ${Math.round(limit / 1024 / 1024)} MiB 限制`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw Error(`${label}超过 ${Math.round(limit / 1024 / 1024)} MiB 限制`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function jsonResponse(response) {
  const raw = await readLimited(response, MAX_JSON, '生成服务响应');
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Error('生成服务返回的 JSON 无法解析'); }
}

function base64Asset(data, mimeType, filename) {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Error('生成服务返回了无效的 base64 数据');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_OUTPUT) throw Error('生成结果超过 64 MiB 限制');
  return { data: bytes.toString('base64'), mimeType, filename };
}

async function urlAsset(url, mimeType, filename, signal, request) {
  let parsed;
  try { parsed = new URL(url); } catch { throw Error('生成服务返回了无效的资源地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Error('生成服务返回了不支持的资源地址');
  const response = await request(parsed.href, { signal, redirect: 'follow' });
  if (!response.ok) throw Error(`读取生成结果失败 HTTP ${response.status}`);
  const data = await readLimited(response, MAX_OUTPUT, '生成结果');
  return { data: data.toString('base64'), mimeType: mimeType || response.headers.get('content-type') || 'application/octet-stream', filename };
}

function responseAsset(payload, kind) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const value = item || payload?.output || payload?.result;
  const mimeType = kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg';
  const filename = kind === 'image' ? 'xiaoxiao-image.png' : kind === 'video' ? 'xiaoxiao-video.mp4' : 'xiaoxiao-audio.mp3';
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) return { url: value, mimeType, filename };
    return base64Asset(value, mimeType, filename);
  }
  if (value?.b64_json || value?.base64) return base64Asset(value.b64_json || value.base64, value.mime_type || mimeType, filename);
  if (value?.url) return { url: value.url, mimeType: value.mime_type || mimeType, filename };
  for (const key of ['image_url', 'video_url', 'audio_url', 'asset_url']) {
    if (typeof payload?.[key] === 'string') return { url: payload[key], mimeType, filename };
  }
  for (const key of ['audio', 'audio_base64', 'image_base64', 'video_base64']) {
    if (typeof payload?.[key] === 'string') return base64Asset(payload[key], mimeType, filename);
  }
  return null;
}

function responseAssets(payload, kind) {
  if (Array.isArray(payload?.data)) {
    if (payload.data.length > 4) throw Error('单次最多接收 4 个生成结果');
    return payload.data.map(item => responseAsset({ data: item }, kind)).filter(Boolean);
  }
  const asset = responseAsset(payload, kind);
  return asset ? [asset] : [];
}

async function materializeAssets(assets, signal, request) {
  const results = [];
  let bytes = 0;
  for (const asset of assets) {
    const result = asset.url ? await urlAsset(asset.url, asset.mimeType, asset.filename, signal, request) : asset;
    bytes += Buffer.byteLength(result.data, 'base64');
    if (bytes > 128 * 1024 * 1024) throw Error('批量生成结果超过 128 MiB 限制');
    results.push(result);
  }
  return results;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve();
    };
    const onAbort = () => finish(signal.reason || Error('生成已取消'));
    const timer = setTimeout(() => finish(), ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function generateAsset(provider, input, { signal, request = fetch, pollDelayMs = 2000, onStatus = () => {} } = {}) {
  if (!input || !['image', 'video', 'audio'].includes(input.kind)) throw Error('不支持的生成类型');
  const kind = input.kind;
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 8000) throw Error('请输入 1 至 8000 个字符的生成内容');
  const url = endpoint(provider.baseUrl, input.endpoint, defaults[kind]);
  let requestPrompt = prompt;
  if (kind === 'image') {
    const stylePrompt = ({ cinematic: '电影感构图、层次光影与克制的色彩', illustration: '编辑插画风格、清晰形状语言与精致配色' })[input.style];
    if (stylePrompt) requestPrompt += `\n\n视觉风格：${stylePrompt}。`;
    if (input.negativePrompt) requestPrompt += `\n\n请避免：${String(input.negativePrompt).slice(0, 2000)}。`;
  }
  if (kind === 'video') {
    const cameraPrompt = ({ static: '固定镜头', pan: '平稳平移镜头', zoom: '缓慢推进镜头', orbit: '环绕主体运动的镜头' })[input.motion];
    if (cameraPrompt) requestPrompt += `\n\n镜头运动：${cameraPrompt}。`;
    if (input.audio === 'on') requestPrompt += '\n\n生成与画面匹配的原生音频。';
    if (input.audio === 'off') requestPrompt += '\n\n不包含音频。';
    if (input.negativePrompt) requestPrompt += `\n\n请避免：${String(input.negativePrompt).slice(0, 2000)}。`;
  }
  const body = kind === 'image'
    ? { model: String(input.model || provider.model), prompt: requestPrompt, size: String(input.size || '1024x1024'), n: Math.min(4, Math.max(1, Number(input.count) || 1)) }
    : kind === 'video'
      ? { model: String(input.model || provider.model), prompt: requestPrompt, seconds: String(Number(input.duration) || 5), size: ({ '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024' })[input.aspectRatio] || '1280x720' }
      : { model: String(input.model || provider.model), input: prompt, voice: String(input.voice || 'alloy'), response_format: String(input.format || 'mp3'), speed: Number(input.speed) || 1 };
  if (kind === 'image') {
    if (input.quality) body.quality = String(input.quality);
    if (['natural', 'vivid'].includes(input.style)) body.style = String(input.style);
  }
  if (input.options !== undefined) {
    if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options)
      || JSON.stringify(input.options).length > 16000) throw Error('高级参数需要是有效 JSON 对象，且不超过 16 KiB');
    Object.assign(body, input.options);
  }
  onStatus({ phase: 'submit', text: kind === 'video' ? '正在提交视频生成任务…' : '正在提交生成任务…' });
  const response = await request(url, { method: 'POST', headers: headers(provider), body: JSON.stringify(body), signal, redirect: 'error' });
  if (!response.ok) throw Error(`生成服务返回 HTTP ${response.status}`);
  if (kind !== 'audio' && !(response.headers.get('content-type') || '').includes('json')) {
    const data = await readLimited(response, MAX_OUTPUT, '生成结果');
    const mimeType = response.headers.get('content-type') || (kind === 'image' ? 'image/png' : 'video/mp4');
    return { data: data.toString('base64'), mimeType, filename: kind === 'image' ? 'xiaoxiao-image.png' : 'xiaoxiao-video.mp4' };
  }
  if (kind === 'audio' && !(response.headers.get('content-type') || '').includes('json')) {
    const data = await readLimited(response, MAX_OUTPUT, '语音结果');
    const mimeType = body.response_format === 'mp3' ? 'audio/mpeg' : `audio/${body.response_format}`;
    return { data: data.toString('base64'), mimeType, filename: `xiaoxiao-audio.${body.response_format}` };
  }
  let payload = await jsonResponse(response);
  let assets = await materializeAssets(responseAssets(payload, kind), signal, request);
  if (assets.length) return { ...assets[0], assets };
  const videoId = payload?.id || payload?.task_id || payload?.data?.id;
  if (kind !== 'video' || !videoId) throw Error('生成服务没有返回可播放的结果');
  const pollPath = input.pollEndpoint ? String(input.pollEndpoint).replace('{id}', encodeURIComponent(String(videoId))) : '';
  const pollUrl = pollPath ? endpoint(provider.baseUrl, pollPath, '') : `${url.replace(/\/$/, '')}/${encodeURIComponent(String(videoId))}`;
  for (let attempt = 0; attempt < 90; attempt++) {
    await wait(pollDelayMs, signal);
    onStatus({ phase: 'poll', attempt: attempt + 1, text: `视频生成中 · 已检查 ${attempt + 1} 次` });
    const poll = await request(pollUrl, { headers: headers(provider), signal, redirect: 'error' });
    if (!poll.ok) throw Error(`视频任务查询失败 HTTP ${poll.status}`);
    payload = await jsonResponse(poll);
    const status = String(payload.status || '').toLowerCase();
    if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) throw Error(payload.error?.message || '视频生成失败');
    assets = await materializeAssets(responseAssets(payload, kind), signal, request);
    if (assets.length) return { ...assets[0], assets };
    if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) {
      const contentPath = input.contentEndpoint
        ? String(input.contentEndpoint).replace('{id}', encodeURIComponent(String(videoId)))
        : '';
      const contentUrl = contentPath
        ? endpoint(provider.baseUrl, contentPath, '')
        : `${pollUrl.replace(/\/$/, '')}/content`;
      onStatus({ phase: 'download', text: '视频已生成，正在下载结果…' });
      const content = await request(contentUrl, { headers: headers(provider), signal, redirect: 'error' });
      if (!content.ok) throw Error(`读取生成视频失败 HTTP ${content.status}`);
      if ((content.headers.get('content-type') || '').includes('json')) {
        const finalPayload = await jsonResponse(content);
        const finalAssets = await materializeAssets(responseAssets(finalPayload, kind), signal, request);
        if (finalAssets.length) return { ...finalAssets[0], assets: finalAssets };
      } else {
        const data = await readLimited(content, MAX_OUTPUT, '视频结果');
        return { data: data.toString('base64'), mimeType: 'video/mp4', filename: 'xiaoxiao-video.mp4' };
      }
      throw Error('视频任务已完成，但服务没有返回视频文件');
    }
  }
  throw Error('视频生成超过 3 分钟仍未完成');
}

module.exports = { defaults, generateAsset };
