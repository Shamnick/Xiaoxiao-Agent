'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/providers');
const { beginCheckpoint, recordTool, failRun, resumeContext } = require('../src/run-recovery');
const { AgentContext } = require('../src/agent-context');

const p = { kind: 'openai-compatible', model: 'fixture', baseUrl: 'http://localhost' };
const goal = { role: 'user', content: '创建蓝色的网页' };
const call = (id, name = 'save_artifact') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const tool = execute => ({ name: 'save_artifact', description: 'save', parameters: { type: 'object' }, execute });
const json = (message, finish_reason = 'stop') => Response.json({ choices: [{ message, finish_reason }] });
const sse = events => new Response(events.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });

for (const kind of ['openai-compatible', 'anthropic']) for (const stream of [true, false]) {
  test(kind + (stream ? ' stream' : ' JSON') + ' keeps partial text and never executes a truncated call with valid JSON', async () => {
    const blocks = [{ type: 'text', text: '半成品' }, { type: 'tool_use', id: 'write', name: 'save_artifact', input: {} }];
    const response = kind === 'anthropic'
      ? stream ? sse([
        ...blocks.map((b,index) => ({ type: 'content_block_start', index, content_block: b })),
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }
      ]) : Response.json({ content: blocks, stop_reason: 'max_tokens' })
      : stream ? sse([{ choices: [{ delta: { content: '半成品', tool_calls: [{ index: 0, ...call('write') }] }, finish_reason: 'length' }] }])
        : json({ content: '半成品', tool_calls: [call('write')] }, 'length');
    let writes = 0, output = '';
    await assert.rejects(runAgent({ ...p, kind, stream, key: 'fixture' }, [goal], {
      tools: [tool(() => writes++)], request: async () => response,
      onEvent: e => { if (e.type === 'text') output += e.text; }
    }), /上限/);
    assert.equal(writes, 0);
    assert.equal(output, '半成品');
  });
}

test('mid-batch steering keeps a completed action and skips all unstarted actions', async () => {
  let update = '', writes = 0;
  const requests = [], events = [];
  const result = await runAgent(p, [goal], {
    maxSteps: 1, takeUserUpdate: () => { const text = update; update = ''; return text; },
    tools: [tool(() => { writes++; update = '第二个文件不用保存'; return { saved: true, filename: 'first.html' }; })],
    onEvent: e => events.push(e),
    request: async (_, opts) => {
      requests.push(JSON.parse(opts.body).messages);
      return requests.length === 1 ? json({ tool_calls: [call('one'), call('two')] }, 'tool_calls') : json({ content: '只保存了第一个文件' });
    }
  });
  assert.equal(result, '只保存了第一个文件');
  assert.equal(writes, 1);
  const [, , first, second, steering] = requests[1];
  assert.equal(first.tool_call_id, 'one');
  assert.equal(JSON.parse(first.content).saved, true);
  assert.equal(second.tool_call_id, 'two');
  assert.match(second.content, /Skipped/);
  assert.equal(steering.content, '第二个文件不用保存');
  assert(events.some(e => e.phase === 'skip'));
});

test('a real HTTP context refusal gets one smaller request without re-executing the tool', async () => {
  const requests = [];
  let executions = 0;
  await runAgent(p, [goal], {
    tools: [tool(() => { executions++; return 'HEAD' + '文'.repeat(50000) + 'TAIL'; })],
    request: async (_, opts) => {
      requests.push(JSON.parse(opts.body).messages);
      if (requests.length === 1) return json({ reasoning_content: 'opaque', tool_calls: [call('read')] }, 'tool_calls');
      if (requests.length === 2) return Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 });
      return json({ content: 'ok' });
    }
  });
  assert.equal(executions, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests[2][0].content, goal.content);
  assert.equal(requests[2][1].reasoning_content, 'opaque');
  assert.equal(requests[2][2].tool_call_id, 'read');
  assert.match(requests[2][2].content, /^HEAD[\s\S]*省略[\s\S]*TAIL$/);
  assert(requests[2][2].content.length < requests[1][2].content.length / 2);
});

test('oversized pinned input is never removed and unchanged overflow is not retried', async () => {
  let attempts = 0;
  await assert.rejects(runAgent(p, [goal], { request: async () => {
    attempts++; return Response.json({ error: { message: 'prompt is too long' } }, { status: 400 });
  } }), /上下文容量不足/);
  assert.equal(attempts, 1);
});

test('long active task keeps its goal, steering, balanced batches and successful file receipts', () => {
  const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x'.repeat(64000) } }] };
  const ctx = new AgentContext([image, { role: 'assistant', content: '旧图' }, goal], 10);
  ctx.add('exchange', [
    { role: 'assistant', content: [{ type: 'tool_use', name: 'save_artifact', input: { html: 'x'.repeat(20000) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'saved', content: 'saved' }] }
  ], [{ name: 'save_artifact', outcome: 'returned', filename: '成品.html' }]);
  ctx.add('input', [{ role: 'user', content: '新要求' }]);
  ctx.add('exchange', [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'HEAD' + '字'.repeat(30000) + 'TAIL' }] }
  ], [{ name: 'read_file', outcome: 'returned' }]);
  const projected = ctx.prepare(6000);
  assert(projected.size <= 6000);
  assert.equal(projected.messages[0].content, goal.content);
  assert.match(projected.messages[1].content, /成品.html/);
  assert.equal(projected.messages[2].content, '新要求');
  assert.equal(projected.messages[3].content[0].id, projected.messages[4].content[0].tool_use_id);
  assert.match(projected.messages[4].content[0].content, /^HEAD[\s\S]*TAIL$/);
  assert.equal(image.content[0].image_url.url.length, 64000);
});

test('repeated resume keeps original request, reviewed operation, old and new steering and delivered file', () => {
  const run = beginCheckpoint(0);
  run.partial = '已经保存';
  run.updates.push({ text: '蓝色', sent: false });
  run.artifacts = [{ name: '成品.html', path: '/private/成品.html' }];
  recordTool(run, { name: 'save_artifact', phase: 'start' });
  recordTool(run, { name: 'save_artifact', phase: 'end' });
  let chat = failRun({ messages: [goal], pendingRun: run }, '断线');
  chat.pendingRun = beginCheckpoint(2, resumeContext(chat));
  chat.messages.push({ role: 'user', content: '继续' });
  chat.pendingRun.updates.push({ text: '保留文件', sent: true });
  recordTool(chat.pendingRun, { name: 'write_file', phase: 'start' });
  chat = failRun(chat, '第二次断线');
  const { text } = resumeContext(chat);
  const context = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.equal(context.originalRequest, goal.content);
  assert.equal(context.partialAnswer, '已经保存');
  assert.deepEqual(context.savedFiles, ['成品.html']);
  assert(!text.includes('/private/'));
  assert.deepEqual(context.additionalUserInstructions, ['蓝色', '保留文件']);
  assert.deepEqual(context.recentToolCalls.map(x => x.finished), [true, false]);
  assert.deepEqual(chat.messages.at(-1).artifacts, run.artifacts);
});

test('steering a completed text turn preserves its provider reasoning during the active tool session', async () => {
  let waiting = '';
  const requests = [];
  await runAgent(p, [goal], {
    tools: [tool(() => assert.fail('no tool requested'))],
    takeUserUpdate: () => { const text = waiting; waiting = ''; return text; },
    request: async (_, opts) => {
      requests.push(JSON.parse(opts.body).messages);
      if (requests.length === 1) {
        waiting = '补充一条';
        return json({ content: '好的', reasoning_content: 'provider-state' });
      }
      return json({ content: '收到' });
    }
  });
  assert.equal(requests[1][1].reasoning_content, 'provider-state');
  assert.equal(requests[1][2].content, '补充一条');
});
