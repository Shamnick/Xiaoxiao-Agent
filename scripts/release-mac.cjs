'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const appName = 'Xiaoxiao Agent';
const version = require('../package.json').version;
const dmgName = appName + '-' + version + '-arm64.dmg';

function selectSigner(list, fingerprint) {
  const matches = [...list.matchAll(/^\s*\d+\) ([\dA-F]{40}) "Developer ID Application: [^"\n]+ \(([A-Z0-9]{10})\)"\s*$/gmi)]
    .filter(match => !fingerprint || match[1].toUpperCase() === fingerprint.toUpperCase());
  if (!matches.length) throw Error('钥匙串中找不到可用的 Developer ID Application 签名身份。');
  if (matches.length > 1) throw Error('找到多个签名身份，请用 XIAOXIAO_SIGN_SHA1 指定证书指纹。');
  return { hash:matches[0][1], team:matches[0][2] };
}

function tool(file, args, capture = false) {
  return execFileSync(file, args, {cwd:root, encoding:'utf8', stdio:capture ? ['ignore','pipe','inherit'] : 'inherit'});
}

function preflight() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('请在 Apple Silicon Mac 上运行。');
  const signer = selectSigner(tool('/usr/bin/security', ['find-identity','-v','-p','codesigning'], true), process.env.XIAOXIAO_SIGN_SHA1);
  const profile = process.env.APPLE_KEYCHAIN_PROFILE?.trim();
  if (!profile) throw Error('请设置 APPLE_KEYCHAIN_PROFILE，指定已保存的 notarytool 钥匙串配置名称。');
  for (const name of ['notarytool','stapler']) tool('/usr/bin/xcrun', ['--find',name], true);
  return {signer, profile};
}

function verifySignature(file, team, app, run = tool) {
  const clauses = ['anchor apple generic', 'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    'certificate leaf[subject.OU] = "' + team + '"'];
  if (app) clauses.push('identifier "com.xiaoxiao.agent"');
  if (app) run('/usr/bin/codesign', ['--verify', '--deep', '--strict', file]);
  run('/usr/bin/codesign', ['--verify', '--strict', '-R=' + clauses.join(' and '), file]);
}

function certifyImage({dmg, app, team, profile}, run = tool) {
  verifySignature(app, team, true, run);
  verifySignature(dmg, team, false, run);
  const receipt = JSON.parse(run('/usr/bin/xcrun', ['notarytool','submit',dmg,'--keychain-profile',profile,
    ...(process.env.APPLE_KEYCHAIN ? ['--keychain',process.env.APPLE_KEYCHAIN] : []),
    '--wait','--output-format','json'], true));
  if (receipt.status !== 'Accepted') throw Error('Apple 公证状态为 ' + (receipt.status || '未知') + '。提交编号 ' + (receipt.id || '未知'));
  run('/usr/bin/xcrun', ['stapler','staple',dmg]);
  run('/usr/bin/xcrun', ['stapler','validate',dmg]);
  verifySignature(dmg, team, false, run);
  run('/usr/sbin/spctl', ['--assess','--type','open','--context','context:primary-signature',dmg]);
}

async function inspectDiskImage(dmg, team) {
  const mount = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-release-'));
  try {
    tool('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    try {
      const app = path.join(mount, appName + '.app');
      verifySignature(app, team, true);
      tool('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
      const env = { ...process.env, XIAOXIAO_SMOKE_EXECUTABLE: path.join(app, 'Contents', 'MacOS', appName) };
      delete env.XIAOXIAO_SMOKE_QA_DIR;
      for (const suite of ['generation-smoke.cjs', 'proof-studio-smoke.cjs']) {
        execFileSync(process.execPath, [path.join(root, 'scripts', suite)], { cwd:root, env, stdio:'inherit' });
      }
    } finally {
      tool('/usr/bin/hdiutil', ['detach', mount]);
    }
  } finally {
    // Only remove the empty mountpoint. Never recurse into a mounted volume.
    await fs.rmdir(mount).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function releaseConfig(signer, out) {
  return {
    directories:{output:out}, forceCodeSigning:true,
    mac:{identity:signer.hash, type:'distribution', hardenedRuntime:true, notarize:false},
    dmg:{sign:true, artifactName:dmgName, writeUpdateInfo:false}
  };
}

async function main(args) {
  if (args.length && !(args.length === 1 && args[0] === '--check')) throw Error('可用选项为 --check。');
  const {signer, profile} = preflight();
  if (args.length) return console.log('本机签名身份、公证工具和配置名称已就绪。实际凭据由 Apple 在提交时验证。');
  tool(process.execPath, [path.join(root,'scripts/build-renderer.cjs')]);
  const {build, Platform, Arch} = require('electron-builder');
  const dist = path.join(root,'dist');
  await fs.mkdir(dist, {recursive:true});
  const out = await fs.mkdtemp(path.join(dist,'.release-'));
  try {
    await build({projectDir:root, targets:Platform.MAC.createTarget('dmg',Arch.arm64), publish:'never', config:releaseConfig(signer,out)});
    certifyImage({app:path.join(out,'mac-arm64',appName + '.app'), dmg:path.join(out,dmgName), team:signer.team, profile});
    await inspectDiskImage(path.join(out, dmgName), signer.team);
    const dest = await fs.mkdtemp(path.join(dist,'release-' + version + '-'));
    const result = path.join(dest,dmgName);
    await fs.rename(path.join(out,dmgName),result);
    console.log('经验证的分发安装包 ' + result);
  } finally {
    await fs.rm(out, {recursive:true, force:true});
  }
}

module.exports = {selectSigner, verifySignature, certifyImage, releaseConfig};
if (require.main === module) main(process.argv.slice(2)).catch(error => {console.error(error.message); process.exitCode = 1;});
