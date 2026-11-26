'use strict';

// One local record per artwork. Only the user's instructions are restorable;
// model output remains a preview until explicitly accepted.
const ProofInstructions = (() => {
  const targets = ['title', 'body', 'voice'];
  const briefs = ['launch', 'invite'];
  function owner(scope) {
    return scope.conversationId ? ['chat', scope.conversationId] :
      scope.projectId ? ['project', scope.projectId] : ['home'];
  }
  function key(scope, brief) {
    return 'xiaoxiao-proof-instructions:' + JSON.stringify([...owner(scope), brief]);
  }
  function locationKey(scope) {
    return 'xiaoxiao-proof-brief:' + JSON.stringify(owner(scope));
  }
  function lastBrief(storage, scope) {
    try {
      const id = storage.getItem(locationKey(scope));
      return briefs.includes(id) ? id : 'launch';
    } catch { return 'launch'; }
  }
  function rememberBrief(storage, scope, id) {
    if (!briefs.includes(id)) return;
    if (id === 'launch') storage.removeItem(locationKey(scope));
    else storage.setItem(locationKey(scope), id);
  }
  function read(storage, scope, brief) {
    const clean = { selected: null, fields: {} };
    try {
      const record = JSON.parse(storage.getItem(key(scope, brief)));
      if (targets.includes(record?.selected)) clean.selected = record.selected;
      for (const field of ['unassigned', ...targets]) {
        const text = record?.fields?.[field];
        if (typeof text === 'string' && text.trim()) clean.fields[field] = text.slice(0, 240);
      }
    } catch { /* A single unreadable record must not prevent opening the artwork. */ }
    return clean;
  }
  function save(storage, scope, brief, record) {
    const id = key(scope, brief);
    if (!Object.keys(record.fields).length) storage.removeItem(id);
    else storage.setItem(id, JSON.stringify(record));
  }
  function forgetConversation(storage, conversationId) {
    storage.removeItem(locationKey({ conversationId }));
    for (const brief of briefs) storage.removeItem(key({ conversationId }, brief));
  }
  return { read, save, lastBrief, rememberBrief, forgetConversation };
})();
if (typeof module !== 'undefined') module.exports = ProofInstructions;
