'use strict';

function createProjectTerminal({ $, api, errorMessage }) {
  const panel = $('terminalPanel');
  const button = $('terminalButton');
  const entries = new Map();
  const early = new Map();
  let scope, visible = false, starting = false;
  const current = () => scope && entries.get(scope.workspace);

  function render() {
    const entry = current();
    panel.hidden = !scope || !visible;
    button.hidden = !scope;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    $('terminalLocation').textContent = entry?.shell || scope?.workspace.split(/[\\/]/).at(-1) || '';
    $('terminalLocation').title = scope?.workspace || '';
    $('startTerminal').hidden = Boolean(entry && !entry.ended) || starting;
    $('startTerminal').textContent = entry ? '重新打开' : '启动终端';
    $('stopTerminal').hidden = !entry || entry.ended || !entry.id;
    $('terminalMessage').hidden = Boolean(entry && !entry.ended) && !starting;
    $('terminalMessage').textContent = starting ? '正在启动终端…' : entry?.ended ? `终端已退出 · 退出码 ${entry.exitCode}` : '在当前项目目录启动本机终端。';
    for (const value of entries.values()) value.host.hidden = value !== entry;
    if (!panel.hidden && entry) requestAnimationFrame(() => entry.view?.fit());
  }

  function ingest(entry, event) {
    if (event.type === 'data') {
      entry.view.write(event.text, () => {
        void api.terminal.acknowledge({ id: event.id, length: event.text.length }).catch(() => {});
      });
    }
    else if (event.type === 'exit') {
      entry.ended = true;
      entry.exitCode = event.exitCode;
      render();
    }
  }
  api.terminal.onEvent(event => {
    const entry = [...entries.values()].find(item => item.id === event.id);
    if (entry) ingest(entry, event);
    else if (starting) {
      if (!early.has(event.id)) early.set(event.id, []);
      const queue = early.get(event.id);
      if (queue.length < 24) queue.push(event);
    }
  });

  async function start() {
    if (starting || !scope || current()?.id && !current().ended) return;
    const target = scope;
    // Only keep live sessions and the transcript from the current exited session.
    for (const [workspace, session] of entries) {
      if (session.ended || workspace === target.workspace) {
        session.view.dispose();
        session.host.remove();
        entries.delete(workspace);
      }
    }
    const host = document.createElement('div');
    host.className = 'terminal-screen';
    const entry = { host };
    starting = true;
    $('terminalScreens').append(host);
    entries.set(target.workspace, entry);
    render();
    try {
      entry.view = window.xiaoxiaoTerminal.open(host, {
        onInput(text) {
          if (!entry.id || entry.ended) return;
          void api.terminal.write({ id: entry.id, text }).catch(error => { $('terminalMessage').hidden = false; $('terminalMessage').textContent = errorMessage(error); });
        },
        onResize(columns, rows) {
          if (entry.id && !entry.ended) void api.terminal.resize({ id: entry.id, columns, rows }).catch(() => {});
        }
      });
      const dimensions = entry.view.fit();
      Object.assign(entry, await api.terminal.open({ ...target, ...dimensions }));
      for (const event of early.get(entry.id) || []) ingest(entry, event);
      if (current() === entry && visible) entry.view.focus();
    } catch (error) {
      entry.view?.dispose();
      host.remove();
      entries.delete(target.workspace);
      starting = false;
      render();
      $('terminalMessage').textContent = errorMessage(error);
      return;
    } finally { early.clear(); starting = false; }
    render();
  }

  $('startTerminal').onclick = start;
  $('stopTerminal').onclick = async () => {
    const entry = current();
    if (!entry?.id || entry.ended) return;
    const workspace = scope.workspace;
    try { await api.terminal.close(entry.id); }
    catch (error) {
      $('terminalMessage').hidden = false;
      $('terminalMessage').textContent = errorMessage(error);
      return;
    }
    entry.view.dispose();
    entry.host.remove();
    entries.delete(workspace);
    render();
    if (!panel.hidden) $('startTerminal').focus();
  };
  $('hideTerminal').onclick = () => {
    visible = false;
    render();
    button.focus();
  };
  button.onclick = () => {
    visible = !visible;
    render();
    if (visible) {
      if (current()?.id && !current().ended) current().view.focus();
      else $('startTerminal').focus();
    }
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    for (const entry of entries.values()) entry.view?.updateTheme();
  });
  const resize = new ResizeObserver(() => { if (!panel.hidden) current()?.view?.fit(); });
  resize.observe(panel);
  return {
    setScope(target) {
      if (scope?.workspace !== target?.workspace) visible = false;
      scope = target;
      render();
    }
  };
}
