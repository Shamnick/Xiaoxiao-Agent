'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const installedApp = '/Applications/Xiaoxiao Agent.app/Contents/MacOS/Xiaoxiao Agent';
const trialRoot = path.join(__dirname, '..', 'artifacts', 'phase-one', 'trials');

async function prepareTrial(root, args) {
  let profile;
  if (!args.length) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    profile = await fs.mkdtemp(path.join(root, 'round-'));
  } else {
    const [option, id] = args;
    if (args.length !== 2 || option !== '--resume' || !/^round-[a-zA-Z0-9]{6}$/.test(id)) {
      throw Error('新一轮请运行 npm run trial:phase-one。接续同一轮请在命令后加 -- --resume round-编号。');
    }
    profile = path.join(root, id);
    const entry = await fs.lstat(profile).catch(error => {
      if (error.code === 'ENOENT') throw Error('找不到这轮试用，请核对终端显示的轮次编号。');
      throw error;
    });
    if (!entry.isDirectory()) throw Error('请选择本地试用目录。');
  }
  return {
    profile,
    env: { ...process.env, XIAOXIAO_SMOKE_DIR: profile, XIAOXIAO_SMOKE_SHOW: '1' }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const source = args[0] === '--source';
  if (source) args.shift();
  const executable = source ? require('electron') : installedApp;
  await fs.access(executable, fs.constants.X_OK).catch(() => {
    throw Error('请先将 Xiaoxiao Agent 安装到 Mac 的「应用程序」。');
  });
  const { profile, env } = await prepareTrial(trialRoot, args);
  const id = path.basename(profile);
  console.log('本次试用 ' + id + '\n本机试用目录 ' + profile);
  console.log((source ? '源码试用' : '安装版试用') + '。接续本轮可运行 npm run trial:phase-one -- ' + (source ? '--source ' : '') + '--resume ' + id);
  const child = spawn(executable, source ? ['.'] : [], { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit' });
  const [code, signal] = await once(child, 'close');
  if (signal || code !== 0) throw Error('试用窗口已中断。可用上方命令重新打开这一轮。');
}

module.exports = { prepareTrial };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
