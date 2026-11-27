const { contextBridge, ipcRenderer } = require('electron');
const call = channel => value => ipcRenderer.invoke(channel, value);
const subscribe = channel => callback => {
  if (typeof callback !== 'function') throw new TypeError('Expected an event callback');
  const listener = (_, event) => callback(event);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('nova', {
  platform: process.platform,
  brand: call('brand:get'),
  proof: { read: call('proof:read'), art: call('proof:art'), change: call('proof:change'), preview: call('proof:preview'), cancel: call('proof:cancel') },
  presence: { sample: call('presence:sample'), dictate: call('presence:dictate') },
  providers: {
    list: call('providers:list'), save: call('providers:save'), delete: call('providers:delete'),
    rememberModel: call('providers:rememberModel'), models: call('providers:models'), imageSpec: call('providers:imageSpec'), test: call('providers:test')
  },
  media: { analyze: call('media:analyze'), cancel: call('media:cancel') },
  generation: { receipts: call('generation:receipts'), forget: call('generation:forget'), run: call('generation:run'), cancel: call('generation:cancel'), save: call('generation:save'), saveAll: call('generation:saveAll'), onEvent: subscribe('generation:event') },
  messages: { checkConnection: call('messages:checkConnection'), copy: call('messages:copy'), rate: call('messages:rate'), saveFile: call('messages:saveFile'),
    openArtifact: call('messages:openArtifact') },
  conversations: {
    list: call('conversations:list'), create: call('conversations:create'), save: call('conversations:save'),
    branch: call('conversations:branch'), delete: call('conversations:delete'), export: call('conversations:export')
  },
  projects: {
    list: call('projects:list'), save: call('projects:save'),
    openFolder: call('projects:openFolder'), pickWorkspace: call('projects:workspace'), clearWorkspace: call('projects:clearWorkspace'),
    addSource: call('projects:addSource'), removeSource: call('projects:removeSource')
  },
  skills: { list: call('skills:list'), import: call('skills:import'), save: call('skills:save'), delete: call('skills:delete') },
  schedules: {
    list: call('schedules:list'), save: call('schedules:save'), remove: call('schedules:remove'), run: call('schedules:run'),
    onChange: subscribe('schedules:event')
  },
  draft: { export: call('draft:export'), exportPdf: call('draft:exportPdf'), exportDocx: call('draft:exportDocx') },
  workspace: {
    pick: call('workspace:pick'), list: call('workspace:list'), preview: call('workspace:preview'),
    attach: call('workspace:attach'), attachGitDiff: call('workspace:attachGitDiff'), change: call('workspace:change'),
    save: call('workspace:save'), createFile: call('workspace:createFile'),
    previewRestore: call('workspace:previewRestore'), restore: call('workspace:restore'), openPreview: call('workspace:openPreview'),
    search: call('workspace:search'), gitStatus: call('workspace:gitStatus'), gitDiff: call('workspace:gitDiff'), gitIndex: call('workspace:gitIndex'),
    gitCommitPreview: call('workspace:gitCommitPreview'), gitCommit: call('workspace:gitCommit'),
    gitBranches: call('workspace:gitBranches'), gitSwitch: call('workspace:gitSwitch')
  },
  code: { suggest: call('code:suggest'), cancel: call('code:cancel') },
  terminal: {
    open: call('terminal:open'), write: call('terminal:write'), resize: call('terminal:resize'), close: call('terminal:close'), acknowledge: call('terminal:ack'), onEvent: subscribe('terminal:event')
  },
  attachment: { pick: call('attachment:pick'), clear: call('attachment:clear') },
  preferences: { get: call('preferences:get'), set: call('preferences:set') },
  settings: { get: call('settings:get'), save: call('settings:save') },
  chat: {
    send: call('chat:send'), stop: call('chat:stop'), state: call('chat:state'), runs: call('chat:runs'), answer: call('chat:answer'),
    update: call('chat:update'),
    onEvent: subscribe('chat:event')
  }
});
