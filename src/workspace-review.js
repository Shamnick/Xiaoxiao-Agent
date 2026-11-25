'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { diffLines } = require('diff');
const path = require('node:path');
const { readSnapshot, decodeText } = require('./workspace-files');

const BEFORE_LIMIT = 64 * 1024;
const conflict = () => Object.assign(new Error('文件在确认期间已更改。请重新读取并审阅。'), { code: 'WORKSPACE_CHANGED' });
const typeError = () => new Error('Write target must be a regular file, not a symlink');
const same = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(key => left[key] === right[key]);

async function inspect(target, signal) {
  let initial;
  try { initial = await fs.lstat(target, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!initial.isFile()) throw typeError();
  if (initial.nlink > 1) throw Error('Write target must be a regular file without hard links');
  const file = await fs.open(target, constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY);
  try {
    const actual = await file.stat({ bigint: true });
    if (!same(initial, actual)) throw conflict();
    const buffer = await readSnapshot(file, BEFORE_LIMIT, signal);
    if (buffer.length > BEFORE_LIMIT) throw Error('原文件超出 64 KiB，无法完整审阅');
    if (!same(actual, await file.stat({ bigint: true }))) throw conflict();
    const text = decodeText(buffer);
    if (text === null) throw Error('原文件不是可审阅的 UTF-8 文本');
    return { stat: actual, text, buffer };
  } finally { await file.close(); }
}

function workspaceDiff(relative, before, content) {
  const original = before ?? '';
  // Bound the diff cost for highly fragmented files. Both full versions remain available if diffing times out.
  const parts = diffLines(original, content, { timeout: 110, maxEditLength: 2400 });
  const chunks = parts ? parts.map(({ value, count, added, removed }) => ({
    kind: added ? 'add' : removed ? 'remove' : 'context', count, value
  })) : null;
  const counts = chunks && chunks.reduce((sum, row) => {
    if (row.kind !== 'context') sum[row.kind] += row.count;
    return sum;
  }, { add: 0, remove: 0 });
  return { path: relative, created: before === null, before: original, after: content, chunks, counts };
}

async function applyReviewedWrite({ target, content, before, verifyParent, signal }) {
  await verifyParent();
  const parent = path.dirname(target);
  const directory = await fs.mkdtemp(path.join(parent, '.xiaoxiao-write-'));
  const temporary = path.join(directory, 'file.tmp');
  try {
    const mode = before ? Number(before.stat.mode & 0o777n) : 0o600;
    await fs.writeFile(temporary, content, { mode, flag: 'wx', signal });
    if (before) await fs.chmod(temporary, mode);
    await verifyParent();
    let latest;
    try { latest = await inspect(target, signal); }
    catch (error) { signal?.throwIfAborted(); throw conflict(); }
    if (Boolean(before) !== Boolean(latest) || (before && (!same(before.stat, latest.stat) || !before.buffer.equals(latest.buffer)))) throw conflict();
    signal?.throwIfAborted();
    if (before) await fs.rename(temporary, target);
    else {
      // A same-directory link creates the destination without overwriting a file created while approval was open.
      try { await fs.link(temporary, target); }
      catch (error) { if (error.code === 'EEXIST') throw conflict(); throw error; }
    }
  } finally {
    // Remove the file by its known name and only remove the empty directory.
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
}

module.exports = { inspect, workspaceDiff, applyReviewedWrite };
