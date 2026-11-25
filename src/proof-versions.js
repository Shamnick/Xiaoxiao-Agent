'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const briefs = {
  launch: { edition: '新品发布', original: '让灵感成形。', body: '为正在成形的创意，留一个可以反复修改的地方。', casual: '有个想法？一起试试。', short: '让想法成形。', art: 'silk-knot.png', alt: '层叠的彩色丝结' },
  invite: { edition: '体验邀请', original: '开启你的创作之旅。', body: '带上一份草稿，来工作室一起试做。', casual: '来做点自己的东西吧。', short: '一起开工。', art: 'proof-workspace.png', alt: 'Xiaoxiao 桌面工作区示例截图' }
};
const assets = new Map();

function seed(id) {
  if (!Object.hasOwn(briefs, id)) throw Error('简报不存在');
  const brief = briefs[id];
  if (!assets.has(id)) {
    const bytes = fs.readFileSync(path.join(__dirname, brief.art));
    assets.set(id, createHash('sha256').update(bytes).digest('hex'));
  }
  const root = id + ':original';
  return { id: root, number: 0, current: { title: brief.original, body: brief.body, voice: brief.original },
    source: { component: id + ':title', revision: root }, asset: { id: brief.art, sha256: assets.get(id) }, undoTo: null };
}

function snapshot(book, id) {
  const original = seed(id);
  const latest = book?.[id]?.at(-1) || original;
  return { ...latest, brief: briefs[id] };
}

// Keep an append-only chain. Undo creates a new revision so a delayed proposal
// cannot become valid again merely because the user returned to the same wording.
function change(book, input, messageCount) {
  const id = input.brief;
  const previous = snapshot(book, id);
  if (previous.id !== input.base) throw Error('作品版本已更新，请重新预览修改');
  const rows = book?.[id] || [];
  if (rows.length >= 500) throw Error('这份简报已达 500 个版本，可在新项目中继续创作');
  let current, source, undoTo;
  if (input.operation === 'undo') {
    if (!previous.undoTo) throw Error('没有可撤销的修改');
    const restored = rows.find(row => row.id === previous.undoTo) || seed(id);
    ({ current, source, undoTo } = restored);
  } else {
    const target = input.target;
    if (!['edit','sync'].includes(input.operation) || !['title','body','voice'].includes(target)) throw Error('修改对象无效');
    const sync = input.operation === 'sync';
    if (sync && target !== 'voice') throw Error('请选择要同步的旁白句');
    const text = sync ? previous.current.title : input.text?.trim();
    if (typeof text !== 'string' || !text || text.length > 1000) throw Error('请输入 1 至 1000 字的文案');
    if (text === previous.current[target]) throw Error('文案与当前版本相同');
    current = { ...previous.current, [target]: text };
    source = target !== 'voice' ? previous.source : sync ? { component: id + ':title', revision: previous.id } : null;
    undoTo = previous.id;
  }
  const revision = { id: randomUUID(), number: previous.number + 1, parent: previous.id, asset: previous.asset,
    current, source, undoTo, messageCount };
  return { ...book, [id]: [...rows, revision] };
}

function branchAt(book, position) {
  if (!book) return undefined;
  return Object.fromEntries(Object.entries(book).map(([id, rows]) => [id, rows.filter(row => row.messageCount <= position)]));
}

module.exports = { snapshot, change, branchAt };
