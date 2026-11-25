'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const PREVIEW_LIMIT = 64 * 1024;
const ENTRY_LIMIT = 500;
const systemEntries = new Set(['.ds_store', '.git']);
const hiddenEntry = name => systemEntries.has(name.toLowerCase()) || /^\.xiaoxiao-write-/i.test(name);
const fileNames = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function relativeSegments(relative = '.') {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\0')) throw Error('无效的工作区路径');
  const segments = relative === '.' ? [] : relative.split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || hiddenEntry(part) || (process.platform === 'win32' && /[\\:]/.test(part)))) {
    throw Error('无效的工作区路径');
  }
  return segments;
}

async function resolveEntry(root, relative) {
  const segments = relativeSegments(relative);
  if (await fs.realpath(root) !== root) throw Error('工作目录已移动，请重新选择');
  const target = path.join(root, ...segments);
  const canonical = await fs.realpath(target);
  const offset = path.relative(root, canonical);
  // A different relative path means a symlink, casing alias, or a path outside the chosen root.
  if (offset !== segments.join(path.sep)) throw Error('此工作区视图无法打开链接');
  return target;
}

async function listWorkspace(root, relative) {
  const target = await resolveEntry(root, relative);
  const dir = await fs.opendir(target);
  const entries = [];
  let truncated = false;
  for await (const entry of dir) {
    if (hiddenEntry(entry.name)) continue;
    if (entries.length >= ENTRY_LIMIT) { truncated = true; break; }
    const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
    entries.push({ name: entry.name, kind });
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || fileNames.compare(a.name, b.name));
  return { entries, truncated };
}

async function readSnapshot(file, limit, signal) {
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

function decodeText(buffer, truncated = false) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer, { stream: truncated });
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

async function previewWorkspace(root, relative, signal) {
  const target = await resolveEntry(root, relative);
  const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile()) throw Error('请选择普通文件');
    const data = await readSnapshot(file, PREVIEW_LIMIT, signal);
    const latest = await file.stat({ bigint: true });
    if (latest.mtimeNs !== stat.mtimeNs || latest.ctimeNs !== stat.ctimeNs || latest.size !== stat.size) {
      throw Error('文件正在更新，请刷新预览');
    }
    const truncated = data.length > PREVIEW_LIMIT;
    const text = decodeText(data.subarray(0, PREVIEW_LIMIT), truncated);
    const revision = !truncated && text !== null ? createHash('sha256').update(data).digest('hex') : null;
    return { text, truncated, revision, bytes: Number(stat.size), readOnly: stat.nlink > 1n };
  } finally {
    await file.close();
  }
}

module.exports = { listWorkspace, previewWorkspace, readSnapshot, decodeText, relativeSegments, resolveEntry, PREVIEW_LIMIT };
