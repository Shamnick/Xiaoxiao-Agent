'use strict';

const mediaFrames = [];
let mediaFileUrl = '';
let mediaRequestId = '';
let mediaAnswer = '';
const mediaBytes = frames => frames.reduce((sum, frame) => sum + Math.ceil(frame.data.length * 0.75), 0);
const mediaTime = seconds => {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};

function renderMediaFrames() {
  const preview = $('mediaPreview');
  preview.hidden = mediaFrames.length === 0;
  preview.classList.toggle('single', mediaFrames.length === 1);
  preview.replaceChildren(...mediaFrames.map(frame => {
    const figure = document.createElement('figure');
    figure.className = 'media-frame';
    const image = document.createElement('img');
    image.src = `data:${frame.mimeType};base64,${frame.data}`;
    image.alt = frame.timestamp ? `视频画面 ${frame.timestamp}` : frame.name;
    const caption = document.createElement('figcaption');
    caption.textContent = frame.timestamp || frame.name;
    figure.append(image, caption);
    return figure;
  }));
  $('mediaDrop').hidden = mediaFrames.length > 0;
  $('analyzeMedia').disabled = mediaFrames.length === 0 || !$('mediaModel').value || Boolean(mediaRequestId);
  $('continueWithMedia').disabled = mediaFrames.length === 0 || !$('mediaModel').value || Boolean(mediaRequestId);
}

function resizeFrame(source, extras = {}) {
  const width = source.videoWidth || source.width;
  const height = source.videoHeight || source.height;
  const scale = Math.min(1, 1280 / width, 1280 / height);
  if (!width || !height) throw Error('无法读取画面尺寸');
  if (width * height > 40000000) throw Error('单帧超过 4000 万像素，无法安全处理');
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const encoded = canvas.toDataURL('image/jpeg', 0.78).split(',', 2)[1];
  if (encoded.length > 1024 * 1024) throw Error('图片压缩后仍超过 1 MiB，请选取较小的文件');
  return {
    name: extras.name || '', mimeType: 'image/jpeg', data: encoded,
    ...(extras.timestamp ? { timestamp: extras.timestamp } : {}),
    width: canvas.width, height: canvas.height
  };
}

async function inspectImage(file) {
  const bitmap = await createImageBitmap(file);
  try { mediaFrames.push(resizeFrame(bitmap, { name: file.name })); }
  finally { bitmap.close(); }
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('视频解码超时')), 8000);
    const finish = error => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      error ? reject(error) : resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(new Error('浏览器无法解码此视频，请使用 H.264 MP4 或 WebM'));
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = time;
  });
}

async function inspectVideo(file) {
  if (mediaFileUrl) URL.revokeObjectURL(mediaFileUrl);
  mediaFileUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.src = mediaFileUrl;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读取视频信息超时')), 10000);
    video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
    video.onerror = () => { clearTimeout(timer); reject(new Error('无法读取视频，请使用 H.264 MP4 或 WebM')); };
  });
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw Error('视频没有可读取的画面');
  if (video.videoWidth * video.videoHeight > 40000000) throw Error('视频分辨率超过单帧 4000 万像素的限制');
  for (let index = 0; index < 6; index++) {
    const time = Math.min(video.duration - 0.04, video.duration * (index + 0.5) / 6);
    await seekVideo(video, Math.max(0, time));
    const frame = resizeFrame(video, { name: file.name, timestamp: mediaTime(time) });
    if (mediaBytes(mediaFrames) + mediaBytes([frame]) > 4 * 1024 * 1024) throw Error('视频抽帧超过 4 MiB 限制，请换用较短或分辨率较低的视频');
    mediaFrames.push(frame);
    renderMediaFrames();
    $('mediaStatus').textContent = `正在提取画面 · ${index + 1}/6`;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
}

async function loadMediaFile(file) {
  if (!file) return;
  if (mediaRequestId) await api.media.cancel(mediaRequestId);
  mediaRequestId = '';
  mediaAnswer = '';
  mediaFrames.splice(0);
  $('mediaResult').textContent = '模型的回复会显示在这里。';
  $('mediaStatus').textContent = '';
  $('continueWithMedia').disabled = true;
  const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
  const isVideo = ['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type) || /\.(mp4|mov|webm)$/i.test(file.name);
  if (!isImage && !isVideo) throw Error('请选择 PNG、JPG、WebP、MP4、MOV 或 WebM 文件');
  const limit = isImage ? 24 : 80;
  if (file.size > limit * 1024 * 1024) throw Error(`文件超过 ${limit} MiB 限制`);
  $('mediaStatus').textContent = '正在读取并压缩画面…';
  try {
    if (isImage) await inspectImage(file);
    else await inspectVideo(file);
    if (mediaBytes(mediaFrames) > 4 * 1024 * 1024) throw Error('画面总量超过 4 MiB 限制');
    $('mediaStatus').textContent = isImage
      ? `${file.name} · ${mediaFrames[0].width} × ${mediaFrames[0].height}`
      : `${file.name} · 均匀抽取 6 帧，不包含音频`;
  } catch (error) {
    mediaFrames.splice(0);
    $('mediaStatus').textContent = error.message;
  }
  renderMediaFrames();
}

async function refreshMediaModels() {
  const rows = await api.providers.list();
  const select = $('mediaModel');
  const preferred = current?.providerId || $('modelSelect').value;
  select.replaceChildren(...rows.map(row => new Option(`${row.name} · ${row.model}`, row.id)));
  if (!rows.length) select.append(new Option('还没有模型配置', ''));
  if (rows.some(row => row.id === preferred)) select.value = preferred;
  renderMediaFrames();
}

$('openMediaLab').onclick = () => {
  $('mediaLab').showModal();
  void refreshMediaModels().catch(error => { $('mediaStatus').textContent = error.message; });
};
$('closeMediaLab').onclick = () => $('mediaLab').close();
$('mediaLab').addEventListener('close', () => {
  if (mediaRequestId) void api.media.cancel(mediaRequestId);
  mediaRequestId = '';
  if (mediaFileUrl) URL.revokeObjectURL(mediaFileUrl);
  mediaFileUrl = '';
});
$('mediaModel').onchange = renderMediaFrames;
$('mediaFile').onchange = async event => {
  try { await loadMediaFile(event.target.files[0]); }
  catch (error) { $('mediaStatus').textContent = error.message; }
  event.target.value = '';
};
$('mediaDrop').onclick = () => $('mediaFile').click();
$('mediaDrop').onkeydown = event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('mediaFile').click(); }
};
for (const type of ['dragenter', 'dragover']) $('mediaDrop').addEventListener(type, event => {
  event.preventDefault();
  $('mediaDrop').classList.add('drag-over');
});
for (const type of ['dragleave', 'drop']) $('mediaDrop').addEventListener(type, event => {
  event.preventDefault();
  $('mediaDrop').classList.remove('drag-over');
});
$('mediaDrop').addEventListener('drop', async event => {
  try { await loadMediaFile(event.dataTransfer.files[0]); }
  catch (error) { $('mediaStatus').textContent = error.message; }
});
$('cancelMedia').onclick = async () => {
  if (!mediaRequestId) return;
  const request = mediaRequestId;
  await api.media.cancel(request);
  mediaRequestId = '';
  $('cancelMedia').hidden = true;
  $('mediaStatus').textContent = '已停止。';
  renderMediaFrames();
};
$('analyzeMedia').onclick = async () => {
  const requestId = crypto.randomUUID();
  mediaRequestId = requestId;
  mediaAnswer = '';
  $('mediaResult').textContent = '';
  $('mediaStatus').textContent = '正在向视觉模型发送画面…';
  $('cancelMedia').hidden = false;
  renderMediaFrames();
  try {
    const result = await api.media.analyze({
      requestId, providerId: $('mediaModel').value,
      prompt: $('mediaQuestion').value, media: structuredClone(mediaFrames)
    });
    if (mediaRequestId !== requestId) return;
    mediaAnswer = result;
    $('mediaResult').textContent = result || '模型没有返回文本。';
    $('mediaStatus').textContent = `已完成 · ${$('mediaModel').selectedOptions[0]?.textContent || ''}`;
    $('continueWithMedia').disabled = false;
  } catch (error) {
    if (mediaRequestId === requestId) $('mediaStatus').textContent = error.message;
  } finally {
    if (mediaRequestId === requestId) {
      mediaRequestId = '';
      $('cancelMedia').hidden = true;
      renderMediaFrames();
    }
  }
};
$('continueWithMedia').onclick = async () => {
  if (!mediaFrames.length || locked) return;
  $('modelSelect').value = $('mediaModel').value;
  $('agent').checked = true;
  planning = false;
  const question = $('mediaQuestion').value.trim() || '请检查这些图片或视频画面并总结关键内容。';
  const handoff = [
    question,
    `视觉测试模型：${$('mediaModel').selectedOptions[0]?.textContent || '未知'}。`,
    mediaAnswer ? `先前模型的初步分析如下，请结合附带画面独立核实后再回答。\n\n${mediaAnswer}` : ''
  ].filter(Boolean).join('\n\n');
  const frames = structuredClone(mediaFrames);
  $('mediaLab').close();
  await sendMessage(handoff, false, frames);
};
