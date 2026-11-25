'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspect, workspaceDiff, applyReviewedWrite } = require('./workspace-review');
const { searchWorkspace } = require('./workspace-search');
const { relativeSegments } = require('./workspace-files');
const { replaceUnique } = require('./workspace-editor');
const { verifyWrittenText } = require('./write-verification');
const LIMIT = 64 * 1024;

// Containment applies to file tools. Commands run with user privileges; cwd is not a sandbox.
async function createTools({ workspace, approve, signal, mcp, onWrite, readOnly = false } = {}) {
  if (workspace === undefined || workspace === null || workspace === '') {
    return mcp && !readOnly ? await mcp.tools() : [];
  }
  const root = await fs.realpath(workspace);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Workspace must be a directory');
  const check = () => signal?.throwIfAborted();
  const contained = value => {
    const relative = path.relative(root, value);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Path is outside workspace');
    }
    return value;
  };
  async function resolve(value = '.') {
    check();
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid path');
    const target = contained(path.resolve(root, value));
    return contained(await fs.realpath(target));
  }
  async function consent(title, detail, review) {
    check();
    if (typeof approve !== 'function' || await approve({ title, detail, ...(review && { review }) }) !== true) {
      throw Object.assign(new Error('Approval denied'), { code: 'APPROVAL_DENIED' });
    }
    check();
  }
  const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const string = { type: 'string' };
  async function changeFile(value, nextContent, { fullPreview }) {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid path');
    const candidate = contained(path.resolve(root, value));
    const parent = await resolve(path.dirname(candidate));
    const target = contained(path.join(parent, path.basename(candidate)));
    const relative = path.relative(root, target).split(path.sep).join('/');
    if (!relativeSegments(relative).length) throw new Error('Invalid file target');
    async function verifyParent() {
      check();
      try {
        if (await fs.realpath(root) === root && await resolve(path.dirname(candidate)) === parent) return;
      } catch (error) { check(); }
      throw Object.assign(new Error('工作目录已变更。请重新选择工作目录。'), { code: 'WORKSPACE_CHANGED' });
    }
    let review, bytesWritten, verification;
    try {
      const before = await inspect(target, signal);
      const content = nextContent(before);
      bytesWritten = Buffer.byteLength(content);
      if (bytesWritten > LIMIT) throw new Error('Result exceeds 64 KiB');
      if (before && before.text === content) return { path: relative, bytesWritten: 0, unchanged: true };
      review = { ...workspaceDiff(relative, before?.text ?? null, content), workspace: root };
      const title = fullPreview ? 'Write workspace file (' + bytesWritten + ' bytes, full preview)' : 'Edit workspace file';
      const detail = 'Path: ' + relative + '\nUTF-8 bytes: ' + bytesWritten + (fullPreview ? '\nFull content:\n' + content : '');
      if (detail.length > 13000) throw new Error('Write approval detail exceeds full-preview limit');
      await consent(title, detail, review);
      await applyReviewedWrite({ target, content, before, verifyParent, signal });
      verification = await verifyWrittenText(target, content, verifyParent);
    } catch (error) {
      if (error.code === 'WORKSPACE_CHANGED' || error.code === 'APPROVAL_DENIED') error.workspaceFile = relative;
      throw error;
    }
    onWrite?.(review);
    return { path: relative, bytesWritten, verification };
  }
  const tools = [
    {
      name: 'search_workspace', parallelRead: true, description: 'Find filenames or literal text across the selected workspace. Returns relative paths, matching lines and excerpts. Skips common caches, secret files and ignored untracked Git files. If limited, narrow the query.',
      parameters: schema({ query: { type: 'string', minLength: 1, maxLength: 200 }, kind: { type: 'string', enum: ['files', 'content'] } }, ['query']),
      execute: input => searchWorkspace(root, { ...input, signal })
    },
    {
      name: 'read_file', parallelRead: true, description: 'Read a UTF-8 file in the workspace. Use max_bytes for shorter excerpts and continue at next_offset_bytes while truncated.',
      parameters: schema({ path: string, offset_bytes: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 4, maximum: LIMIT } }, ['path']),
      async execute({ path: value, offset_bytes = 0, max_bytes = LIMIT } = {}) {
        if (!Number.isSafeInteger(offset_bytes) || offset_bytes < 0 || !Number.isInteger(max_bytes) || max_bytes < 4 || max_bytes > LIMIT) throw Error('Invalid read range');
        const target = await resolve(value);
        const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw new Error('Path must be a regular file');
          if (offset_bytes > stat.size) throw Error('Read offset exceeds file size');
          const buffer = Buffer.alloc(max_bytes + 1);
          let size = 0;
          while (size < buffer.length) {
            check();
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, offset_bytes + size);
            if (!bytesRead) break;
            size += bytesRead;
          }
          const truncated = size > max_bytes;
          let end = Math.min(size, max_bytes);
          // Preserve character boundaries so adjacent pages concatenate losslessly.
          while (truncated && end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
          const chunk = buffer.subarray(0, end);
          if ((truncated && !end) || !require('node:buffer').isUtf8(chunk)) throw Error('Expected a UTF-8 file and a character-aligned offset');
          return { path: path.relative(root, target), content: chunk.toString('utf8'), truncated,
            ...(truncated && { next_offset_bytes: offset_bytes + end }) };
        } finally { await file.close(); }
      }
    },
    {
      name: 'list_files', parallelRead: true, description: 'List at most 500 direct workspace directory entries; does not follow symlinks.',
      parameters: schema({ path: string }),
      async execute({ path: value = '.' } = {}) {
        const target = await resolve(value);
        const entries = [];
        let truncated = false;
        const dir = await fs.opendir(target);
        for await (const entry of dir) {
          check();
          if (entries.length === 500) { truncated = true; break; }
          entries.push({ name: entry.name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return { path: path.relative(root, target) || '.', entries, truncated };
      }
    },
    {
      name: 'write_file', description: 'Write UTF-8 text (up to 12 KiB) to an existing workspace directory after the user reviews the change. Prefer edit_file for targeted edits to existing code.',
      parameters: schema({ path: string, content: string }, ['path', 'content']),
      async execute({ path: value, content } = {}) {
        if (typeof content !== 'string' || content.includes('\0')) throw new Error('Invalid content');
        if (Buffer.byteLength(content) > 12 * 1024) throw new Error('Write exceeds 12 KiB');
        return changeFile(value, () => content, { fullPreview: true });
      }
    },
    {
      name: 'edit_file', description: 'Apply up to eight exact text replacements to an existing UTF-8 file up to 64 KiB. Copy each old_text exactly from the file and include enough context for a unique match. All edits are reviewed together before writing.',
      parameters: schema({ path: string, edits: { type: 'array', minItems: 1, maxItems: 8, items: schema({
        old_text: { type: 'string', minLength: 1, maxLength: 12000 }, new_text: { type: 'string', maxLength: 12000 }
      }, ['old_text', 'new_text']) } }, ['path', 'edits']),
      execute: ({ path: value, edits } = {}) => changeFile(value, before => replaceUnique(before?.text, edits), { fullPreview: false })
    },
    {
      name: 'run_command', description: 'Run an approved shell command in the workspace. NO OS SANDBOX: commands can access files and network with your user privileges. Combined output capped at 64 KiB; timeout at most 60 seconds.',
      parameters: schema({ command: string, timeout_ms: { type: 'integer', minimum: 1, maximum: 60000, default: 15000 } }, ['command']),
      async execute({ command, timeout_ms = 15000 } = {}) {
        if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 12000) throw new Error('Invalid command');
        if (!Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 60000) throw new Error('Invalid timeout_ms');
        const detail = 'NO OS SANDBOX. Runs with your user privileges; can access files outside workspace and network.\nCwd: ' + root + '\nTimeout ms: ' + timeout_ms + '\nFull command:\n' + command;
        if (detail.length > 13000) throw new Error('Command approval detail exceeds full-preview limit');
        await consent('Run shell command — no OS sandbox', detail);
        // Recheck the canonical workspace after the approval UI returns.
        if (await fs.realpath(root) !== root) throw new Error('Workspace changed');
        check();
        return new Promise((resolvePromise, reject) => {
          const child = spawn(command, { cwd: root, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
          let bytes = 0, failure, killer, settled = false;
          const stdout = [], stderr = [];
          function kill(kind) {
            try {
              if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind);
              else child.kill(kind);
            } catch (error) { if (error.code !== 'ESRCH') child.kill(kind); }
          }
          function stop(error) {
            if (failure || settled) return;
            failure = error;
            kill('SIGTERM');
            killer = setTimeout(() => { kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); finish(); }, 250);
          }
          function finish(code, terminationSignal) {
            if (settled) return;
            settled = true;
            clearTimeout(timer); clearTimeout(killer);
            signal?.removeEventListener('abort', abort);
            if (failure) { kill('SIGKILL'); reject(failure); }
            else resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code, signal: terminationSignal });
          }
          const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('Command aborted'));
          const timer = setTimeout(() => stop(new Error('Command timed out')), timeout_ms);
          for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
            stream.on('data', chunk => {
              const remaining = LIMIT - bytes;
              if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
              bytes += chunk.length;
              if (bytes > LIMIT) stop(new Error('Command output exceeds 64 KiB'));
            });
          }
          child.on('error', error => { failure = error; finish(); });
          child.on('close', finish);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    }
  ];
  if (readOnly) return tools.filter(tool => ['read_file', 'list_files', 'search_workspace'].includes(tool.name));
  if (mcp) tools.push(...await mcp.tools());
  return tools;
}
module.exports = { createTools };
