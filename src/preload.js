const { contextBridge, ipcRenderer } = require('electron');
const call = channel => value => ipcRenderer.invoke(channel, value);
contextBridge.exposeInMainWorld('nova', {
  brand: call('brand:get'),
  providers: {
    list: call('providers:list'), save: call('providers:save'), delete: call('providers:delete'),
    models: call('providers:models'), test: call('providers:test')
  },
  conversations: {
    list: call('conversations:list'), create: call('conversations:create'), save: call('conversations:save'),
    delete: call('conversations:delete'), export: call('conversations:export')
  },
  workspace: { pick: call('workspace:pick') },
  attachment: { pick: call('attachment:pick'), clear: call('attachment:clear') },
  settings: { get: call('settings:get'), save: call('settings:save') },
  chat: {
    send: call('chat:send'), stop: call('chat:stop'),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Expected an event callback');
      const listener = (_, event) => callback(event);
      ipcRenderer.on('chat:event', listener);
      return () => ipcRenderer.removeListener('chat:event', listener);
    }
  }
});
