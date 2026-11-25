'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { snapshot, change, branchAt } = require('../src/proof-versions');

const id = 'launch';
function edit(book, target, text, position = 0) {
  return change(book, { brief:id, base:snapshot(book,id).id, target, text, operation:'edit' }, position);
}
function apply(book, operation, target, position = 0) {
  return change(book, { brief:id, base:snapshot(book,id).id, operation, target }, position);
}
test('title and body are independent from artwork and referenced voice text', () => {
  const initial = snapshot(null,id);
  const image = fs.readFileSync(require.resolve('../src/' + initial.asset.id));
  assert.equal(initial.asset.sha256,createHash('sha256').update(image).digest('hex'));
  const title = edit({}, 'title', '周五来看看', 1);
  const body = edit(title, 'body', '在工作室集合', 2);
  const updated = snapshot(body,id);
  assert.equal(updated.current.voice,initial.current.voice);
  assert.equal(updated.current.title,'周五来看看');
  assert.deepEqual(updated.asset,initial.asset);
  const sync = apply(body,'sync','voice',2);
  const synced = snapshot(sync,id);
  assert.equal(synced.source.revision,updated.id);
  assert.equal(synced.current.voice,updated.current.title);
  assert.deepEqual(snapshot(apply(sync,'undo'),id).current,updated.current);
  assert.deepEqual(snapshot(apply(apply(sync,'undo'),'undo'),id).current,snapshot(title,id).current);
});
test('branch cutoff, stale writes, reload and independent edits preserve version ancestry', () => {
  const a = edit({},'voice','录音句',1);
  const b = edit(a,'body','次日修改',3);
  const fork = branchAt(JSON.parse(JSON.stringify(b)),2);
  assert.equal(snapshot(fork,id).id, snapshot(a,id).id);
  const c = edit(fork,'voice','分支录音',2);
  assert.equal(snapshot(b,id).current.voice,'录音句');
  assert.equal(snapshot(c,id).parent,snapshot(a,id).id);
  assert.equal(snapshot(c,id).source,null);
  assert.throws(()=>change(b,{brief:id,base:snapshot(a,id).id,target:'title',operation:'edit',text:'迟到提案'},3), /版本/);
  const undone = apply(b,'undo');
  assert.notEqual(snapshot(undone,id).id, snapshot(a,id).id);
  assert.equal(snapshot(undone,'invite').number,0);
});
