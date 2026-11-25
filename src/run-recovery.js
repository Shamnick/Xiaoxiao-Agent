const MAX_PARTIAL = 24000;
const MAX_TOOLS = 24;

function beginCheckpoint(userIndex, continuation) {
  const prior = continuation?.checkpoint;
  return {
    userIndex, originalUserIndex: prior?.originalUserIndex ?? userIndex,
    partial: prior?.partial || '', tools: (prior?.tools || []).slice(-MAX_TOOLS),
    clarifications: (prior?.clarifications || []).slice(-8),
    updates: (prior?.updates || []).slice(-24).map(update => ({ ...update, sent: true })),
    ...(prior?.artifacts?.length && { artifacts: [...prior.artifacts] })
  };
}

function recordTool(run, { name, eventId, phase, progress, outcome, workspaceFile }) {
  if (phase === 'start' || phase === 'skip') {
    run.tools.push(phase === 'skip' ? { name, finished: true, outcome: 'skipped' } : { name, finished: false, ...(eventId && { eventId }) });
    if (run.tools.length > MAX_TOOLS) run.tools.shift();
    return;
  }
  const tool = run.tools.findLast(entry => !entry.finished && entry.name === name && (!eventId || entry.eventId === eventId));
  if (!tool) return;
  if (phase === 'end') {
    tool.finished = true;
    if (outcome) tool.outcome = outcome;
    if (workspaceFile) tool.workspaceFile = workspaceFile;
  }
  if (phase === 'progress') tool.progress = progress;
}

function failRun(conversation, message, partial = conversation.pendingRun.partial) {
  const { pendingRun } = conversation;
  const messages = [...conversation.messages];
  messages[pendingRun.userIndex] = { ...messages[pendingRun.userIndex], failed: true };
  messages.push({ role: 'assistant', content: partial || '任务未完成', failed: true, error: message, ...(pendingRun.metrics && { metrics: pendingRun.metrics }), recovery: pendingRun, ...(pendingRun.artifacts && {artifacts: pendingRun.artifacts}) });
  const { pendingRun: _, ...previous } = conversation;
  return { ...previous, messages };
}

function resumeContext(conversation) {
  const last = conversation.messages.at(-1);
  const recovery = last?.failed && last.recovery;
  const request = recovery && conversation.messages[recovery.originalUserIndex];
  if (request?.role !== 'user') throw Error('当前会话没有可继续的任务');
  return {
    checkpoint: recovery,
    text: 'Continue the interrupted task using this saved context. Previous tool calls may already have changed files or external systems. Use savedFiles as delivery receipts. Treat unfinished calls as unknown and verify state before repeating any side-effecting operation. The user may need to reattach the original file.\n' + JSON.stringify({
      originalRequest: request.content,
      attachmentName: request.attachment,
      partialAnswer: recovery.partial,
      recentToolCalls: (recovery.tools || []).map(({ eventId, ...entry }) => entry),
      savedFiles: (recovery.artifacts || []).map(file => file.name),
      clarifications: recovery.clarifications || [],
      additionalUserInstructions: (recovery.updates || []).map(update => update.text)
    })
  };
}

module.exports = { MAX_PARTIAL, beginCheckpoint, recordTool, failRun, resumeContext };
