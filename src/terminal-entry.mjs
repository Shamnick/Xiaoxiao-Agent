import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function stylesheet() {
  const styles = getComputedStyle(document.documentElement);
  const token = name => styles.getPropertyValue(name).trim();
  const red = token('--deletion'), green = token('--addition'), yellow = token('--pending');
  const blue = token('--syntax-number'), magenta = token('--syntax-keyword'), cyan = token('--syntax-name');
  const black = token('--muted'), white = token('--text');
  return {
    background: token('--surface'), foreground: white, cursor: white, selectionBackground: token('--accent-soft'),
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack: black, brightRed: red, brightGreen: green, brightYellow: yellow,
    brightBlue: blue, brightMagenta: magenta, brightCyan: cyan, brightWhite: white
  };
}

window.xiaoxiaoTerminal = {
  open(container, { onInput, onResize }) {
    const terminal = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim(),
      fontSize: 12, lineHeight: 1.22, cursorBlink: false, scrollback: 3000,
      theme: stylesheet(),
      linkHandler: { activate() {} }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.onData(onInput);
    terminal.onResize(({ cols, rows }) => onResize(cols, rows));
    return {
      fit() { if (container.offsetHeight && container.offsetWidth) fit.fit(); return { columns: terminal.cols, rows: terminal.rows }; },
      write: (text, done) => terminal.write(text, done),
      updateTheme: () => { terminal.options.theme = stylesheet(); },
      focus: () => terminal.focus(),
      dispose: () => terminal.dispose()
    };
  }
};
