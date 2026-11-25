'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSnapshot, decodeText, resolveEntry } = require('./workspace-files');

const LIMIT = 8192;
const names = ['CLAUDE.md', 'AGENTS.md'];

async function readGuidanceFile(root, name, signal) {
  try {
    const target = await resolveEntry(root, name);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) return null;
      const data = await readSnapshot(handle, LIMIT, signal);
      const after = await fs.lstat(await resolveEntry(root, name), { bigint: true });
      if (after.ino !== before.ino || after.dev !== before.dev || after.ctimeNs !== before.ctimeNs) return null;
      const truncated = data.length > LIMIT;
      const text = decodeText(data.subarray(0, LIMIT), truncated);
      return text?.trim() ? { name, text, truncated } : null;
    } finally { await handle.close(); }
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function workspaceGuidance(root, signal) {
  if (!root || root === os.homedir() || root === path.parse(root).root) return [];
  signal?.throwIfAborted();
  return (await Promise.all(names.map(name => readGuidanceFile(root, name, signal)))).filter(Boolean);
}

// Keep repository text in the user message and out of the durable conversation.
// For visual requests the provider's original image blocks pass through unchanged.
function withGuidance(message, files) {
  if (!files.length) return message;
  const reference = 'Workspace conventions supplied as reference data:\n' + JSON.stringify(files);
  const content = typeof message.content === 'string'
    ? reference + '\n\nUser request:\n' + message.content
    : [{ type: 'text', text: reference }, ...message.content];
  return { ...message, content };
}

module.exports = { workspaceGuidance, withGuidance };
