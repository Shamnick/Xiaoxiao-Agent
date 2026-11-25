'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { previewWorkspace } = require('./workspace-files');
const { gitCandidates } = require('./workspace-git');

const ignoredFolders = new Set(['.git', 'node_modules', '.next', '.venv', '.cache', '__pycache__', 'coverage', 'dist', 'build', 'vendor']);
const privateName = /^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|\.netrc$|id_(?:rsa|ed25519|ecdsa)$)|\.(?:pem|key|p12|pfx)$/i;
const maxResults = 60;
const nameKey = value => value.normalize('NFC').toLowerCase();

function excluded(name) {
  return name.split('/').some(segment => ignoredFolders.has(segment.toLowerCase()) || privateName.test(segment) || /^\.xiaoxiao-write-/i.test(segment));
}

async function* walk(root, budget, signal) {
  const pending = [''];
  while (pending.length && !budget.expired()) {
    signal?.throwIfAborted();
    const directory = pending.pop();
    let entries;
    try { entries = await fs.opendir(path.join(root, directory)); }
    catch (error) { if (!directory) throw error; continue; }
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (budget.expired()) break;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (excluded(relative)) continue;
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) yield relative;
    }
  }
}

async function searchWorkspace(root, { query, kind = 'content', signal } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\0\r\n]/.test(query)) throw Error('请输入 1–200 个字符的搜索词');
  if (!['files', 'content'].includes(kind)) throw Error('无效的工作区搜索类型');
  const needle = nameKey(query.trim());
  let candidates;
  try { candidates = await gitCandidates(root, { signal }); }
  catch { signal?.throwIfAborted(); throw Error('无法读取 Git 文件列表'); }
  if (!candidates && await fs.realpath(root) !== root) throw Error('工作目录已移动，请重新选择');
  if (candidates?.tooLarge) return { matches: [], scanned: 0, limited: true };
  const matches = [];
  let scanned = 0;
  let limited = false;
  const deadline = Date.now() + 2300;
  const budget = { expired: () => {
    limited ||= Date.now() > deadline || scanned >= (kind === 'files' ? 16000 : 4000) || (kind === 'content' && matches.length >= maxResults);
    return limited;
  }};
  for await (const relative of candidates || walk(root, budget, signal)) {
    signal?.throwIfAborted();
    if (budget.expired()) break;
    if (excluded(relative)) continue;
    scanned++;
    const name = relative.split('/').at(-1);
    if (kind === 'files') {
      const matchesName = nameKey(name).includes(needle);
      if (matchesName || nameKey(relative).includes(needle)) matches.push({ path: relative, rank: Number(!matchesName) });
      continue;
    }
    let preview;
    try { preview = await previewWorkspace(root, relative, signal); }
    catch { signal?.throwIfAborted(); continue; }
    if (preview.truncated || preview.text === null) continue;
    for (const [offset, line] of preview.text.split(/\r\n|\r|\n/).entries()) {
      // Match on the original UTF-16 offsets so the excerpt follows the matching text.
      const column = line.toLowerCase().indexOf(query.trim().toLowerCase());
      if (column < 0) continue;
      const start = Math.max(0, column - 38);
      matches.push({ path: relative, line: offset + 1, text: `${start ? '…' : ''}${line.slice(start, start + 175)}${line.length > start + 175 ? '…' : ''}` });
      if (matches.length >= maxResults) { limited = true; break; }
    }
  }
  if (kind === 'files') matches.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return { matches: matches.slice(0, maxResults).map(({ rank, ...match }) => match), scanned, limited: limited || matches.length > maxResults };
}

module.exports = { searchWorkspace };
