'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyWrittenText } = require('./write-verification');
const { modelsUrl } = require('./connection-intent');

async function checkConnection(address, key = '', request = fetch) {
  const endpoint = modelsUrl(address);
  if (typeof key !== 'string' || key.length > 1024 || /[^\x21-\x7e]/.test(key) || (key && endpoint.includes(key))) {
    throw Error('请检查密钥格式，并从地址中移除密钥');
  }
  const result = { endpoint, at: new Date().toISOString(), status: null, ok: false, count: null };
  const start = performance.now();
  const signal = AbortSignal.timeout(12000);
  try {
    const response = await request(endpoint, { method: 'GET', redirect: 'manual', signal,
      headers: { accept: 'application/json', ...(key && { authorization: 'Bearer ' + key }) } });
    result.status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      result.detail = [401, 403].includes(result.status) ? '服务拒绝访问，请核对密钥或模型列表权限。'
        : result.status >= 300 && result.status < 400 ? '服务要求跳转，请直接填写最终网关地址。' : '服务返回 HTTP 错误，请核对接口地址和服务状态。';
    } else {
      const chunks = [];
      let size = 0;
      for await (const part of response.body || []) {
        size += part.byteLength;
        if (size > 1024 * 1024) { result.detail = '响应超过 1 MiB，无法核对模型列表。'; break; }
        chunks.push(part);
      }
      if (!result.detail) {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (Array.isArray(data?.data) && data.data.every(item => typeof item?.id === 'string' && item.id.trim())) {
          result.ok = true;
          result.count = data.data.length;
          result.detail = '模型列表返回 ' + result.count + ' 项。';
        } else result.detail = '响应格式与模型列表不符。';
      }
    }
  } catch (error) {
    result.detail = signal.aborted ? '请求超时。' : error instanceof SyntaxError ? '响应不是有效的 JSON 模型列表。' : '网络请求未完成，请检查地址、网络和证书。';
  }
  result.elapsed = Math.round(performance.now() - start);
  return result;
}

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
function renderReport(r) {
  const fields = [
    ['请求地址', 'GET ' + r.endpoint], ['检查时间', r.at], ['HTTP 状态', r.status ?? '未收到'],
    ['总耗时', r.elapsed + ' ms'], ['模型数量', r.count ?? '无法核实']
  ];
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>接口检测报告 · Xiaoxiao Agent</title>' +
    '<style>body{margin:0;background:#121623;color:#eef0fa;font:16px/1.6 system-ui,sans-serif}main{max-width:44rem;margin:8vh auto;padding:1.8rem}small,dt{color:#b8c0d4}h1{margin:.4rem 0}h2{font-size:1.1rem;color:#d1c4f2}dl{background:#1d2333;border:1px solid #394054;border-radius:16px;padding:1rem 1.4rem}dt{font-size:.85rem}dd{margin:0 0 .75rem;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}dd:last-child{margin:0}</style><main><small>Xiaoxiao Agent</small><h1>接口检测报告</h1><h2>' +
    (r.ok ? '模型列表检查通过' : '模型列表检查未通过') + '</h2><p>' + escape(r.detail) + '</p><dl>' +
    fields.map(([label,value]) => '<dt>' + label + '</dt><dd>' + escape(value) + '</dd>').join('') +
    '</dl><small>本次执行了一次模型列表读取。对话生成、额度与模型推理能力需分别验证。</small></main></html>';
}

async function saveReport(root, result) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(root, 'check-'));
  const name = '接口检测报告.html';
  const file = path.join(dir, name);
  const bytes = Buffer.from(renderReport(result));
  try {
    await fs.writeFile(file, bytes, {flag:'wx',mode:0o600});
    if (await verifyWrittenText(file, bytes) !== 'matched') throw Error('无法核实报告文件，请重试');
    return { path:file, name };
  } catch (error) { await fs.rm(dir,{recursive:true,force:true}); throw error; }
}
module.exports = { modelsUrl, checkConnection, saveReport, renderReport };
