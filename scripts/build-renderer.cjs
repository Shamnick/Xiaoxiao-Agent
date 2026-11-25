'use strict';

const path = require('node:path');
const { chmodSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');

// Adapt the pinned xterm renderer to our style CSP without granting inline styles globally.
const terminalCsp = {
  name: 'terminal-style-csp',
  setup(builder) {
    builder.onLoad({ filter: /[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.mjs$/ }, ({ path: filename }) => {
      let sheets = 0;
      let declarations = 0;
      const contents = readFileSync(filename, 'utf8')
        .replace(/([\w$.]+)\.createElement\("style"\)/g, (_, owner) => {
          sheets++;
          return `Object.assign(${owner}.createElement("style"),{nonce:${owner}.querySelector('meta[name="editor-style-nonce"]').content})`;
        })
        .replace(/(\w+)\.setAttribute\("style",(`[^`]+`)\)/g, (_, element, value) => {
          declarations++;
          return `(${element}.style.cssText=${value})`;
        });
      if (sheets !== 3 || declarations !== 1) throw Error('Review xterm CSS generation against the renderer CSP before updating it');
      return { contents, loader: 'js' };
    });
  }
};

async function buildRenderer() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: { editor: 'src/editor-entry.mjs', terminal: 'src/terminal-entry.mjs' },
    outdir: 'src/generated',
    platform: 'browser',
    bundle: true,
    format: 'iife',
    minify: true,
    legalComments: 'linked',
    metafile: true,
    plugins: [terminalCsp]
  });
  const packages = new Set(Object.keys(result.metafile.inputs).map(input => /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input)?.[1]).filter(Boolean));
  const notices = [...packages].sort().map(name => {
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
      try { return `${name}\n${readFileSync(path.join(root, 'node_modules', name, file), 'utf8').trim()}`; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw Error(`Missing license notice for ${name}`);
  });
  writeFileSync(path.join(root, 'src/generated/licenses.txt'), notices.join('\n\n') + '\n');

  // npm may extract the macOS helper without its execute bit. Electron uses the Node-API prebuild.
  if (process.platform === 'darwin') {
    const pty = path.dirname(require.resolve('node-pty/package.json'));
    for (const directory of [`prebuilds/darwin-${process.arch}`, 'build/Release']) {
      const helper = path.join(pty, directory, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
}

buildRenderer().catch(error => { console.error(error); process.exitCode = 1; });
