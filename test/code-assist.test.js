'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareCodeAssist, parseCodeAssist, suggestCode } = require('../src/code-assist');

const content = 'x'.repeat(6000) + 'const n = 1;' + 'y'.repeat(6000);
const edit = { mode: 'edit', path: 'src/main.js', content, from: 6000, to: 6012, instruction: 'Change n to two' };

test('code assistance sends only a bounded window around the requested selection', () => {
  const { context, request, system } = prepareCodeAssist(edit);
  assert.equal(context.before.length, 4500);
  assert.equal(context.after.length, 4500);
  assert.equal(context.selected, 'const n = 1;');
  assert.equal(request, 'Change n to two');
  assert.match(system, /untrusted data/);
  assert.throws(() => prepareCodeAssist({ ...edit, mode: 'complete' }), /光标/);
  assert.throws(() => prepareCodeAssist({ ...edit, to: -1 }), /无效/);
  assert.throws(() => prepareCodeAssist({ ...edit, instruction: ' ' }), /要求/);
  assert.throws(() => prepareCodeAssist({ ...edit, mode: 'complete', from: 4, to: 4, automatic: true, path: '.env.local' }), /随键入/);
});

test('suggestions preserve replacement whitespace and reject malformed or excessive output', () => {
  const text = '\tconst answer = 42;\r\n';
  assert.equal(parseCodeAssist(`\x60\x60\x60json\n${JSON.stringify({ text })}\n\x60\x60\x60`, 'edit'), '\tconst answer = 42;\n');
  assert.equal(parseCodeAssist('{"text":""}', 'edit'), '');
  assert.throws(() => parseCodeAssist('Unexpected prose', 'complete'), /有效/);
  assert.throws(() => parseCodeAssist('{"text":"\u0000"}', 'edit'), /有效/);
  assert.throws(() => parseCodeAssist(JSON.stringify({ text: 'line\n'.repeat(9) }), 'complete'), /过长/);
});

test('code assistance reuses both model protocols without exposing tools', async () => {
  for (const kind of ['openai-compatible', 'anthropic']) {
    const provider = { kind, key: 'demo-key', baseUrl: 'https://fixture.invalid/v1', model: 'test', stream: false };
    const text = await suggestCode(provider, edit, { request: async (url, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.tools, undefined);
      const user = JSON.parse(payload.messages.at(-1).content);
      assert.deepEqual(Object.keys(user), ['instruction', 'source']);
      assert.equal(user.source.selected, 'const n = 1;');
      const response = JSON.stringify({ text: 'const n = 2;' });
      if (kind === 'anthropic') {
        assert.match(url, /\/messages$/);
        return Response.json({ content: [{ type: 'text', text: response }] });
      }
      assert.match(url, /\/chat\/completions$/);
      return Response.json({ choices: [{ message: { content: response } }] });
    } });
    assert.equal(text, 'const n = 2;');
  }
});
