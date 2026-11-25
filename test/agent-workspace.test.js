'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { workspaceGuidance, withGuidance } = require('../src/workspace-guidance');
const { verifyWrittenText } = require('../src/write-verification');
const { runAgent } = require('../src/providers');
const { recordTool } = require('../src/run-recovery');

async function temp(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xx-guidance-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('workspace guidance is bounded, reread per turn and confined to selected regular files', async t => {
  const base = await temp(t);
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  const outside = path.join(base, 'CLAUDE.md');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, path.join(root, 'CLAUDE.md'));
  await fs.link(outside, path.join(root, 'AGENTS.md'));
  assert.deepEqual(await workspaceGuidance(root), []);
  await fs.unlink(path.join(root, 'AGENTS.md'));
  const file = path.join(root, 'AGENTS.md');
  await fs.writeFile(file, '简'.repeat(5000));
  const data = await workspaceGuidance(root);
  assert.equal(data.length, 1);
  assert.equal(data[0].truncated, true);
  assert(Buffer.byteLength(data[0].text) <= 8192);
  assert(!data[0].text.includes('\uFFFD'));
  const image = { type: 'image', source: {} };
  const raw = { role:'user', content: [image] };
  const enriched = withGuidance(raw, data);
  assert.equal(enriched.role, 'user');
  assert.equal(enriched.content.at(-1), image);
  assert.equal(raw.content.length, 1);
  await fs.writeFile(file, '新的约定');
  assert.equal((await workspaceGuidance(root))[0].text, '新的约定');
  assert.strictEqual(withGuidance(raw, []), raw);
});

test('write receipts distinguish matching bytes, same-size external edits, missing files and replaced links', async t => {
  const root = await temp(t);
  const file = path.join(root, '交付.html');
  await fs.writeFile(file, '一');
  assert.equal(await verifyWrittenText(file, '一'), 'matched');
  assert.equal(await verifyWrittenText(file, '二'), 'unconfirmed');
  await fs.unlink(file);
  assert.equal(await verifyWrittenText(file, '一'), 'unconfirmed');
  await fs.writeFile(path.join(root, 'target'), '一');
  await fs.symlink('target', file);
  assert.equal(await verifyWrittenText(file, '一'), 'unconfirmed');
});

for (const kind of ['anthropic', 'openai-compatible']) {
  test(kind + ' caps simultaneous reads, preserves batch order and waits before exclusive tools', async () => {
    const tasks = [['read_file',1], ['read_file',2], ['read_file',3], ['read_file',4], ['save_artifact',5], ['read_file',6]];
    const activity = [], journal = { tools:[] }, gates = new Map();
    let inFlight = 0, high = 0, round = 0;
    const send = async (_, options) => {
      const body = JSON.parse(options.body);
      if (round++ === 0) {
        return kind === 'anthropic'
          ? Response.json({ content: tasks.map(([name,n]) => ({ type:'tool_use', id:String(n), name, input:{n} })), stop_reason:'tool_use' })
          : Response.json({ choices:[{ message:{tool_calls:tasks.map(([name,n]) => ({id:String(n),function:{name,arguments:JSON.stringify({n})}}))},finish_reason:'tool_calls' }] });
      }
      const output = kind === 'anthropic' ? body.messages.at(-1).content.map(entry => entry.content) : body.messages.filter(entry => entry.role === 'tool').map(entry => entry.content);
      assert.deepEqual(output, ['1','2','3','4','{"saved":true}','6']);
      return kind === 'anthropic' ? Response.json({ content:[{type:'text',text:'完成'}], stop_reason:'end_turn' })
        : Response.json({choices:[{message:{content:'完成'},finish_reason:'stop'}]});
    };
    const schema = { type:'object', properties:{n:{type:'integer'}}, required:['n'] };
    const tools = [
      { name:'read_file', parallelRead:true, parameters:schema, async execute({n}) {
        high = Math.max(high, ++inFlight);
        activity.push('start'+n);
        if (n <= 3) {
          gates.set(n, Promise.withResolvers());
          // All three must start before any can complete. Settle them out of order.
          if (n === 3) queueMicrotask(() => [3,1,2].forEach(id => gates.get(id).resolve()));
          await gates.get(n).promise;
        }
        activity.push('end'+n); inFlight--; return String(n);
      }},
      { name:'save_artifact', parameters:schema, execute() {
        assert.equal(inFlight, 0); activity.push('write'); return {saved:true};
      }}
    ];
    const answer = await runAgent({kind, model:'fixture', key:'fixture', baseUrl:'http://fixture'}, [{role:'user',content:'检查'}], {
      tools, request:send, onEvent:e => { if (e.type === 'tool') recordTool(journal,e); }
    });
    assert.equal(answer, '完成');
    assert.equal(high, 3);
    assert(activity.indexOf('write') > activity.indexOf('end4'));
    assert(activity.indexOf('start6') > activity.indexOf('write'));
    assert.equal(journal.tools.length, 6);
    assert(journal.tools.every(entry => entry.finished));
    assert.equal(new Set(journal.tools.map(entry => entry.eventId)).size, 6);
  });
}

test('a nonzero command completion is a failed check in the model result and journal', async () => {
  const journal = {tools:[]};
  let round = 0;
  await runAgent({kind:'anthropic', model:'fixture', key:'fixture', baseUrl:'http://fixture'}, [{role:'user',content:'核对'}], {
    tools:[{name:'run_command',parameters:{type:'object'},execute:() => ({code:2, signal:null, stderr:'bad assertion'})}],
    onEvent:e => { if (e.type === 'tool') recordTool(journal,e); },
    request: async (_,opts) => {
      if (!round++) return Response.json({content:[{type:'tool_use',name:'run_command',id:'run',input:{}}],stop_reason:'tool_use'});
      const result = JSON.parse(opts.body).messages.at(-1).content[0];
      assert.equal(result.is_error, true);
      assert.equal(JSON.parse(result.content).code, 2);
      return Response.json({content:[{type:'text',text:'检查失败'}],stop_reason:'end_turn'});
    }
  });
  assert.equal(journal.tools[0].outcome, 'command_failed');
});
