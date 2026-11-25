const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const library = path.dirname(require.resolve('lucide-static/package.json'));
const icons = path.join(root, 'src', 'icons', 'lucide');
mkdirSync(icons, { recursive: true });
for (const name of [
  'arrow-down-to-line', 'arrow-up', 'calendar-clock', 'check', 'chevron-down', 'chevron-right', 'circle',
  'clipboard-list', 'ellipsis', 'file-text', 'folder', 'history', 'loader-circle', 'image-play', 'sparkles', 'image', 'film', 'audio-lines', 'mic', 'volume-2', 'download', 'circle-stop',
  'lock-keyhole', 'message-circle', 'panel-left', 'panel-right', 'paperclip', 'pin', 'plus', 'search',
  'arrow-left', 'code-xml', 'git-branch', 'columns-2', 'save', 'list-checks', 'play', 'folder-open', 'git-compare-arrows', 'layout-template', 'link-2', 'refresh-cw', 'wrap-text',
  'puzzle', 'settings', 'sliders-horizontal', 'square', 'square-pen', 'trash-2', 'x'
]) {
  copyFileSync(path.join(library, 'icons', `${name}.svg`), path.join(icons, `${name}.svg`));
}
copyFileSync(path.join(library, 'LICENSE'), path.join(icons, 'LICENSE'));

if (process.platform === 'darwin') {
  execFileSync('swift', ['scripts/draw-icons.swift'], { cwd: root, stdio: 'inherit' });
  execFileSync('iconutil', ['-c', 'icns', 'build/icon.iconset', '-o', 'build/icon.icns'], { cwd: root, stdio: 'inherit' });
}
