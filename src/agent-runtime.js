'use strict';

const Ajv = require('ajv');
const { randomUUID } = require('node:crypto');
const { AgentContext, DEFAULT_BUDGET, excerpt } = require('./agent-context');

function validateBatch(calls, registry) {
  if (calls.length > 16) throw Error('单轮工具请求过多');
  const ids = new Set();
  for (const call of calls) {
    if (!call.id || ids.has(call.id) || !registry.get(call.name)?.validate(call.args)) throw Error('工具调用参数无效');
    ids.add(call.id);
  }
}

function exchangeMessages(anthropic, result, outputs) {
  if (anthropic) return [{ role: 'assistant', content: result.content }, { role: 'user', content: outputs }];
  return [{
    role: 'assistant', content: result.text || null,
    ...(result.reasoning && { reasoning_content: result.reasoning }),
    tool_calls: result.calls.map(c => ({
      id: c.id, type: 'function', function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args) },
      ...(c.extra_content && { extra_content: c.extra_content })
    }))
  }, ...outputs.map(o => ({ role: 'tool', tool_call_id: o.tool_use_id, content: o.content }))];
}

async function execute(call, tool, signal, onEvent) {
  const { name } = call;
  const eventId = randomUUID();
  const fileChange = name === 'write_file' || name === 'edit_file';
  onEvent({ type: 'tool', eventId, name, phase: 'start', detail: JSON.stringify(call.args).slice(0, 4000) });
  let text, outcome, workspaceFile, filename;
  try {
    const value = await tool.execute(call.args);
    text = typeof value === 'string' ? value : JSON.stringify(value);
    if (fileChange) {
      workspaceFile = value.path;
      if (value.unchanged) outcome = 'unchanged';
    }
    if (name === 'save_artifact') {
      if (value.saved) filename = value.filename;
      if (value.canceled) outcome = 'canceled';
    }
    if (fileChange || name === 'save_artifact') {
      if (value.verification === 'matched') outcome = 'verified';
      if (value.verification === 'unconfirmed') outcome = 'unconfirmed';
    }
    if (name === 'run_command') outcome = value.code === 0 && !value.signal ? 'exited' : 'command_failed';
  } catch (error) {
    if (signal?.aborted) throw error;
    text = '工具执行失败：' + error.message;
    outcome = error.code === 'APPROVAL_DENIED' ? 'denied' : error.code === 'WORKSPACE_CHANGED' && fileChange ? 'conflict' : 'failed';
    if (fileChange) workspaceFile = error.workspaceFile;
  }
  text = excerpt(String(text), 100000);
  onEvent({ type: 'tool', eventId, name, phase: 'end', detail: text.slice(0, 4000), outcome, workspaceFile });
  return {
    result: { type: 'tool_result', tool_use_id: call.id, content: text, ...(['denied','conflict','failed','command_failed'].includes(outcome) && { is_error: true }) },
    receipt: { name, outcome: outcome || 'returned', ...(workspaceFile && { workspaceFile }), ...(filename && { filename }) }
  };
}

// Only the host marks local, independent reads as shareable. Every other tool
// creates a barrier, including commands, MCP calls and all user interactions.
async function dispatchBatch(calls, registry, signal, onEvent, pullUpdate) {
  const results = [];
  for (let index = 0; index < calls.length;) {
    signal?.throwIfAborted();
    if (pullUpdate()) {
      for (const call of calls.slice(index)) {
        onEvent({ type: 'tool', name: call.name, phase: 'skip', outcome: 'skipped' });
        results.push({
          result: { type: 'tool_result', tool_use_id: call.id, content: 'Skipped before execution because new user instructions arrived.', is_error: true },
          receipt: { name: call.name, outcome: 'skipped' }
        });
      }
      break;
    }
    let end = index + 1;
    if (registry.get(calls[index].name).parallelRead === true) {
      while (end < calls.length && end - index < 3 && registry.get(calls[end].name).parallelRead === true) end++;
    }
    const group = calls.slice(index, end);
    const settled = await Promise.allSettled(group.map(call => execute(call, registry.get(call.name), signal, onEvent)));
    for (const item of settled) {
      if (item.status === 'rejected') throw item.reason;
      results.push(item.value);
    }
    index = end;
  }
  return results;
}

async function driveAgent(turn, p, messages, {
  tools = [], system = '', signal, request = fetch, onEvent = () => {}, maxSteps = 12, takeUserUpdate = () => '', setInterrupt = () => {}, onMetric
} = {}) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const registry = new Map(tools.map(t => [t.name, { ...t, validate: ajv.compile(t.parameters) }]));
  const context = new AgentContext(messages, system.length + JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))).length);
  const anthropic = p.kind === 'anthropic';
  let total = '', extraTurns = 0, budget = DEFAULT_BUDGET;
  const addUpdate = text => {
    context.add('input', [{ role: 'user', content: text }]);
    extraTurns = Math.min(8, extraTurns + 1);
  };
  for (let step = 0; step < maxSteps + extraTurns; step++) {
    signal?.throwIfAborted();
    const queued = takeUserUpdate();
    if (queued) addUpdate(queued);
    const status = text => onEvent({ type: 'status', text, step: step + 1 });
    const prepared = context.prepare(budget);
    status(prepared.reduced ? '已整理长任务上下文' : p.stream === false ? '已关闭流式输出，等待完整回复' : '等待模型响应');
    let firstText = true;
    const onText = text => {
      if (firstText) { firstText = false; status('正在接收正文'); }
      total += text;
      onEvent({ type: 'text', text });
    };
    // An immediate edit cancels only the current inference. Tool execution keeps
    // the run signal so an already committed operation is never replayed.
    const inference = new AbortController();
    const inferenceSignal = signal ? AbortSignal.any([signal, inference.signal]) : inference.signal;
    const invoke = (projection, kind) => {
      onMetric?.({ kind, size: projection.size, budget });
      let start, firstBodyMs = null;
      const measuredRequest = onMetric ? (...args) => {
        onMetric({ kind: 'attempt' });
        start = performance.now();
        return request(...args);
      } : request;
      return turn(p, projection.messages, tools, system, inferenceSignal, measuredRequest,
        text => {
          if (inferenceSignal.aborted) return;
          if (onMetric && firstBodyMs === null && text) {
            firstBodyMs = performance.now() - start;
            onMetric({ kind: 'first-body', firstBodyMs });
          }
          onText(text);
        },
        message => { if (!inferenceSignal.aborted) status(message); },
        onMetric && ((usage, complete, preview) => onMetric({ kind: preview ? 'preview' : 'usage', usage, complete, elapsedMs: performance.now() - start })))
        .finally(() => { if (onMetric && start !== undefined) onMetric({ kind: 'settled', elapsedMs: performance.now() - start }); });
    };
    setInterrupt(() => inference.abort());
    let result;
    try {
      try { result = await invoke(prepared, 'step'); }
      catch (error) {
        if (error.code !== 'CONTEXT_OVERFLOW' || inferenceSignal.aborted) throw error;
        budget = Math.floor(prepared.size / 2);
        const retry = context.prepare(budget);
        if (!retry.reduced) throw error;
        status('上下文超限，已精简并重新请求');
        result = await invoke(retry, 'context');
      }
      inferenceSignal.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (!inference.signal.aborted) throw error;
      const revision = takeUserUpdate();
      if (!revision) throw error;
      addUpdate(revision);
      status('已停止上一轮生成，正在按新要求继续');
      if (!firstText) onText('\n\n');
      continue;
    } finally { setInterrupt(null); }
    signal?.throwIfAborted();
    let update = takeUserUpdate();
    if (!result.calls.length) {
      if (!update) return total;
      context.add('reply', [{ role: 'assistant', content: anthropic ? result.content : result.text,
        ...(!anthropic && result.reasoning && { reasoning_content: result.reasoning }) }]);
      addUpdate(update);
      onText('\n\n');
      continue;
    }
    validateBatch(result.calls, registry);
    const completed = await dispatchBatch(result.calls, registry, signal, onEvent, () => (update ||= takeUserUpdate()));
    const messages = exchangeMessages(anthropic, result, completed.map(item => item.result));
    context.add('exchange', messages, completed.map(item => item.receipt));
    update ||= takeUserUpdate();
    if (update) addUpdate(update);
  }
  throw Error('已达到工具执行步数上限，请拆分任务后继续');
}

module.exports = { driveAgent };
