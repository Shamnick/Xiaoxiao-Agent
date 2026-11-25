'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/providers');
const { emptyMetrics, applyMetric, normalizeUsage } = require('../src/conversation-metrics');
const p = { kind: 'openai-compatible', model: 'fixture', baseUrl: 'http://localhost' };
const input = [{ role: 'user', content: 'fixture' }];
const stream = events => new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
  headers: { 'content-type': 'text/event-stream' }
});
function meter() {
  const state = emptyMetrics(), previews = [];
  return { state, previews, onMetric(event) {
    if (event.kind === 'preview') previews.push(event.usage);
    else applyMetric(state, event);
  } };
}
test('usage-only trailing packets and repeated samples count once, including zero cache reads', async () => {
  const m = meter();
  const usage = { prompt_tokens: 500, completion_tokens: 21, total_tokens: 521, prompt_tokens_details: { cached_tokens: 0 } };
  await runAgent(p, input, { ...m, request: async (_, init) => {
    assert.equal(JSON.parse(init.body).stream_options.include_usage, true);
    return stream([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, { choices: [], usage }, { choices: [], usage }]);
  } });
  assert.deepEqual([m.state.steps, m.state.tokens, m.state.cacheRead, m.state.cacheInput, m.state.fullReports], [1,521,0,500,1]);
  assert(m.state.rate > 0 && m.state.size > 0);
});
test('split Anthropic usage includes cache writes and reads, replaces cumulative output', async () => {
  const m = meter();
  await runAgent({ ...p, kind: 'anthropic', key: 'fixture' }, input, { ...m, request: async () => stream([
    { type: 'message_start', message: { usage: { input_tokens: 9, cache_creation_input_tokens: 11, cache_read_input_tokens: 80, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    { type: 'message_stop' }]) });
  assert.deepEqual([m.state.tokens, m.state.cacheRead, m.state.cacheInput, m.state.steps], [106,80,100,1]);
  assert.equal(m.previews[0].total,101);
  assert.deepEqual([m.state.input,m.state.output,m.state.inputReports,m.state.outputReports],[100,6,1,1]);
});
test('JSON usage, unknown values and explicit stream-option rejection preserve chat', async () => {
  let attempts = 0;
  const m = meter();
  await runAgent(p, input, { ...m, request: async (_, init) => {
    if (++attempts === 1) return new Response('unknown parameter stream_options', { status: 400 });
    assert.equal(JSON.parse(init.body).stream_options, undefined);
    return Response.json({ usage:{ prompt_tokens:0, completion_tokens:0 }, choices:[{message:{content:'ok'}}] });
  } });
  assert.equal(m.state.steps,1);
  assert.equal(m.state.requests,2);
  assert.equal(m.state.fullReports,1);
  assert.equal(m.state.reports,1);
  assert.equal(m.state.rate,0);
  assert.equal(m.state.cacheReports,0);
  assert.deepEqual(normalizeUsage('openai-compatible',{}),{total:null,input:null,output:null,cached:null});
});
test('interrupted streams retain only the reported partial usage', async () => {
  const m = meter();
  await assert.rejects(runAgent(p, input, { ...m, request: async () => stream([
    { choices:[{delta:{content:'x'}}], usage:{total_tokens:7} }]) }), /中途断开/);
  assert.deepEqual([m.state.steps, m.state.tokens, m.state.fullReports, m.state.rate], [1,7,0,null]);
});
test('start-only usage is partial even after a stop, and local timings survive missing usage', async () => {
  const m = meter();
  await runAgent({ ...p, kind:'anthropic', key:'fixture' }, input, { ...m, request: async () => stream([
    { type:'message_start', message:{ usage:{ input_tokens:20, output_tokens:1 } } },
    { type:'content_block_start', index:0, content_block:{type:'text',text:'ok'} },
    { type:'message_stop' }]) });
  assert.equal(m.state.fullReports,0);
  assert.equal(m.state.rate,null);
  assert(m.state.firstBodyMs >= 0 && m.state.elapsedMs >= m.state.firstBodyMs);
  const empty = meter();
  await runAgent(p,input,{...empty,request:async()=>Response.json({choices:[{message:{content:'ok'}}]})});
  assert.equal(empty.state.reports,0);
  assert.equal(empty.state.requests,1);
  assert(empty.state.firstBodyMs !== null && empty.state.elapsedMs >= empty.state.firstBodyMs);
});

test('worker accounting adds reported totals without replacing the main context or speed', () => {
  const m = emptyMetrics();
  const usage = {kind:'usage',usage:{total:9,input:7,cached:1,output:2},complete:true,elapsedMs:1000};
  applyMetric(m,{kind:'step',size:300,budget:2000});
  applyMetric(m,usage);
  applyMetric(m,{kind:'step',size:45,budget:1500},true);
  applyMetric(m,{...usage,elapsedMs:4000},true);
  assert.deepEqual([m.steps,m.tokens,m.cacheInput,m.rate,m.size,m.budget],[2,18,14,2,300,2000]);
});
