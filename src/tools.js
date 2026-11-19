'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const LIMIT = 64 * 1024;

// Containment applies to file tools. Commands run with user privileges; cwd is not a sandbox.
async function createTools({ workspace, approve, signal, mcp } = {}) {
  if (workspace === undefined || workspace === null || workspace === '') {
    return mcp ? await mcp.tools() : [];
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
  async function consent(title, detail) {
    check();
    if (typeof approve !== 'function' || await approve({ title, detail }) !== true) {
      throw new Error('Approval denied');
    }
    check();
  }
  const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const string = { type: 'string' };
  const tools = [
    {
      name: 'read_file', description: 'Read up to 64 KiB of a UTF-8 file inside the workspace.',
      parameters: schema({ path: string }, ['path']),
      async execute({ path: value } = {}) {
        const target = await resolve(value);
        const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw new Error('Path must be a regular file');
          const buffer = Buffer.alloc(LIMIT + 1);
          let size = 0;
          while (size < buffer.length) {
            check();
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
          }
          return { path: path.relative(root, target), content: buffer.subarray(0, Math.min(size, LIMIT)).toString('utf8'), truncated: size > LIMIT };
        } finally { await file.close(); }
      }
    },
    {
      name: 'list_files', description: 'List at most 500 direct workspace directory entries; does not follow symlinks.',
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
      name: 'write_file', description: 'Write UTF-8 text (up to 12 KiB) to an existing workspace directory, after approval.',
      parameters: schema({ path: string, content: string }, ['path', 'content']),
      async execute({ path: value, content } = {}) {
        if (typeof value !== 'string' || !value || value.includes('\0') || typeof content !== 'string') throw new Error('Invalid path or content');
        if (Buffer.byteLength(content) > 12 * 1024) throw new Error('Write exceeds 12 KiB');
        const candidate = contained(path.resolve(root, value));
        const parent = await resolve(path.dirname(candidate));
        const target = contained(path.join(parent, path.basename(candidate)));
        // Reject final symlinks, including dangling ones, instead of following on create.
        async function validate() {
          check();
          contained(await fs.realpath(parent));
          try {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Write target must be a regular file, not a symlink');
            contained(await fs.realpath(target));
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await validate();
        const detail = 'Path: ' + path.relative(root, target) + '\nUTF-8 bytes: ' + Buffer.byteLength(content) + '\nFull content:\n' + content;
        if (detail.length > 13000) throw new Error('Write approval detail exceeds full-preview limit');
        await consent('Write workspace file (' + Buffer.byteLength(content) + ' bytes, full preview)', detail);
        await validate();
        const file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink > 1) throw new Error('Write target must be a regular file without hard links');
          check();
          await file.truncate(0);
          await file.writeFile(content, { encoding: 'utf8', signal });
        } finally { await file.close(); }
        return { path: path.relative(root, target), bytesWritten: Buffer.byteLength(content) };
      }
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
  if (mcp) tools.push(...await mcp.tools());
  return tools;
}
module.exports = { createTools };
