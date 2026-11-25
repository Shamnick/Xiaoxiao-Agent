'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');
const { waitForUser, questionTool } = require('../src/task-interaction');
const { taskDraftTool, taskDrafts } = require('../src/task-plan');
const { nextOccurrence, ScheduleBook } = require('../src/schedules');
const { listSkills, parseSkill, saveSkill, validateSkillIds, skillInstructions } = require('../src/skills');
const { runAgent } = require('../src/providers');

function memoryStore() {
  const data = new Map();
  return {
    read: (name, fallback) => structuredClone(data.get(name) ?? fallback),
    write: (name, value) => data.set(name, structuredClone(value))
  };
}

test('a task question waits for the user, rejects invalid answers, and records the chosen response', async () => {
  const run = { signal: new AbortController().signal };
  const events = [], records = [];
  const tool = questionTool({ ask: prompt => waitForUser(run, prompt, event => events.push(event)), record: row => records.push(row) });
  const answer = tool.execute({ question: 'Who is the audience?', options: [' Product ', 'Product', 'Support'] });
  assert.deepEqual(run.interaction.options, ['Product', 'Support']);
  assert.throws(() => run.response(true), /回答/);
  assert.deepEqual(records, []);
  run.response('  Support  ');
  assert.deepEqual(await answer, { answer: 'Support' });
  assert.deepEqual(records, [{ question: 'Who is the audience?', answer: 'Support' }]);
  assert.equal(run.response, null);
  assert.equal(events.at(-1).interaction, null);
});

test('stopping a task clears pending permission and stale approval cannot resume it', async () => {
  const controller = new AbortController();
  const run = { signal: controller.signal };
  const pending = waitForUser(run, { kind: 'approval', title: 'Write a file', detail: 'draft.md' }, () => {});
  const lateApproval = run.response;
  assert.throws(() => lateApproval('true'), /允许或拒绝/);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.throws(() => lateApproval(true), { name: 'AbortError' });
  assert.equal(run.interaction, null);
});

test('old draft is migrated without replacing other documents and revisions keep their identity', () => {
  let drafts = taskDrafts({ draft: { title: '原报告', markdown: '# 旧' } });
  const tool = taskDraftTool({ signal: new AbortController().signal, read: () => drafts, save: next => { drafts = next; } });
  const original = tool.execute({ title: '原报告', markdown: '# 修订' });
  assert.deepEqual(original, { id: 'legacy-draft', title: '原报告', revision: 2 });
  const next = tool.execute({ title: '摘要', markdown: '# 摘要' });
  assert.notEqual(next.id, original.id);
  assert.throws(() => tool.execute({ id: next.id, title: '原报告', markdown: '# 冲突' }), /同名/);
  assert.equal(drafts.length, 2);
  const renamed = tool.execute({ id: next.id, title: '执行摘要', markdown: '# 更新' });
  assert.equal(renamed.revision, 2);
  assert.equal(drafts[0].markdown, '# 修订');
});

test('only explicitly selected skill text is included while import fields remain validated', () => {
  const store = memoryStore();
  const contents = '---\r\nname: quarterly-summary\r\ndescription: >-\r\n  Briefing for\r\n  a quarterly review\r\n---\r\n# Instructions\r\nSKILL_MARKER';
  const candidate = parseSkill(contents);
  assert.equal(candidate.description, 'Briefing for a quarterly review');
  const stored = saveSkill(store, candidate);
  assert(listSkills(store).some(row => row.id === stored.id));
  assert.equal(skillInstructions(store, []), '');
  assert.match(skillInstructions(store, validateSkillIds(store, [stored.id])), /SKILL_MARKER/);
  assert.doesNotMatch(skillInstructions(store, ['builtin-brief']), /SKILL_MARKER/);
  assert.throws(() => validateSkillIds(store, [stored.id, stored.id]), /最多/);
  assert.throws(() => parseSkill('---\nname: true\ndescription: hello\n---\nbody'), /名称/);
  assert.throws(() => parseSkill('---\nname: !untrusted label\ndescription: hello\n---\nbody'), /YAML/);
});

test('daily and weekly schedules use local time, do not duplicate starts, and recover without replay', () => {
  const start = new Date(2026, 10, 20, 8).getTime();
  let now = start;
  const store = memoryStore();
  const book = new ScheduleBook(store, () => now);
  const config = { title: 'Weekly', prompt: 'Produce a briefing', providerId: 'local', frequency: 'weekly', time: '09:00', weekday: 5, enabled: true };
  const row = book.save(config);
  assert.equal(row.nextAt, new Date(2026, 10, 20, 9).getTime());
  assert.deepEqual(book.due(), []);
  now = row.nextAt + 200;
  assert.equal(book.due()[0].id, row.id);
  book.begin(row.id, 'job-1', true);
  assert.deepEqual(book.due(), []);
  assert.equal(book.get(row.id).nextAt, new Date(2026, 10, 27, 9).getTime());
  book.finish(row.id, 'different-job', 'failure');
  assert.equal(book.get(row.id).lastRun.state, 'running');
  book.recover();
  assert.match(book.get(row.id).lastRun.error, /中断/);
  assert.equal(nextOccurrence({ frequency: 'daily', time: '07:30' }, start), new Date(2026, 10, 21, 7, 30).getTime());
});

test('missed schedules skip old times and disabled plans can be run without changing their recurrence', () => {
  let now = new Date(2026, 10, 20, 8).getTime();
  const book = new ScheduleBook(memoryStore(), () => now);
  const row = book.save({ title: 'Review', prompt: 'Check the selected references', providerId: 'fixture', frequency: 'daily', time: '08:15', enabled: true });
  now = row.nextAt + 6 * 60 * 1000;
  assert.deepEqual(book.due(), []);
  assert.equal(book.get(row.id).missedAt, row.nextAt);
  assert(book.get(row.id).nextAt > now);
  const paused = book.save({ ...row, enabled: false });
  book.begin(paused.id, 'manual');
  book.finish(paused.id, 'manual');
  assert.equal(book.get(row.id).nextAt, null);
  assert.equal(book.get(row.id).lastRun.state, 'completed');
});

test('an update during a model response arrives in the following model request', async () => {
  const received = [];
  let release, queued = '';
  const task = runAgent({ model: 'test', baseUrl: 'http://fixture', kind: 'openai-compatible', stream: false }, [{ role: 'user', content: 'Original request' }], {
    async request(_, options) {
      received.push(JSON.parse(options.body).messages);
      const first = received.length === 1;
      if (first) await new Promise(resolve => { release = resolve; });
      return Response.json({ choices: [{ message: { content: first ? 'Work in progress' : 'Short summary' } }] });
    },
    takeUserUpdate() { const text = queued; queued = ''; return text; }
  });
  await tick();
  queued = 'Use a shorter answer';
  release();
  assert.equal(await task, 'Work in progress\n\nShort summary');
  assert.deepEqual(received[1].slice(-2), [{ role: 'assistant', content: 'Work in progress' }, { role: 'user', content: 'Use a shorter answer' }]);
});


test('stopping a task cancels all of its concurrent analyses', async () => {
  const { parallelAnalysisTool } = require('../src/task-analysis');
  const controller = new AbortController();
  const signals = [];
  const progress = [];
  const tool = parallelAnalysisTool({
    signal: controller.signal,
    report: state => progress.push(state),
    analyze(_, signal) {
      signals.push(signal);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  });
  const running = tool.execute({ pieces: [{ goal: 'A', context: '1' }, { goal: 'B', context: '2' }] });
  assert.equal(signals.length, 2);
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert(signals.every(signal => signal.aborted));
  assert.deepEqual(progress, [{ total: 2, finished: 0, failed: 0 }]);
});

test('parallel analysis is limited to one ordered batch per task request', async () => {
  const { parallelAnalysisTool } = require('../src/task-analysis');
  const controller = new AbortController();
  const progress = [];
  const tool = parallelAnalysisTool({
    signal: controller.signal,
    report: state => progress.push(state),
    analyze: async ({ goal }) => goal === 'A' ? 'x'.repeat(7000) : ''
  });
  const pieces = [{ goal: 'A', context: '1' }, { goal: 'B', context: '2' }];
  const out = await tool.execute({ pieces });
  assert.equal(out.results[0].state, 'completed');
  assert.equal(out.results[0].truncated, true);
  assert.equal(out.results[1].state, 'failed');
  assert.equal(progress.at(-1).failed, 1);
  assert.match((await tool.execute({ pieces })).error, /已进行过并行分析/);
});
