'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const drafts = require('../src/chat-drafts');

function storage() {
  const entries = new Map();
  return { entries, getItem:key => entries.get(key) ?? null,
    setItem:(key,value) => entries.set(key,value), removeItem:key => entries.delete(key) };
}

test('draft storage retains only restorable fields, including during partial key entry', () => {
  const local = storage();
  drafts.write(local,'home:',{text:'test sk-fi', attachments:[{id:'grant',name:'/secret/f.txt',text:'private bytes'}],
    providerId:'provider',agent:true,planning:true,skillIds:['skill'],systemPrompt:'private settings'});
  const value = drafts.read(local,'home:');
  assert.deepEqual(value,{text:'test [已隐藏密钥]',missing:['f.txt'],providerId:'provider',agent:true,planning:true,skillIds:['skill']});
  const json = [...local.entries.values()].join('');
  for (const field of ['sk-fi','grant','private','/secret/']) assert(!json.includes(field));
});

test('clearing a draft or encountering malformed data leaves other owners intact', () => {
  const local = storage();
  drafts.write(local,'home:',{text:'草稿'});
  drafts.write(local,'home:p',{text:'项目'});
  drafts.write(local,'c',{attachments:[{name:'附件'}]});
  drafts.write(local,'home:p',null);
  assert.equal(drafts.read(local,'home:p'),null);
  assert.equal(drafts.read(local,'home:').text,'草稿');
  assert.deepEqual(drafts.read(local,'c').missing,['附件']);
  local.setItem('xiaoxiao-chat-draft:c','broken json');
  assert.equal(drafts.read(local,'c'),null);
});
