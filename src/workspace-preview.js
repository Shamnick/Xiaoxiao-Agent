'use strict';

const { BrowserWindow, session } = require('electron');

function previewAddress(value) {
  const invalid = () => Error('请输入本机网页地址，例如 http://localhost:5173');
  if (typeof value !== 'string' || value.length > 2048) throw invalid();
  let url;
  try { url = new URL(value); }
  catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw invalid();
  }
  return url;
}

function allowsRequest(value, address) {
  const url = new URL(value);
  if (['ws:', 'wss:'].includes(url.protocol)) {
    url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  }
  return url.origin === address.origin || url.protocol === 'data:';
}

let activeWindow, opening = false;
async function openPreview(value, owner, icon, show) {
  const address = previewAddress(value);
  if (opening) throw Error('正在打开项目预览，请稍候');
  opening = true;
  let view, timer;
  try {
    activeWindow?.destroy();
    const isolated = session.fromPartition('xiaoxiao-project-preview', { cache: false });
    // Each window starts with a fresh storage context and shares no session with the workbench.
    await isolated.clearStorageData();
    await isolated.setProxy({ mode: 'direct' });
    if (owner.isDestroyed()) throw Error('工作台窗口已关闭');
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_, _permission, respond) => respond(false));
    isolated.webRequest.onBeforeRequest(({ url }, respond) => {
      let allowed = false;
      try { allowed = allowsRequest(url, address); }
      catch { /* Block invalid request URLs. */ }
      respond({ cancel: !allowed });
    });
    view = new BrowserWindow({
      width: 1040, height: 730, minWidth: 460, minHeight: 360,
      title: `项目预览 · ${address.host}`, icon, show: false, autoHideMenuBar: true,
      webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: show }
    });
    activeWindow = view;
    const close = () => { if (!view.isDestroyed()) view.destroy(); };
    owner.once('destroyed', close);
    view.on('closed', () => {
      owner.off('destroyed', close);
      if (activeWindow === view) activeWindow = null;
    });
    view.on('page-title-updated', event => event.preventDefault());
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', event => event.preventDefault());
    const guardNavigation = event => {
      const url = new URL(event.url);
      if (url.origin !== address.origin || !['http:', 'https:'].includes(url.protocol)) event.preventDefault();
    };
    contents.on('will-frame-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('before-input-event', (event, key) => {
      if (key.type === 'keyDown' && (process.platform === 'darwin' ? key.meta : key.control) && key.key.toLowerCase() === 'r') {
        event.preventDefault();
        contents.reload();
      }
    });
    // The preview session is isolated and contains at most one window.
    if (!isolated.listenerCount('will-download')) isolated.on('will-download', event => event.preventDefault());
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('等待本机预览页面超时')), 9000);
    });
    await Promise.race([contents.loadURL(address.href), timeout]);
    if (show) view.show();
    return true;
  } catch (error) {
    if (view && !view.isDestroyed()) view.destroy();
    if (error.code?.startsWith('ERR_')) throw Error(`无法连接 ${address.host}，请确认项目服务已启动。`);
    throw error;
  } finally {
    clearTimeout(timer);
    opening = false;
  }
}

module.exports = { openPreview };
