'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, format } = require('../scripts/beta-report.cjs');
const now = Date.parse('2026-11-26T12:00:00Z');
const row = (id, extra) => ({id,startedAt:'2026-11-19T20:00:00+08:00',firstDelivery:'independent',followUp:'confirmed',...extra});

test('beta counts use actual enrollment and a seven-day window, with ongoing and lost cases visible', () => {
  const counts = summarize({participants:[
    row('P01',{secondProjectAt:'2026-11-26T12:00:00Z'}),
    row('P02',{startedAt:'2026-11-18T12:00:00Z',secondProjectAt:'2026-11-25T12:00:01Z',firstDelivery:'assisted'}),
    row('P03',{startedAt:'2026-11-25T12:00:00Z',firstDelivery:'pending',followUp:'open'}),
    row('P04',{firstDelivery:'withdrew',followUp:'lost'})
  ]}, now);
  assert.deepEqual(counts,{enrolled:4,independent:1,assisted:1,pending:1,failed:0,withdrew:1,reused:1,closed:3,observing:1,missed:1});
  assert.match(format(counts), /第二个项目 1\/4/);
  assert.match(format(summarize({participants:[]})), /暂无样本/);
});
test('beta reporting rejects duplicate participants, future events, and premature loss to follow-up', () => {
  for (const people of [[row('P01'),row('P01')],[row('P02',{secondProjectAt:'2026-11-28T12:00:00Z'})],
    [row('P03',{startedAt:'2026-11-25T12:00:00Z',followUp:'lost'})],
    [row('P04',{secondProjectAt:'2026-11-18T12:00:00Z'})]]) {
    assert.throws(()=>summarize({participants:people},now));
  }
});
