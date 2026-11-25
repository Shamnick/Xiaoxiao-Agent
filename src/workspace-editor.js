'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { previewWorkspace, PREVIEW_LIMIT, relativeSegments, resolveEntry } = require('./workspace-files');
const { inspect, applyReviewedWrite } = require('./workspace-review');

const hash = content => createHash('sha256').update(content).digest('hex');
const changed = () => Object.assign(Error('磁盘上的文件已变化。请先保留编辑内容，再重新加载文件。'), { code: 'WORKSPACE_CHANGED' });

async function createWorkspaceFile(root, relative, checkScope) {
  if (typeof relative !== 'string' || relative.length > 1024 || /[\\\x00-\x1f\x7f]/.test(relative)) throw Error('请输入有效的项目相对路径');
  const segments = relativeSegments(relative);
  if (!segments.length) throw Error('请输入文件名');
  const name = segments.pop();
  let parent;
  try { parent = await resolveEntry(root, segments.join('/') || '.'); }
  catch (error) {
    if (error.code === 'ENOENT') throw Error('请先创建文件所在的目录');
    throw error;
  }
  if (!(await fs.stat(parent)).isDirectory()) throw Error('请先选择一个目录');
  checkScope?.();
  const target = path.join(parent, name);
  try { await applyReviewedWrite({ target, content: '', before: null, async verifyParent() {
    if (await fs.realpath(root) !== root || await fs.realpath(parent) !== parent) throw changed();
    checkScope?.();
  } }); }
  catch (error) {
    if (error.code === 'WORKSPACE_CHANGED') throw Error('目标文件已存在或目录已发生变化，请换一个文件名');
    throw error;
  }
  return { path: relative };
}

async function saveWorkspaceFile(root, relative, revision, content, checkScope) {
  if (!/^[a-f0-9]{64}$/.test(revision || '') || typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > PREVIEW_LIMIT) {
    throw Error('只支持保存不超过 64 KiB 的 UTF-8 文本');
  }
  const target = await resolveEntry(root, relative);
  const parent = path.dirname(target);
  const before = await inspect(target);
  if (!before || hash(before.buffer) !== revision) throw changed();
  if (before.text !== content) {
    await applyReviewedWrite({ target, content, before, async verifyParent() {
      checkScope?.();
      if (await fs.realpath(root) !== root || await fs.realpath(parent) !== parent) throw changed();
      checkScope?.();
    }});
  } else checkScope?.();
  return { text: content, bytes: Buffer.byteLength(content), revision: hash(content), truncated: false, readOnly: false };
}

async function workspaceAttachment(root, relative, revision, range) {
  const preview = await previewWorkspace(root, relative);
  if (!preview.revision) throw Error('只有不超过 64 KiB 的 UTF-8 文件可以加入消息');
  if (preview.revision !== revision) throw Error('文件已更新，请刷新编辑器后再加入消息');
  if (!range) return { name: relative, text: preview.text, bytes: preview.bytes };
  const { from, to } = range;
  const normalized = preview.text.replace(/\r\n|\r/g, '\n');
  if (![from, to].every(Number.isSafeInteger) || from < 0 || from >= to || to > normalized.length) throw Error('选择的代码范围无效');
  const start = normalized.slice(0, from).split('\n').length;
  const end = normalized.slice(0, to - 1).split('\n').length;
  const text = normalized.slice(from, to);
  return { name: `${relative}:${start}${end === start ? '' : `–${end}`}`, text, bytes: Buffer.byteLength(text) };
}

function replaceUnique(original, edits) {
  if (typeof original !== 'string') throw Error('Expected an existing UTF-8 file');
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 8) throw Error('Provide one to eight replacements');
  const ranges = edits.map(({ old_text, new_text }) => {
    if (typeof old_text !== 'string' || !old_text.length || typeof new_text !== 'string' ||
        old_text.includes('\0') || new_text.includes('\0') || Buffer.byteLength(old_text) + Buffer.byteLength(new_text) > 24000) {
      throw Error('Invalid replacement');
    }
    const from = original.indexOf(old_text);
    if (from < 0 || original.indexOf(old_text, from + 1) >= 0) throw Error('Expected exactly one match. Re-read the file and include more context.');
    return { from, to: from + old_text.length, text: new_text };
  }).sort((a, b) => a.from - b.from);
  let offset = 0;
  const parts = [];
  for (const { from, to, text } of ranges) {
    if (from < offset) throw Error('Edit ranges overlap');
    parts.push(original.slice(offset, from), text);
    offset = to;
  }
  return parts.join('') + original.slice(offset);
}

module.exports = { createWorkspaceFile, saveWorkspaceFile, workspaceAttachment, replaceUnique };
