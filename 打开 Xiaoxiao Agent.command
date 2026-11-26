#!/bin/zsh
# Start the development runtime without downloading dependencies or changing system policy.
set -u
root=${0:A:h}
runtime="$root/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "$runtime" || ! -r "$root/src/generated/editor.js" || ! -r "$root/src/generated/terminal.js" ]]; then
  print -u2 -- '本地开发依赖或界面文件不完整。请参照仓库 README 的「从源码启动」。'
  exit 1
fi
cd "$root" || exit 1
unset ELECTRON_RUN_AS_NODE XIAOXIAO_SMOKE_DIR XIAOXIAO_SMOKE_SHOW
# The main process handles repeat launches for the same user profile and focuses the existing window.
nohup "$runtime" "$root" </dev/null >/dev/null 2>&1 &!
