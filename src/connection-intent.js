'use strict';

const ConnectionIntent = (() => {
  const pattern = /\bsk-[a-z\d_-]{8,}/ig;
  const hidden = '[已隐藏密钥]';
  const mask = text => typeof text === 'string' ? text.replace(pattern, hidden) : text;

  function detect(text) {
    if (typeof text !== 'string') return null;
    const keys = [...new Set(text.match(pattern) || [])];
    const addresses = [...new Set((text.match(/https?:\/\/[^\s<>"'，。；、（）【】\x60]+/ig) || [])
      .map(value => value.replace(/[),.;]+$/, '')))];
    const testing = /测试|检测|连通|验证|(?:^|\b)(?:test|check)\b/i.test(text);
    const service = /接口|\bapi\b|模型|网关|密钥|\/v1\b|\/models\b/i.test(text);
    if (!keys.length && !(testing && (addresses.length || /接口|网关|\bapi\b/i.test(text)) && (service || text.includes(hidden)))) return null;
    const unambiguous = addresses.length === 1 && keys.length <= 1;
    return { address: addresses.length === 1 ? mask(addresses[0]) : '', key: unambiguous ? keys[0] || '' : '' };
  }

  function modelsUrl(address) {
    if (typeof address !== 'string' || address.length > 2048) throw Error('请填写有效的接口地址');
    let url;
    try { url = new URL(address); } catch { throw Error('请填写完整的 HTTPS 地址'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash ||
        !/^\/[a-z\d/_.~-]*$/i.test(url.pathname) || mask(url.href) !== url.href) {
      throw Error('请使用 HTTPS 或本机 HTTP 地址，并去除地址中的密钥、查询参数和片段');
    }
    const base = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/, '');
    url.pathname = !base ? '/v1/models' : /\/models$/.test(base) ? base : base + '/models';
    return url.href;
  }

  return { mask, detect, modelsUrl };
})();
if (typeof module !== 'undefined') module.exports = ConnectionIntent;
