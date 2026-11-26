'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { read, save, lastBrief, rememberBrief, forgetConversation } = require('../src/proof-instructions');

function memoryStore() {
  const items = new Map();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key)
  };
}

test('brief and scope delimit unpublished instructions including branches and chat deletion', () => {
  const storage = memoryStore();
  const owners = [{}, { projectId: 'same' }, { conversationId: 'same' }, { conversationId: 'fork' }];
  const empty = { selected: null, fields: {} };
  for (const [i, owner] of owners.entries()) {
    for (const brief of ['invite', 'launch']) {
      const saved = { selected: 'body', fields: { body: i + brief } };
      assert.deepEqual(read(storage, owner, brief), empty);
      save(storage, owner, brief, saved);
      assert.deepEqual(read(storage, owner, brief), saved);
    }
  }
  forgetConversation(storage, 'same');
  for (const [i, owner] of owners.entries()) {
    for (const brief of ['invite', 'launch']) {
      assert.deepEqual(read(storage, owner, brief), i === 2 ? empty : { selected:'body', fields:{body:i + brief} });
    }
  }
  save(storage, owners[0], 'invite', {selected:'body', fields:{}});
  assert.deepEqual(read(storage, owners[0], 'invite'), empty);
});

test('unreadable and malformed drafts do not block opening the artwork', () => {
  const malformed = { selected:'not-an-object', fields:{ title: 3, body:'a'.repeat(300), voice:'', unknown:'x' } };
  assert.deepEqual(read({getItem: () => JSON.stringify(malformed)}, {}, 'launch'), {selected:null, fields:{body:'a'.repeat(240)}});
  assert.deepEqual(read({getItem: () => '{'}, {}, 'launch'), {selected:null, fields:{}});
});


test('restores the last brief per owner, including old profiles, branches and deleted conversations', () => {
  const storage = memoryStore();
  const project = {projectId:'a'}, chat = {projectId:'a', conversationId:'a'};
  assert.equal(lastBrief(storage, chat), 'launch');
  for (const scope of [project, chat]) rememberBrief(storage, scope, 'invite');
  for (const scope of [{}, {conversationId:'fork'}, {projectId:'b'}]) assert.equal(lastBrief(storage, scope), 'launch');
  assert.equal(lastBrief(storage, {conversationId:'a'}), 'invite');
  forgetConversation(storage, 'a');
  assert.equal(lastBrief(storage, chat), 'launch');
  assert.equal(lastBrief(storage, project), 'invite');
  rememberBrief(storage, project, 'launch');
  assert.equal(lastBrief(storage, project), 'launch');
  assert.equal(lastBrief({getItem: () => 'unknown'}, {}), 'launch');
});
