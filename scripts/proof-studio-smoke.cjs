const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { _electron: electron } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-proof-'));
  const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
  let app;
  try {
    app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: root,
      env: { ...process.env, XIAOXIAO_SMOKE_DIR: data, XIAOXIAO_SMOKE_SHOW: '1' } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(9000);
    const errors = [], network = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/^https?:/.test(r.url())) network.push(new URL(r.url()).origin); });
    const node = id => page.locator('#' + id);
    const text = id => node(id).innerText();
    const focus = id => page.waitForFunction(id => document.activeElement.id === id, id);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await node('presenceKnot').click();
    await node('prompt').fill('保留我的对话草稿');
    await node('openProofFromKnot').click();
    await focus('proofTitleObject');
    const original = await text('proofTitleObject');
    const art = page.locator('.proof-art');
    const originalArt = await art.getAttribute('src');
    await node('proofPrompt').fill('口语一点，底图留着');
    await node('proofPreview').click();
    await focus('proofTitleObject');
    assert.match(await text('proofStatus'), /标题还是旁白/);
    await page.keyboard.press('Enter');
    await focus('proofAccept');
    assert.equal(await text('proofBefore'), original);
    const changed = await text('proofAfter');
    assert.notEqual(changed, original);
    assert.equal(await text('proofTitleObject'), original);
    const output = process.env.XIAOXIAO_SMOKE_QA_DIR;
    if (output) {
      await fs.mkdir(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'proof-comparison.png'), scale: 'css' });
    }
    await page.keyboard.press('Enter');
    assert.equal(await text('proofTitleObject'), changed);
    assert.equal(await text('proofVoiceObject'), original);
    assert.equal(await art.getAttribute('src'), originalArt);
    await node('proofSync').click();
    await node('proofDiscard').click();
    assert.equal(await text('proofVoiceObject'), original);
    await node('proofSync').click();
    await node('proofAccept').click();
    assert.equal(await text('proofVoiceObject'), changed);
    await node('proofUndo').click();
    assert.equal(await text('proofVoiceObject'), original);
    assert.equal(await text('proofTitleObject'), changed);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    assert.equal(await text('proofTitleObject'), original);
    await node('proofBrief').selectOption('invite');
    const otherTitle = await text('proofTitleObject');
    assert.notEqual(otherTitle, original);
    await node('proofVoiceObject').click();
    await node('proofPrompt').fill('自定义指令');
    await node('proofPreview').click();
    assert(await node('proofCompare').isHidden());
    assert.match(await text('proofStatus'), /演示支持/);
    await node('proofPrompt').fill('改成：周五来工作室看看。');
    await node('proofPreview').click();
    await node('proofAccept').click();
    assert.equal(await text('proofVoiceObject'), '周五来工作室看看。');
    assert.equal(await text('proofTitleObject'), otherTitle);
    await node('proofBrief').selectOption('launch');
    assert.equal(await text('proofVoiceObject'), original);
    await page.keyboard.press('Escape');
    await focus('openProofFromKnot');
    assert.equal(await node('prompt').inputValue(), '保留我的对话草稿');
    await node('toggleSidebar').click();
    await node('openProofFromRail').click();
    await node('proofBrief').selectOption('invite');
    assert.equal(await text('proofVoiceObject'), '周五来工作室看看。');
    assert(await art.evaluate(img => img.complete && img.naturalWidth > 0));
    await node('proofClose').click();
    await focus('openProofFromRail');
    assert(await node('presence').isVisible());
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    console.log('PASS: two briefs, target clarification, keyboard preview, apply/discard, explicit voice sync, undo, focus restoration, chat draft and offline operation.');
  } finally {
    try { await app?.close(); } finally { await fs.rm(data, { recursive: true, force: true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
