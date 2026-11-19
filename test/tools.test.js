'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTools } = require('../src/tools');
async function setup(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-tools-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'workspace');
  await fs.mkdir(workspace);
  const tools = await createTools({ workspace, ...options });
  return { base, workspace, tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) };
}
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const command = js => quote(process.execPath) + ' -e ' + quote(js);

test('real workspace reads, bounded listings and canonical symlink containment', async t => {
  const { base, workspace, tools } = await setup(t);
  await fs.writeFile(path.join(workspace, 'big.txt'), 'a'.repeat(70000));
  assert.deepEqual(Object.keys(tools).sort(), ['list_files', 'read_file', 'run_command', 'write_file']);
  const read = await tools.read_file.execute({ path: 'big.txt' });
  assert.equal(Buffer.byteLength(read.content), 65536);
  assert.equal(read.truncated, true);
  await fs.writeFile(path.join(base, 'secret'), 'secret');
  await fs.symlink(base, path.join(workspace, 'escape'));
  await fs.symlink(path.join(workspace, 'big.txt'), path.join(workspace, 'inside'));
  assert.equal((await tools.read_file.execute({ path: 'inside' })).truncated, true);
  await assert.rejects(tools.read_file.execute({ path: '../secret' }), /outside workspace/);
  await assert.rejects(tools.read_file.execute({ path: 'escape/secret' }), /outside workspace/);
  await assert.rejects(tools.list_files.execute({ path: 'escape' }), /outside workspace/);
  await assert.rejects(tools.read_file.execute({ path: '.' }), /regular file/);
  await Promise.all(Array.from({ length: 505 }, (_, i) => fs.writeFile(path.join(workspace, 'file' + i), '')));
  const listing = await tools.list_files.execute();
  assert.equal(listing.entries.length, 500);
  assert.equal(listing.truncated, true);
});

test('writes require fresh explicit approval; reject escapes, symlinks and hard links', async t => {
  const approvals = [];
  let allowed = false;
  const { base, workspace, tools } = await setup(t, { approve: async request => { approvals.push(request); return allowed; } });
  await assert.rejects(tools.write_file.execute({ path: 'note', content: 'no' }), /Approval denied/);
  await assert.rejects(fs.stat(path.join(workspace, 'note')), { code: 'ENOENT' });
  allowed = true;
  assert.equal((await tools.write_file.execute({ path: 'note', content: 'long note' })).bytesWritten, 9);
  await tools.write_file.execute({ path: 'note', content: 'x' });
  assert.equal(await fs.readFile(path.join(workspace, 'note'), 'utf8'), 'x');
  assert.equal(approvals.length, 3);
  assert.match(approvals[1].detail, /long note/);
  await fs.symlink(path.join(base, 'missing'), path.join(workspace, 'link'));
  await assert.rejects(tools.write_file.execute({ path: 'link', content: 'bad' }), /symlink/);
  await fs.link(path.join(workspace, 'note'), path.join(workspace, 'hard'));
  await assert.rejects(tools.write_file.execute({ path: 'hard', content: 'bad' }), /hard links/);
  assert.equal(await fs.readFile(path.join(workspace, 'note'), 'utf8'), 'x');
  await assert.rejects(tools.write_file.execute({ path: '../outside', content: 'bad' }), /outside workspace/);
});

test('command approval, cwd, stderr, exit status, timeout and output cap', async t => {
  let allowed = false;
  const approvals = [];
  const { workspace, tools } = await setup(t, { approve: async request => { approvals.push(request); return allowed; } });
  const run = args => tools.run_command.execute(args);
  const marker = path.join(workspace, 'marker');
  await assert.rejects(run({ command: command('require("fs").writeFileSync("marker","bad")') }), /Approval denied/);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  allowed = true;
  const result = await run({ command: command('console.log(process.cwd());console.error("error");process.exitCode=7') });
  assert.equal(result.stdout.trim(), await fs.realpath(workspace));
  assert.equal(result.stderr.trim(), 'error');
  assert.equal(result.code, 7);
  assert.match(approvals[1].detail, /outside workspace/);
  await assert.rejects(run({ command: command('setInterval(()=>{},1000)'), timeout_ms: 50 }), /timed out/);
  await assert.rejects(run({ command: command('process.stdout.write("x".repeat(100000))') }), /exceeds 64 KiB/);
});

test('abort kills the spawned command and prevents later file operations', async t => {
  const controller = new AbortController();
  const { workspace, tools } = await setup(t, { approve: async () => true, signal: controller.signal });
  const pidFile = path.join(workspace, 'pid');
  const pending = tools.run_command.execute({ command: command('require("fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)') });
  // Attach rejection handling immediately, while waiting for the process to start.
  const rejection = assert.rejects(pending, /stop now/);
  let pid;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await fs.readFile(pidFile, 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid);
  controller.abort(new Error('stop now'));
  await rejection;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(tools.list_files.execute(), /stop now/);
});

test('missing approval denies writes and commands; canonical workspace alias and MCP composition', async t => {
  const { base, workspace, tools } = await setup(t);
  await assert.rejects(tools.write_file.execute({ path: 'x', content: 'x' }), /Approval denied/);
  await assert.rejects(tools.run_command.execute({ command: 'true' }), /Approval denied/);
  await fs.symlink(workspace, path.join(base, 'alias'));
  const extra = { name: 'mcp_fixture', description: 'fixture', parameters: {}, execute: async () => 'ok' };
  const combined = await createTools({ workspace: path.join(base, 'alias'), mcp: { tools: async () => [extra] } });
  assert.equal(combined.at(-1), extra);
});

test('empty workspace produces no tools for Agent mode', async () => {
  assert.deepEqual(await createTools({ workspace: '' }), []);
  assert.deepEqual(await createTools({}), []);
});

test('write approval displays full content within native UI preview length', async t => {
  let request;
  const { tools } = await setup(t, { approve: async value => { request = value; return true; } });
  const content = '\n'.repeat(12288);
  await tools.write_file.execute({ path: 'review', content });
  assert.ok(request.detail.length < 14000);
  assert.ok(request.detail.endsWith(content));
  assert.match(request.title, /12288 bytes, full preview/);
  await assert.rejects(tools.write_file.execute({ path: 'review', content: content + 'x' }), /12 KiB/);
});

