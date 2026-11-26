'use strict';

// Attachment grants belong to a renderer process. Persist only display names
// so a new window can ask the user to select the files again.
const ChatDrafts = (() => {
  const prefix = 'xiaoxiao-chat-draft:';
  // Keystrokes can reach disk before a credential is complete.
  const mask = text => text.replace(/\bsk-[a-z\d_-]*/ig, '[已隐藏密钥]');
  const label = name => mask(name.split(/[\\/]/).pop()).slice(0, 255);
  function record(draft) {
    const text = typeof draft?.text === 'string' ? mask(draft.text).slice(0, 64000) : '';
    const references = [...(draft?.attachments || []).map(file => file.name), ...(draft?.missing || [])]
      .filter(name => typeof name === 'string' && name).slice(0, 8).map(label);
    if (!text && !references.length) return null;
    return { text, missing: references, agent: draft.agent === true, planning: draft.planning === true,
      providerId: typeof draft.providerId === 'string' ? draft.providerId : '',
      skillIds: Array.isArray(draft.skillIds) ? draft.skillIds.filter(id => typeof id === 'string').slice(0, 3) : [] };
  }
  function read(storage, owner) {
    try { return record(JSON.parse(storage.getItem(prefix + owner))); }
    catch { return null; }
  }
  function write(storage, owner, draft) {
    const value = record(draft);
    const encoded = value && JSON.stringify(value);
    if (storage.getItem(prefix + owner) === encoded) return;
    if (encoded === null) storage.removeItem(prefix + owner);
    else storage.setItem(prefix + owner, encoded);
  }
  return { read, write, label, mask };
})();
if (typeof module !== 'undefined') module.exports = ChatDrafts;
