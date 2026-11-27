'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { track, title } = require('../src/steering-updates');
const { beginCheckpoint } = require('../src/run-recovery');

test('a response only acknowledges instructions in its own request', async () => {
  const rows = [], pending = Promise.withResolvers();
  const changes = [];
  const run = track(rows, () => {}, () => changes.push(rows.map(u => title(u, true))), () => pending.promise);
  const first = { text: '移到周五', sent: false };
  const second = { text: '删掉预算', sent: false, immediate: true };
  run.enqueue(first);
  assert.equal(run.take(), first.text);
  assert.equal(run.take(), '');
  assert.equal(first.sent, false);
  const request = run.request('local', {});
  assert.equal(first.delivery, 'requested');
  run.enqueue(second);
  pending.resolve(Response.json({}));
  await request;
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(run.take(), second.text);
  assert.deepEqual(changes.at(-1), ['补充要求 · 模型服务已响应', '立即改向 · 已排队，等待下一次请求']);
});

test('connection errors, rejection, and a stale response after cancellation cannot confirm receipt', async () => {
  const pending = Promise.withResolvers();
  const responses = [() => Promise.reject(Error('offline')), () => new Response(null, {status:429}), () => pending.promise, () => Response.json({})];
  const rows = [], run = track(rows, () => {}, () => {}, () => responses.shift()());
  run.enqueue({text:'修改', sent:false});
  run.take();
  await assert.rejects(run.request('local', {}), /offline/);
  await run.request('local', {});
  const abort = new AbortController();
  const request = run.request('local', {signal: abort.signal});
  abort.abort();
  pending.resolve(Response.json({}));
  await request;
  assert.equal(title(rows[0], false), '补充要求 · 未确认服务响应');
  assert.equal(rows[0].sent, false);
  await run.request('local', {});
  assert.equal(rows[0].sent, true);
});

test('resume preserves pending receipts and does not inject the same text twice', async () => {
  const old = [{text:'原补充', sent:false}, {text:'历史项', sent:true}];
  const { updates } = beginCheckpoint(2, {checkpoint:{updates:old}});
  assert.deepEqual(updates, old);
  assert.equal(title(updates[1], false), '补充要求 · 已加入模型请求（旧记录）');
  const run = track(updates, () => {}, () => {}, () => Response.json({}));
  assert.equal(run.take(), '');
  for (let i = 0; i < 8; i++) run.enqueue({text:'新要求 ' + i, sent:false});
  assert.throws(() => run.enqueue({text:'多余的要求'}), /8 条/);
  await run.request('local', {});
  assert(updates.slice(0, 2).every(u => u.delivery === 'accepted'));
  assert(updates.slice(2).every(u => !u.sent));
  assert.equal(old[0].sent, false);
});
