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

async function readLimited(response, limit, label, report) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) throw Error(`${label}超过 ${Math.round(limit / 1024 / 1024)} MiB 限制`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0, lastUpdate = 0;
  const length = !response.headers.get('content-encoding') && advertised > 0 ? advertised : null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw Error(`${label}超过 ${Math.round(limit / 1024 / 1024)} MiB 限制`);
      chunks.push(Buffer.from(value));
      if (report && performance.now() - lastUpdate >= 150) {
        report(total, length);
        lastUpdate = performance.now();
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  report?.(total, length);
  return Buffer.concat(chunks, total);
}

async function jsonResponse(response, limit = MAX_JSON) {
  const raw = await readLimited(response, limit, '生成服务响应');
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Error('生成服务返回的 JSON 无法解析'); }
}

async function mediaBytes(response, label, report) {
  const bytes = await readLimited(response, MAX_OUTPUT, label, report);
  if (!bytes.length) throw Error(`${label}为空，未取得文件`);
  return bytes;
}

function base64Asset(data, mimeType, filename) {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Error('生成服务返回了无效的 base64 数据');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_OUTPUT) throw Error('生成结果超过 64 MiB 限制');
  return { data: bytes.toString('base64'), mimeType, filename };
}

async function urlAsset(url, mimeType, filename, signal, request, transfer) {
  let parsed;
  try { parsed = new URL(url); } catch { throw Error('生成服务返回了无效的资源地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Error('生成服务返回了不支持的资源地址');
  const response = await request(parsed.href, { signal, redirect: 'follow' });
  if (!response.ok) throw Error(`读取生成结果失败 HTTP ${response.status}`);
  const data = await mediaBytes(response, '生成结果', transfer?.('asset'));
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

async function materializeAssets(assets, signal, request, transfer) {
  const results = [];
  let bytes = 0;
  for (const asset of assets) {
    const result = asset.url ? await urlAsset(asset.url, asset.mimeType, asset.filename, signal, request, transfer) : asset;
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

function detectImage(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function normalizeImage(asset) {
  const mimeType = detectImage(Buffer.from(asset.data.slice(0, 24), 'base64'));
  if (!mimeType) throw Error('生成服务没有返回 PNG、JPEG 或 WebP 图片');
  return { ...asset, mimeType, filename: 'xiaoxiao-image.' + (mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)) };
}

function imageEditForm(reference, fields) {
  const { mimeType, data } = reference || {};
  const limit = 16 * 1024 * 1024;
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(limit / 3) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Error('参考图无效或超过 16 MiB');
  const bytes = Buffer.from(data, 'base64');
  const mime = detectImage(bytes);
  if (!mime || mime !== mimeType || bytes.length > limit) throw Error('请选择 16 MiB 以内的 PNG、JPEG 或 WebP 原图');
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (['image', 'image[]', 'mask'].includes(key) || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw Error('参考图编辑仅支持标量参数，图片由所选原图提供');
    }
    form.set(key, String(value));
  }
  form.set('image', new Blob([bytes], { type: mime }), 'reference.' + mime.split('/')[1]);
  return form;
}

function imageHttpError(status) {
  const hint = ({
    400: '请核对生图模型 ID、尺寸和质量，或把质量恢复为模型默认。',
    401: '请在模型配置中检查 API Key。', 403: '请核对该账户的生图权限。',
    404: '请核对 API 基础地址和生成接口路径。',
    429: '请查看账户额度或稍后重试。'
  })[status] || '请查看服务商记录后决定是否重试。';
  return Error(`生成服务返回 HTTP ${status}。${hint}`);
}

function pollAddress(baseUrl, address) {
  const base = new URL(baseUrl.replace(/\/+$/, '') + '/');
  const next = new URL(address, base);
  if (next.origin !== base.origin || !next.pathname.startsWith(base.pathname) || next.username || next.password || next.hash) {
    throw Error('图像任务的查询地址不属于当前 API 连接');
  }
  return next.href;
}

function remotePercent(payload) {
  const explicit = payload.progress_percent ?? payload.percentage;
  if (Number.isFinite(explicit) && explicit >= 0 && explicit <= 100) return explicit;
  const match = typeof payload.progress === 'string' && /^(\d+(?:\.\d+)?)%$/.exec(payload.progress);
  return match && Number(match[1]) <= 100 ? Number(match[1]) : null;
}

async function awaitImageOutput(payload, provider, options, transfer) {
  const {signal, request, pollDelayMs, onStatus} = options;
  const route = payload?.status_url ?? payload?.polling_url;
  if (typeof route !== 'string' || !route || responseAssetsPresent(payload)) return payload;
  const url = pollAddress(provider.baseUrl, route);
  for (let attempt = 1; attempt <= 90; attempt++) {
    if (payload.error || /^(failed|error|cancelled|canceled)$/i.test(payload.status)) throw Error('服务端报告图像任务失败或已取消');
    const percent = remotePercent(payload);
    onStatus({phase:'render', text:'等待服务端生成', attempt:attempt - 1, percent});
    await wait(pollDelayMs, signal);
    const result = await request(url, {headers:headers(provider), signal, redirect:'error'});
    if (!result.ok) { await result.body?.cancel(); throw imageHttpError(result.status); }
    const raw = await readLimited(result, 96 * 1024 * 1024, '图像任务响应', transfer('pollReceive'));
    try { payload = JSON.parse(raw.toString()); }
    catch { throw Error('图像任务查询返回了无效 JSON'); }
    if (!payload || typeof payload !== 'object') throw Error('图像任务查询结果无效');
    if (responseAssetsPresent(payload) || /^(done|success|succeeded|completed)$/i.test(payload.status)) return payload;
  }
  throw Error('已结束本机查询，服务端尚未返回作品，请核对服务商任务记录');
}

function responseAssetsPresent(payload) {
  return Boolean(payload?.data?.length || payload?.data?.url || payload?.output || payload?.result || payload?.image_url || payload?.image_base64);
}

async function imageResponse(response, provider, options) {
  const {signal, request, onStatus} = options;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/html')) {
    await response.body?.cancel();
    throw Error('接口返回了网页，没有返回图片。请核对 Base URL 是否需要 /v1，以及生成接口路径。');
  }
  let received = 0;
  function transfer(phase) {
    const previous = received;
    return (bytes, total) => {
      received = previous + bytes;
      onStatus({phase, text:phase === 'asset' ? '正在接收图像文件' : '正在接收接口响应',
        bytes:received, partBytes:bytes, partTotal:total >= bytes ? total : null});
    };
  }
  const raw = await readLimited(response, type.includes('image/') ? MAX_OUTPUT : 96 * 1024 * 1024, '图像响应', transfer('receive'));
  if (!raw.length) throw Error('生成结果为空，未取得文件');
  if (detectImage(raw)) return normalizeImage({data:raw.toString('base64')});
  const prefix = raw.subarray(0, 256).toString().trimStart();
  if (prefix.startsWith('<')) throw Error('接口返回了网页，没有返回图片。请核对 Base URL 和生成接口路径。');
  if (!type.includes('json') && !prefix.startsWith('{')) throw Error('接口没有返回 PNG、JPEG 或 WebP 图片，请检查生成接口的输出格式。');
  let payload;
  try { payload = JSON.parse(raw.toString()); }
  catch { throw Error('图像接口返回了无效 JSON，请检查网关的响应格式。'); }
  payload = await awaitImageOutput(payload, provider, options, transfer);
  if (payload?.error) throw Error('服务在响应中报告生成失败。请核对模型权限与所选参数。');
  if (payload?.choices && !payload.data) throw Error('接口返回了对话响应，请选择图像生成模型和对应的生成接口。');
  const outputs = responseAssets(payload, 'image');
  if (!outputs.length) throw Error('响应中没有图像文件。请确认服务支持图像接口并返回图片地址或 base64。');
  const images = (await materializeAssets(outputs, signal, request, transfer)).map(normalizeImage);
  return { ...images[0], assets: images, ...(Number.isSafeInteger(payload.usage?.total_tokens) && payload.usage.total_tokens >= 0 && {totalTokens:payload.usage.total_tokens}) };
}

async function generateAsset(provider, input, { signal, request = fetch, pollDelayMs = 2000, onStatus = () => {}, onSubmit = () => {}, onVideoId = () => {} } = {}) {
  if (!input || !['image', 'video', 'audio'].includes(input.kind)) throw Error('不支持的生成类型');
  const kind = input.kind;
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 8000) throw Error('请输入 1 至 8000 个字符的生成内容');
  const editingImage = input.reference != null;
  if (editingImage && (kind !== 'image' || input.destination?.baseUrl !== provider.baseUrl ||
      input.destination?.model !== provider.model)) throw Error('参考图发送目标已更改，请重新选择模型后提交');
  const url = editingImage ? endpoint(provider.baseUrl, input.editEndpoint, '/images/edits')
    : endpoint(provider.baseUrl, input.endpoint, defaults[kind]);
  let requestPrompt = prompt;
  if (kind === 'image') {
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
    ? { model: provider.model, prompt: requestPrompt, ...(input.size && {size:String(input.size)}), ...(Number(input.count) > 1 && {n:Math.min(4, Math.floor(input.count))}) }
    : kind === 'video'
      ? { model: provider.model, prompt: requestPrompt, seconds: String(Number(input.duration) || 5), size: ({ '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024' })[input.aspectRatio] || '1280x720' }
      : { model: provider.model, input: prompt, voice: String(input.voice || 'alloy'), response_format: String(input.format || 'mp3'), speed: Number(input.speed) || 1 };
  if (kind === 'image') {
    if (input.quality) body.quality = String(input.quality);
  }
  if (input.options !== undefined) {
    if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options)
      || JSON.stringify(input.options).length > 16000) throw Error('高级参数需要是有效 JSON 对象，且不超过 16 KiB');
    if (kind === 'image' && ['size', 'quality', 'n'].some(key => Object.hasOwn(body, key) && Object.hasOwn(input.options, key))) {
      throw Error('高级参数与所选输出规格重复，请移除重复的 size、quality 或 n。');
    }
    if (Object.hasOwn(input.options, 'model')) throw Error('请在模型选择器中选择模型，并从高级参数中移除 model。');
    if (editingImage && Object.hasOwn(input.options, 'prompt')) throw Error('请在工作室中填写参考图的提示词');
    Object.assign(body, input.options);
  }
  onStatus({ phase: 'submit', text: kind === 'image' ? '正在等待服务响应' : kind === 'video' ? '正在提交视频生成任务…' : '正在提交生成任务…' });
  const init = { method: 'POST', headers: headers(provider), body: JSON.stringify(body), signal, redirect: 'error' };
  if (editingImage) {
    init.body = imageEditForm(input.reference, body);
    delete init.headers['content-type'];
  }
  signal?.throwIfAborted();
  onSubmit();
  const response = await request(url, init);
  if (kind === 'image') onStatus({phase:'headers', text:'已收到响应头', httpStatus:response.status});
  if (!response.ok) {
    await response.body?.cancel();
    throw kind === 'image' ? imageHttpError(response.status) : Error(`生成服务返回 HTTP ${response.status}`);
  }
  if (kind === 'image') return imageResponse(response, provider, {signal, request, pollDelayMs, onStatus});
  if (kind !== 'audio' && !(response.headers.get('content-type') || '').includes('json')) {
    const data = await mediaBytes(response, '生成结果');
    const mimeType = response.headers.get('content-type') || (kind === 'image' ? 'image/png' : 'video/mp4');
    const asset = { data: data.toString('base64'), mimeType, filename: 'xiaoxiao-video.mp4' };
    return asset;
  }
  if (kind === 'audio' && !(response.headers.get('content-type') || '').includes('json')) {
    const data = await mediaBytes(response, '语音结果');
    const mimeType = body.response_format === 'mp3' ? 'audio/mpeg' : `audio/${body.response_format}`;
    return { data: data.toString('base64'), mimeType, filename: `xiaoxiao-audio.${body.response_format}` };
  }
  const payload = await jsonResponse(response);
  const ids = kind === 'video' ? [payload?.id, payload?.task_id, payload?.data?.id] : [];
  const videoId = ids.find(id => (typeof id === 'string' || Number.isSafeInteger(id))
    && /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/.test(String(id)));
  // The download may fail or be interrupted even when the submission already succeeded.
  if (videoId !== undefined) await onVideoId(String(videoId));
  const outputs = responseAssets(payload, kind);
  if (kind === 'video' && outputs.some(asset => asset.url)) onStatus({ phase: 'download', text: '正在下载生成的视频…' });
  const assets = await materializeAssets(outputs, signal, request);
  if (assets.length) return { ...assets[0], assets };
  if (videoId === undefined) {
    if (ids.some(id => id != null && id !== '')) throw Error('远程视频任务号无效');
    throw Error('生成服务没有返回可播放的结果');
  }
  return pollVideo(provider, input, String(videoId), { signal, request, pollDelayMs, onStatus });
}

function videoCancelUrl(baseUrl, route, videoId) {
  if (typeof route !== 'string' || !route.includes('{id}') || /[?#]/.test(route) ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/.test(videoId)) throw Error('取消路径需要包含 {id} 和原任务号');
  return endpoint(baseUrl, route.replace('{id}', encodeURIComponent(videoId)), '');
}

async function cancelRemoteVideo(provider, route, videoId, {signal, request = fetch} = {}) {
  const response = await request(videoCancelUrl(provider.baseUrl, route, videoId), {
    method: 'POST', headers: headers(provider), body: '{}', signal, redirect: 'error'
  });
  if (!response.ok) throw Error('取消请求返回 HTTP ' + response.status + '，请查询原任务状态');
  if (!(response.headers.get('content-type') || '').includes('json')) {
    await response.body?.cancel();
    return false;
  }
  const result = await jsonResponse(response);
  const id = result?.id ?? result?.task_id ?? result?.data?.id;
  return (id == null || String(id) === videoId) &&
    ['canceled', 'cancelled'].includes(String(result?.status || result?.data?.status).toLowerCase());
}

async function pollVideo(provider, input, videoId, { signal, request = fetch, pollDelayMs = 2000, onStatus = () => {} } = {}) {
  const url = endpoint(provider.baseUrl, input.endpoint, defaults.video);
  const kind = 'video';
  const pollPath = input.pollEndpoint ? String(input.pollEndpoint).replace('{id}', encodeURIComponent(String(videoId))) : '';
  const pollUrl = pollPath ? endpoint(provider.baseUrl, pollPath, '') : `${url.replace(/\/$/, '')}/${encodeURIComponent(String(videoId))}`;
  for (let attempt = 0; attempt < 90; attempt++) {
    await wait(pollDelayMs, signal);
    onStatus({ phase: 'poll', attempt: attempt + 1, text: `正在查询视频任务 · 第 ${attempt + 1} 次` });
    const poll = await request(pollUrl, { headers: headers(provider), signal, redirect: 'error' });
    if (!poll.ok) throw Error(`视频任务查询失败 HTTP ${poll.status}`);
    const payload = await jsonResponse(poll);
    const status = String(payload.status || '').toLowerCase();
    if (['cancelled', 'canceled'].includes(status) && (payload.id == null || String(payload.id) === String(videoId))) {
      const error = Error('服务已确认取消视频任务');
      error.code = 'VIDEO_CANCELED';
      throw error;
    }
    if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) throw Error(payload.error?.message || '视频生成失败');
    const outputs = responseAssets(payload, kind);
    if (outputs.some(asset => asset.url)) onStatus({ phase: 'download', text: '正在下载生成的视频…' });
    const assets = await materializeAssets(outputs, signal, request);
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
        const data = await mediaBytes(content, '视频结果');
        return { data: data.toString('base64'), mimeType: 'video/mp4', filename: 'xiaoxiao-video.mp4' };
      }
      throw Error('视频任务已完成，但服务没有返回视频文件');
    }
  }
  throw Error('视频生成超过 3 分钟仍未完成');
}

module.exports = { defaults, generateAsset, pollVideo, cancelRemoteVideo, videoCancelUrl };
