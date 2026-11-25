'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const maxTerminals = 3;
const batchLimit = 65536;
const dimensions = (columns, rows) => {
  if (!Number.isInteger(columns) || !Number.isInteger(rows)) throw Error('无效的终端尺寸');
  return { cols: Math.max(2, Math.min(columns, 400)), rows: Math.max(2, Math.min(rows, 160)) };
};

function shellForHost() {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: [] };
  const file = process.env.SHELL;
  if (file && path.isAbsolute(file)) {
    try { fs.accessSync(file, fs.constants.X_OK); return { file, args: [] }; }
    catch { /* Use the system shell if the configured shell disappeared. */ }
  }
  return { file: process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh', args: [] };
}

class TerminalSessions {
  constructor() {
    this.sessions = new Map();
  }

  open(owner, workspace, columns, rows, notify) {
    if (this.sessions.size >= maxTerminals) throw Error('最多同时打开三个终端，请先结束一个会话');
    const size = dimensions(columns, rows);
    if (fs.realpathSync(workspace) !== workspace || !fs.statSync(workspace).isDirectory()) throw Error('工作目录已移动，请重新选择');
    const id = randomUUID();
    const { file, args } = shellForHost();
    let process;
    try {
      process = require('node-pty').spawn(file, args, { ...size, cwd: workspace, name: 'xterm-256color' });
    } catch (error) {
      console.error('Terminal could not start:', error.message);
      throw Error('无法启动本机终端。请确认当前系统上的终端组件已正确安装。');
    }
    const item = { owner, process, pending: '', timer: null, inFlight: 0, paused: false };
    this.sessions.set(id, item);
    const flush = () => {
      clearTimeout(item.timer);
      item.timer = null;
      if (!item.pending || !this.sessions.has(id)) return;
      const text = item.pending;
      item.pending = '';
      item.inFlight += text.length;
      if (item.inFlight >= batchLimit * 2 && !item.paused) {
        item.paused = true;
        process.pause();
      }
      notify({ id, type: 'data', text });
    };
    item.data = process.onData(text => {
      item.pending += text;
      if (item.pending.length >= batchLimit) flush();
      else if (!item.timer) item.timer = setTimeout(flush, 16);
    });
    item.exit = process.onExit(({ exitCode }) => {
      flush();
      if (this.sessions.get(id) !== item) return;
      this.close(owner, id, false);
      notify({ id, type: 'exit', exitCode });
    });
    return { id, shell: path.basename(file), workspace };
  }

  write(owner, id, text) {
    const item = this.sessions.get(id);
    if (item?.owner !== owner) return;
    if (typeof text !== 'string' || text.length > 65536) throw Error('终端输入过长');
    item.process.write(text);
  }

  acknowledge(owner, id, length) {
    const item = this.sessions.get(id);
    if (item?.owner !== owner || !Number.isSafeInteger(length) || length <= 0 || length > item.inFlight) return;
    item.inFlight -= length;
    if (item.paused && item.inFlight <= batchLimit / 2) {
      item.paused = false;
      item.process.resume();
    }
  }

  resize(owner, id, columns, rows) {
    const item = this.sessions.get(id);
    if (item?.owner !== owner) return;
    const { cols, rows: height } = dimensions(columns, rows);
    item.process.resize(cols, height);
  }

  close(owner, id, kill = true) {
    const item = this.sessions.get(id);
    if (item?.owner !== owner) return;
    this.sessions.delete(id);
    clearTimeout(item.timer);
    item.data.dispose();
    item.exit.dispose();
    if (kill) {
      if (item.paused) item.process.resume();
      try { item.process.kill(); }
      catch (error) { if (error.code !== 'ESRCH') console.error('Terminal could not close:', error.message); }
    }
  }

  closeOwner(owner) {
    for (const [id, item] of this.sessions) if (item.owner === owner) this.close(owner, id);
  }
}

module.exports = { TerminalSessions };
