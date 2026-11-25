const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Apply an ad-hoc signature to local trial builds before creating the DMG.
module.exports = function signLocalMac(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return;
  if (context.packager.platformSpecificBuildOptions.identity !== null) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const bundle = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
};
