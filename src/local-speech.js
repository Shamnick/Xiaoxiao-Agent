'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execute = promisify(execFile);

async function synthesizeLocalSpeech({prompt, voice, speed}, signal) {
  if (process.platform !== 'darwin') throw Error('本机语音需要 macOS');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 3000) throw Error('本机语音每次支持 1 至 3000 个字符，请将长稿分段');
  if (!['default','Tingting','Samantha'].includes(voice) || ![0.75,1,1.25,1.5].includes(speed)) throw Error('请选择本机音色和语速');
  signal.throwIfAborted();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'xiaoxiao-speech-'));
  try {
    const script = path.join(dir,'script.txt');
    const output = path.join(dir,'speech.wav');
    await fs.writeFile(script,prompt.replaceAll('[[','［［'),{mode:0o600});
    const args = voice === 'default' ? [] : ['-v',voice];
    args.push('-r',String(Math.round(175 * speed)),'--file-format=WAVE','--data-format=LEI16@22050','-o',output,'-f',script);
    try { await execute('/usr/bin/say',args,{signal,timeout:120000,maxBuffer:8192}); }
    catch { signal.throwIfAborted(); throw Error('系统未能完成语音合成，可换用系统默认音色或缩短文稿'); }
    signal.throwIfAborted();
    const size = (await fs.stat(output)).size;
    if (size < 45 || size > 64 * 1024 * 1024) throw Error('语音文件为空或超过 64 MiB，请调整文稿');
    const bytes = await fs.readFile(output);
    if (bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WAVE') throw Error('系统未返回有效的 WAV 音频');
    return {mimeType:'audio/wav',filename:'xiaoxiao-voice.wav',data:bytes.toString('base64')};
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
module.exports = { synthesizeLocalSpeech };
