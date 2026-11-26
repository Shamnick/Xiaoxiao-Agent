'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { prepareTrial } = require('./field-trial.cjs');

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-trial-test-'));
  const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
  const instances = new Set();
  async function openTrial(trial) {
    const app = await electron.launch({
      cwd: path.resolve(__dirname, '..'), executablePath, args: executablePath ? [] : ['.'],
      env: trial.env
    });
    instances.add(app);
    const profile = await app.evaluate(({ app }) => ({
      user: app.getPath('userData'), session: app.getPath('sessionData')
    }));
    assert.equal(profile.user, trial.profile);
    assert.equal(profile.session, path.join(trial.profile, 'Session'));
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.locator('#presenceKnot:enabled').click();
    await page.locator('#openProofFromKnot').click();
    await page.locator('#proofTitleObject').filter({ hasText: /。/ }).waitFor();
    return { app, page };
  }
  async function close(app) {
    await app.close();
    instances.delete(app);
  }
  try {
    const first = await prepareTrial(root, []);
    const a = await openTrial(first);
    const edited = '只给第一位试用者看。';
    await a.page.locator('#proofTitleObject').click();
    await a.page.locator('#proofPrompt').fill('改成：' + edited);
    await a.page.locator('#proofPreview').click();
    await a.page.locator('#proofAccept').click();
    await a.page.locator('#proofTitleObject').filter({ hasText: edited }).waitFor();
    await a.page.evaluate(async () => {
      await nova.providers.save({ name: '试用配置', kind: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1' });
      await nova.conversations.create({ title: '第一轮记录' });
      localStorage.setItem('field-test-sentinel', 'first');
    });

    // Open another participant alongside the first to catch single-instance lock collisions.
    const second = await prepareTrial(root, []);
    assert.notEqual(second.profile, first.profile);
    const b = await openTrial(second);
    assert.equal(await b.page.locator('#proofTitleObject').innerText(), '让灵感成形。');
    await b.page.locator('#proofBrief').selectOption('invite');
    await b.page.locator('#proofTitleObject').filter({ hasText: '开启你的创作之旅。' }).waitFor();
    assert.equal(await b.page.locator('#proofVoiceObject').innerText(), '开启你的创作之旅。');
    assert.equal(await b.page.locator('#proofUndo').isVisible(), false);
    assert.deepEqual(await b.page.evaluate(async () => ({
      conversations: (await nova.conversations.list()).length, providers: (await nova.providers.list()).length,
      marker: localStorage.getItem('field-test-sentinel')
    })), { conversations: 0, providers: 0, marker: null });
    await b.page.locator('#proofBodyObject').click();
    const bodyDraft = '改成：只留在第二轮体验邀请的正文。';
    await b.page.locator('#proofPrompt').fill(bodyDraft);
    await close(b.app);
    await close(a.app);

    const resumed = await prepareTrial(root, ['--resume', path.basename(first.profile)]);
    const c = await openTrial(resumed);
    assert.equal(await c.page.locator('#proofTitleObject').innerText(), edited);
    assert.deepEqual(await c.page.evaluate(async () => ({
      titles: (await nova.conversations.list()).map(row => row.title),
      providers: (await nova.providers.list()).map(row => row.name), marker: localStorage.getItem('field-test-sentinel')
    })), { titles: ['第一轮记录'], providers: ['试用配置'], marker: 'first' });
    await close(c.app);
    const otherRound = await prepareTrial(root, ['--resume', path.basename(second.profile)]);
    const reopened = await openTrial(otherRound);
    assert.equal(await reopened.page.locator('#proofBrief').inputValue(), 'invite',
      'Resuming the invitation round should open the same brief');
    assert.equal(await reopened.page.locator('#proofBodyObject').getAttribute('aria-pressed'), 'true');
    assert.equal(await reopened.page.locator('#proofPrompt').inputValue(), bodyDraft);
    await close(reopened.app);
    await assert.rejects(prepareTrial(root, ['--resume', '../profile']), /round-编号/);
    await assert.rejects(prepareTrial(path.join(root, 'missing'), ['--resume', path.basename(first.profile)]), /找不到/);
    console.log('PASS: isolated participants, fresh briefs and empty conversation history, separate browser storage, and explicit round recovery.');
  } finally {
    try { await Promise.all([...instances].map(app => app.close())); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
