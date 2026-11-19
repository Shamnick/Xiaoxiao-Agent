'use strict';
const { createHash } = require('node:crypto');
const TIMEOUT = 30000;
const MAX_TOOLS = 128;
const MAX_BYTES = 1024 * 1024;

function jsonCopy(value, limit = MAX_BYTES) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit) throw new Error('MCP data exceeds size limit');
  return JSON.parse(text);
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function strings(value) { return record(value) && Object.values(value).every(v => typeof v === 'string'); }

class MCPManager {
  constructor({ configs = [], approve, signal } = {}) {
    if (!Array.isArray(configs) || configs.length > 32) throw new Error('MCP configs must be an array of at most 32 servers');
    this.configs = jsonCopy(configs);
    const ids = new Set();
    for (const config of this.configs) {
      if (!record(config)) throw new Error('Invalid MCP config');
      if (config.enabled === false) continue;
      if (typeof config.id !== 'string' || !config.id || config.id.length > 256 || ids.has(config.id)) throw new Error('MCP server id must be unique and nonempty');
      ids.add(config.id);
      if (config.name !== undefined && typeof config.name !== 'string') throw new Error('Invalid MCP server name');
      if (config.transport === 'stdio') {
        if (typeof config.command !== 'string' || !config.command.trim() || config.command.includes('\0') ||
            (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(a => typeof a === 'string' && !a.includes('\0')))) ||
            (config.env !== undefined && !strings(config.env))) throw new Error('Invalid MCP stdio config');
      } else if (config.transport === 'http') {
        const url = new URL(config.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash ||
            (config.headers !== undefined && !strings(config.headers))) throw new Error('Invalid MCP HTTP config');
      } else throw new Error('Invalid MCP transport');
    }
    this.approve = approve;
    this.controller = new AbortController();
    this.connections = new Set();
    this.closed = false;
    this.onAbort = () => { void this.close(); };
    this.signal = signal;
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }
  _check() {
    if (this.closed) throw new Error('MCP manager is closed');
    this.signal?.throwIfAborted();
    this.controller.signal.throwIfAborted();
  }
  // Bound even approvals and transports that fail to honor SDK request cancellation.
  async _bounded(operation) {
    this._check();
    const controller = new AbortController();
    const parent = this.controller.signal;
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => {
        const error = parent.reason instanceof Error ? parent.reason : new Error('MCP operation aborted');
        controller.abort(error); reject(error);
      };
      parent.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        const error = new Error('MCP operation timed out');
        controller.abort(error); reject(error);
      }, TIMEOUT);
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation({ signal: controller.signal, timeout: TIMEOUT, maxTotalTimeout: TIMEOUT, resetTimeoutOnProgress: false });
      }), interrupted]);
      this._check();
      return result;
    } finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
  }
  async _consent(title, detail) {
    if (detail.length > 13000) throw new Error('MCP approval detail exceeds full-preview limit');
    if (typeof this.approve !== 'function' || await this._bounded(() => this.approve({ title, detail })) !== true) throw new Error('MCP approval denied');
    this._check();
  }
  async _dispose(connection) {
    if (connection.closing) return connection.closing;
    connection.dead = true;
    connection.closing = (async () => {
      // The SDK stdio close ends stdin, then escalates to SIGTERM/SIGKILL.
      // Do not short-circuit it: cleanup must finish before close() resolves.
      const outcomes = await Promise.allSettled([connection.client.close(), connection.transport.close()]);
      this.connections.delete(connection);
      return outcomes;
    })();
    return connection.closing;
  }
  async tools() {
    this._check();
    if (!this.loading) this.loading = this._load();
    const result = await this.loading;
    this._check();
    // Callers may adapt descriptors, without changing the manager's internal schema.
    return result.map(tool => ({ ...tool, parameters: jsonCopy(tool.parameters) }));
  }
  async _load() {
    const tools = [];
    try {
      for (const config of this.configs) {
        if (config.enabled === false) continue;
        this._check();
        const label = config.name || config.id;
        const displayed = { ...config };
        for (const field of ['env', 'headers']) {
          if (displayed[field]) displayed[field] = Object.fromEntries(Object.keys(displayed[field]).map(key => [key, '[REDACTED]']));
        }
        if (displayed.url) {
          const safeURL = new URL(displayed.url);
          for (const key of [...safeURL.searchParams.keys()]) safeURL.searchParams.set(key, '[REDACTED]');
          displayed.url = safeURL.href;
        }
        await this._consent('Connect MCP server: ' + label, JSON.stringify(displayed));
        // Lazy require: disabled/no-server configurations work before SDK installation.
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        let transport;
        if (config.transport === 'stdio') {
          const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
          transport = new StdioClientTransport({ command: config.command, args: config.args || [], env: { PATH: ['/opt/homebrew/bin','/usr/local/bin',process.env.PATH || ''].join(require('node:path').delimiter), ...config.env }, stderr: 'ignore' });
        } else {
          const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
          transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers || {}, redirect: 'error' } });
        }
        const client = new Client({ name: 'workspace-agent', version: '1.0.0' }, { capabilities: {} });
        const connection = { client, transport, dead: false };
        this.connections.add(connection);
        await this._bounded(options => client.connect(transport, options));
        let cursor;
        const cursors = new Set(), names = new Set();
        let completed = false, bytes = 0;
        for (let page = 0; page < 8; page++) {
          const result = jsonCopy(await this._bounded(options => client.listTools(cursor ? { cursor } : {}, options)));
          bytes += Buffer.byteLength(JSON.stringify(result));
          if (bytes > MAX_BYTES || !Array.isArray(result.tools)) throw new Error('Invalid or oversized MCP tools list');
          for (const tool of result.tools) {
            if (tools.length >= MAX_TOOLS) throw new Error('MCP tool count exceeds 128');
            if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 1024 || names.has(tool.name) ||
                !record(tool.inputSchema) || tool.inputSchema.type !== 'object') throw new Error('Invalid MCP tool descriptor');
            names.add(tool.name);
            const remoteName = tool.name;
            const parameters = jsonCopy(tool.inputSchema, 65536);
            const hash = createHash('sha256').update(JSON.stringify([config.id, remoteName])).digest('hex').slice(0, 48);
            tools.push({
              name: 'mcp_' + hash,
              description: ('MCP ' + label + ': ' + remoteName + '. ' + (typeof tool.description === 'string' ? tool.description : '')).slice(0, 4096),
              parameters,
              execute: async (args = {}) => {
                this._check();
                if (connection.dead) throw new Error('MCP connection is closed');
                if (!record(args)) throw new Error('MCP arguments must be an object');
                // Freeze the approved input by copying it before awaiting UI approval.
                const approvedArgs = jsonCopy(args, 65536);
                await this._consent('Call MCP tool: ' + label + ' / ' + remoteName, JSON.stringify({ server: config.id, tool: remoteName, args: approvedArgs }));
                if (connection.dead) throw new Error('MCP connection is closed');
                try {
                  return jsonCopy(await this._bounded(options => client.callTool({ name: remoteName, arguments: approvedArgs }, undefined, options)));
                } catch (error) { await this._dispose(connection); throw error; }
              }
            });
          }
          if (!result.nextCursor) { completed = true; break; }
          if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) throw new Error('Invalid MCP pagination cursor');
          cursors.add(result.nextCursor); cursor = result.nextCursor;
        }
        if (!completed) throw new Error('MCP tools list exceeds 8 pages');
      }
      return tools;
    } catch (error) {
      await Promise.allSettled([...this.connections].map(connection => this._dispose(connection)));
      throw error;
    }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.controller.abort(new Error('MCP manager closed'));
    this.signal?.removeEventListener('abort', this.onAbort);
    this.closing = Promise.allSettled([...this.connections].map(connection => this._dispose(connection))).then(() => undefined);
    return this.closing;
  }
}
module.exports = { MCPManager };
