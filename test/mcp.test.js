'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { MCPManager } = require('../src/mcp');
const config = { id: 'fixture', name: 'Fixture', transport: 'stdio', command: 'fixture-command', args: ['hello'] };

// Only the SDK boundary is mocked. Approval, naming, pagination and lifecycle are real.
async function mocked(t, overrides = {}) {
  const state = { transports: [], clients: [], calls: [], lists: 0, connects: 0 };
  class Transport {
    constructor(...args) { this.args = args; this.closed = 0; state.transports.push(this); }
    async close() { this.closed++; }
  }
  class Client {
    constructor() { state.clients.push(this); this.closed = 0; }
    async connect(transport, options) { state.connects++; this.transport = transport; state.options = options; if (overrides.connect) return overrides.connect(transport, options); }
    async listTools(params, options) { state.lists++; return overrides.list ? overrides.list(params, options) : { tools: [{ name: 'echo', description: 'Echo fixture', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }; }
    async callTool(params, schema, options) { state.calls.push(params); state.callOptions = options; return overrides.call ? overrides.call(params, options) : { content: [{ type: 'text', text: params.arguments.text || 'ok' }] }; }
    async close() { this.closed++; }
  }
  const original = Module._load;
  Module._load = function(request, ...rest) {
    if (request === '@modelcontextprotocol/sdk/client/index.js') return { Client };
    if (request === '@modelcontextprotocol/sdk/client/stdio.js') return { StdioClientTransport: Transport };
    if (request === '@modelcontextprotocol/sdk/client/streamableHttp.js') return { StreamableHTTPClientTransport: Transport };
    return original.call(this, request, ...rest);
  };
  t.after(() => { Module._load = original; });
  return state;
}

test('connect approval and each call approval; stable names and copied arguments', async t => {
  const state = await mocked(t);
  const approvals = [];
  let allowed = true;
  let originalArgs;
  const manager = new MCPManager({ configs: [config], approve: async request => {
    approvals.push(request);
    if (originalArgs) originalArgs.text = 'changed after approval';
    return allowed;
  } });
  t.after(() => manager.close());
  const [tool] = await manager.tools();
  assert.match(tool.name, /^mcp_[a-f0-9]{48}$/);
  assert.ok(tool.name.length <= 64);
  assert.equal(approvals.length, 1);
  assert.match(approvals[0].detail, /fixture-command/);
  originalArgs = { text: 'approved value' };
  const result = await tool.execute(originalArgs);
  assert.equal(result.content[0].text, 'approved value');
  assert.match(approvals[1].detail, /approved value/);
  assert.equal(state.calls[0].name, 'echo');
  assert.equal(state.callOptions.timeout, 30000);
  assert.ok(state.callOptions.signal instanceof AbortSignal);
  allowed = false;
  await assert.rejects(tool.execute({ text: 'denied' }), /approval denied/);
  assert.equal(state.calls.length, 1);
  const again = await manager.tools();
  assert.equal(again[0].name, tool.name);
  assert.equal(state.connects, 1);
  const other = new MCPManager({ configs: [config], approve: async () => true });
  assert.equal((await other.tools())[0].name, tool.name);
  await other.close();
  await manager.close(); await manager.close();
  assert.equal(state.transports[0].closed, 1);
  await assert.rejects(tool.execute({}), /closed/);
});

test('denied or missing connection approval never constructs a transport', async t => {
  const state = await mocked(t);
  for (const approve of [undefined, async () => false, async () => 'true']) {
    const manager = new MCPManager({ configs: [config], approve });
    await assert.rejects(manager.tools(), /approval denied/);
    await manager.close();
  }
  assert.equal(state.transports.length, 0);
});

test('HTTP configuration uses the SDK transport and blocks redirects', async t => {
  const state = await mocked(t);
  const manager = new MCPManager({ configs: [{ id: 'http', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer fixture' } }], approve: async () => true });
  t.after(() => manager.close());
  await manager.tools();
  const [url, options] = state.transports[0].args;
  assert.equal(url.href, 'https://example.com/mcp');
  assert.equal(options.requestInit.redirect, 'error');
  assert.equal(options.requestInit.headers.Authorization, 'Bearer fixture');
});

test('discovery supports pagination and cleans up on invalid repeated cursors', async t => {
  const state = await mocked(t, { list: async params => ({ tools: [], nextCursor: params.cursor || 'repeat' }) });
  const manager = new MCPManager({ configs: [config], approve: async () => true });
  await assert.rejects(manager.tools(), /pagination cursor/);
  assert.equal(state.lists, 2);
  assert.equal(state.transports[0].closed, 1);
  await manager.close();
});

test('oversized tool lists fail closed with cleanup', async t => {
  const state = await mocked(t, { list: async () => ({ tools: Array.from({ length: 129 }, (_, i) => ({ name: 'tool' + i, inputSchema: { type: 'object' } })) }) });
  const manager = new MCPManager({ configs: [config], approve: async () => true });
  await assert.rejects(manager.tools(), /exceeds 128/);
  assert.equal(state.transports[0].closed, 1);
  await manager.close();
});

test('abort cancels a pending SDK call and closes transport', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const state = await mocked(t, { call: async (_params, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    started();
  }) });
  const controller = new AbortController();
  const manager = new MCPManager({ configs: [config], approve: async () => true, signal: controller.signal });
  const [tool] = await manager.tools();
  const pending = assert.rejects(tool.execute({}), /closed|aborted/);
  await ready;
  controller.abort();
  await pending;
  await manager.close();
  assert.equal(state.transports[0].closed, 1);
  assert.ok(state.callOptions.signal.aborted);
});

test('aborting during approval prevents any later connection', async t => {
  const state = await mocked(t);
  let release;
  const controller = new AbortController();
  const manager = new MCPManager({ configs: [config], signal: controller.signal, approve: () => new Promise(resolve => { release = resolve; }) });
  const pending = assert.rejects(manager.tools(), /closed/);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await pending;
  release(true);
  await manager.close();
  assert.equal(state.transports.length, 0);
});

test('disabled servers need no approval and invalid config is rejected', async () => {
  const manager = new MCPManager({ configs: [{ enabled: false }] });
  assert.deepEqual(await manager.tools(), []);
  await manager.close();
  assert.throws(() => new MCPManager({ configs: [config, config] }), /unique/);
  assert.throws(() => new MCPManager({ configs: [{ id: 'bad', transport: 'http', url: 'file:///etc/passwd' }] }), /HTTP/);
});

test('deadline cancels an unresponsive tool and disposes its connection', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const state = await mocked(t, { call: async () => { started(); return new Promise(() => {}); } });
  const manager = new MCPManager({ configs: [config], approve: async () => true });
  const [tool] = await manager.tools();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = assert.rejects(tool.execute({}), /timed out/);
  await ready;
  t.mock.timers.tick(30001);
  await pending;
  assert.equal(state.transports[0].closed, 1);
  assert.ok(state.callOptions.signal.aborted);
  await manager.close();
});

test('real SDK stdio handshake, call and child cleanup', async t => {
  try { require.resolve('@modelcontextprotocol/sdk/client/index.js'); }
  catch { t.skip('SDK not installed'); return; }
  const script = `
    const rl = require('node:readline').createInterface({input:process.stdin});
    rl.on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      let result;
      if (request.method === 'initialize') result = {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
      else if(request.method === 'tools/list') result = {tools:[{name:'echo',inputSchema:{type:'object'}}]};
      else if(request.method === 'tools/call') result = {content:[{type:'text',text:JSON.stringify({pid:process.pid,args:request.params.arguments})}]};
      else result = {};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
    });
    rl.on('close',()=>process.exit(0));
  `;
  const approvals = [];
  const manager = new MCPManager({ configs: [{ id: 'real', transport: 'stdio', command: process.execPath, args: ['-e', script] }], approve: async request => { approvals.push(request); return true; } });
  t.after(() => manager.close());
  const [tool] = await manager.tools();
  const result = await tool.execute({ text: 'real handshake' });
  const { pid, args } = JSON.parse(result.content[0].text);
  assert.equal(args.text, 'real handshake');
  assert.equal(approvals.length, 2);
  await manager.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('connection prompts redact credentials but transport receives original values', async t => {
  const state = await mocked(t);
  const prompts = [];
  const manager = new MCPManager({ configs: [
    { ...config, env: { SECRET: 'private-env-value' } },
    { id: 'http', transport: 'http', url: 'https://example.com/mcp?key=private-query-value', headers: { Authorization: 'private-header-value' } }
  ], approve: async prompt => { prompts.push(prompt); return true; } });
  t.after(() => manager.close());
  await manager.tools();
  assert.doesNotMatch(JSON.stringify(prompts), /private-env-value|private-query-value|private-header-value/);
  assert.match(prompts[0].detail, /REDACTED/);
  assert.equal(state.transports[0].args[0].env.SECRET, 'private-env-value');
  assert.equal(state.transports[1].args[1].requestInit.headers.Authorization, 'private-header-value');
});
