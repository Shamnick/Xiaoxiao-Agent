const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
for (const [directory, extensions] of [['src', /\.(?:m?js)$/], ['scripts', /\.cjs$/], ['test', /\.js$/]]) {
  for (const file of readdirSync(path.join(root, directory))) {
    if (extensions.test(file)) execFileSync(process.execPath, ['--check', path.join(root, directory, file)], { stdio: 'inherit' });
  }
}
