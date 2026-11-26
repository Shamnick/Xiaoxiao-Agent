'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function main() {
  if (process.platform !== 'darwin') throw Error('请在安装了 Xiaoxiao Agent 的 Mac 上运行。');
  const bundle = '/Applications/Xiaoxiao Agent.app';
  const executable = path.join(bundle, 'Contents/MacOS/Xiaoxiao Agent');
  fs.accessSync(executable, fs.constants.X_OK);
  const version = execFileSync('/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleShortVersionString', path.join(bundle, 'Contents/Info.plist')], {encoding:'utf8'}).trim();
  console.log('正在验收安装版 ' + version + ' · ' + bundle);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxiao-installed-check-'));
  try {
    // Own the temporary profile even if the desktop test runner exits during launch.
    const env = {...process.env, TMPDIR:tmp, XIAOXIAO_SMOKE_EXECUTABLE:executable};
    delete env.XIAOXIAO_SMOKE_QA_DIR;
    execFileSync(process.execPath, [path.join(__dirname, 'proof-studio-smoke.cjs')], {env, stdio:'inherit'});
  } finally {
    fs.rmSync(tmp, {recursive:true, force:true});
  }
  console.log('安装版通过首页交互和本机 WAV 片段导出验收。');
}

try { main(); } catch (error) {
  console.error('安装版验收失败。' + error.message);
  process.exitCode = 1;
}
