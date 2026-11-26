'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const enterWorkspace = require('./enter-workspace.cjs');

(async () => {
  if (process.platform !== 'darwin') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-barge-in-'));
  const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
  let app;
  try {
    app = await electron.launch({executablePath, args:executablePath ? [] : ['.'], cwd:path.resolve(__dirname,'..'),
      env:{...process.env, XIAOXIAO_SMOKE_DIR:dir, XIAOXIAO_SMOKE_SHOW:'1'}});
    const page = await app.firstWindow();
    await enterWorkspace(page);
    await page.bringToFront();
    // Use a real Web Audio stream with synthetic input. Never open a hardware microphone.
    await page.evaluate(async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const qa = window.voiceQA = {ctx, replies:[], stopped:[], tracks:[]};
      const oscillator = ctx.createOscillator(), gain = qa.gain = ctx.createGain();
      gain.gain.value = 0;
      oscillator.connect(gain);
      oscillator.start();
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (constraints.video !== false) throw Error('unexpected video request');
        if (qa.denied) throw new DOMException('permission denied','NotAllowedError');
        const output = ctx.createMediaStreamDestination();
        gain.connect(output);
        const track = output.stream.getAudioTracks()[0];
        qa.tracks.push(track);
        if (qa.hold) await new Promise(resolve => { qa.release = resolve; });
        return output.stream;
      };
      speechSynthesis.speak = reply => { qa.replies.push(reply); reply.onstart?.(); };
      speechSynthesis.cancel = () => qa.stopped.push(performance.now());
    });
    const speak = () => page.evaluate(() => presence.readReply({role:'assistant',content:'测试朗读'}));
    await page.locator('#speakReply').click();
    await speak();
    assert.equal(await page.evaluate(() => voiceQA.tracks.length), 0);
    await page.evaluate(() => { voiceQA.replies.at(-1).onend(); });
    await page.locator('#settingsCompact:visible, #settings:visible').first().click();
    await page.locator('#generalTab').click();
    await page.locator('#voiceInterruption').selectOption('microphone');
    await page.waitForFunction(() => prefs.voiceInterruption === 'microphone');
    await page.locator('#closeSettings').click();
    await app.evaluate(({Menu, BrowserWindow}) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.focus();
      win.isFocused = win.webContents.isFocused = () => true;
      globalThis.qaDictations = 0;
      Menu.sendActionToFirstResponder = selector => { if (selector === 'startDictation:') globalThis.qaDictations++; };
    });
    await page.waitForFunction(() => document.hasFocus());
    const latency = [];
    for (let i = 0; i < 10; i++) {
      await speak();
      await page.waitForFunction(count => voiceQA.tracks.length === count, i + 1);
      await page.locator('#voiceMonitorActive').waitFor();
      const onset = await page.evaluate(() => {
        voiceQA.replies.at(-2)?.onend(); // delayed callback from the previous turn
        voiceQA.gain.gain.value = 0.4;
        return performance.now();
      });
      await page.waitForFunction(count => voiceQA.stopped.length === count, i + 1);
      assert(await page.locator('#voiceMonitorActive').isHidden());
      latency.push(await page.evaluate(onset => {
        voiceQA.gain.gain.value = 0;
        if (voiceQA.tracks.at(-1).readyState !== 'ended') throw Error('microphone still active');
        return voiceQA.stopped.at(-1) - onset;
      }, onset));
      await page.waitForFunction(() => document.getElementById('dictationHint').textContent.includes('确认文字'));
    }
    assert.equal(await app.evaluate(() => globalThis.qaDictations),10);
    await page.evaluate(() => { voiceQA.denied = true; });
    await speak();
    await page.locator('#dictationHint').filter({hasText:'麦克风暂不可用'}).waitFor();
    await page.evaluate(() => { voiceQA.replies.at(-1).onend(); voiceQA.denied = false; voiceQA.hold = true; });
    await speak();
    await page.waitForFunction(() => Boolean(voiceQA.release));
    await page.locator('#speakReply').click();
    await page.evaluate(() => voiceQA.release());
    await page.waitForFunction(() => voiceQA.tracks.every(track => track.readyState === 'ended'));
    assert.equal(await app.evaluate(() => globalThis.qaDictations),10);
    console.log('PASS: 10 synthetic-audio interruptions; onset to speech cancel callback (ms):',
      latency.map(value => Math.round(value)).join(', '), '· late callbacks, permission denial and capture cleanup.');
  } finally { await app?.close(); await fs.rm(dir,{recursive:true,force:true}); }
})().catch(error => {console.error(error);process.exitCode=1;});
