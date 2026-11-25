'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { readSnapshot } = require('./workspace-files');

// The caller has already committed the write. A failed check must keep its delivery
// receipt so a resume does not mistake it for an action that never happened.
async function verifyWrittenText(target, expected, verifyParent) {
  const bytes = Buffer.from(expected, 'utf8');
  try {
    await verifyParent?.();
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(bytes.length)) return 'unconfirmed';
      const actual = await readSnapshot(handle, bytes.length);
      await verifyParent?.();
      const after = await fs.lstat(target, { bigint: true });
      return after.dev === before.dev && after.ino === before.ino && after.ctimeNs === before.ctimeNs && actual.equals(bytes)
        ? 'matched' : 'unconfirmed';
    } finally { await handle.close(); }
  } catch { return 'unconfirmed'; }
}

module.exports = { verifyWrittenText };
