'use strict';

// Only non-negative integer token counts have a defined provider meaning.
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeUsage(kind, usage) {
  let input, output, cached, total;
  if (kind === 'anthropic') {
    input = count(usage.input_tokens);
    output = count(usage.output_tokens);
    cached = count(usage.cache_read_input_tokens);
    if (input !== null) input += (cached ?? 0) + (count(usage.cache_creation_input_tokens) ?? 0);
  } else {
    input = count(usage.prompt_tokens);
    output = count(usage.completion_tokens);
    cached = count(usage.prompt_tokens_details?.cached_tokens) ?? count(usage.prompt_cache_hit_tokens);
    total = count(usage.total_tokens);
  }
  return {
    total: total ?? (input !== null && output !== null ? input + output : null),
    output, input, cached: input !== null && cached !== null && cached <= input ? cached : null
  };
}

function emptyMetrics() {
  return { steps: 0, tokens: 0, reports: 0, fullReports: 0, cacheInput: 0, cacheRead: 0, cacheReports: 0,
    requests: 0, input: 0, inputReports: 0, output: 0, outputReports: 0,
    firstBodyMs: null, elapsedMs: null, rate: null, size: null, budget: null };
}

// Each invocation reports usage at most once, including any partial report on interruption.
function applyMetric(metrics, event, worker = false) {
  if (event.kind === 'step' || event.kind === 'context') {
    if (event.kind === 'step') metrics.steps++;
    if (!worker) {
      metrics.size = event.size;
      metrics.budget = event.budget;
      metrics.rate = null;
      metrics.firstBodyMs = null;
      metrics.elapsedMs = null;
    }
    return;
  }
  if (event.kind === 'attempt') {
    metrics.requests++;
    return;
  }
  if (event.kind === 'first-body' || event.kind === 'settled') {
    if (!worker) {
      if (event.kind === 'first-body') metrics.firstBodyMs = event.firstBodyMs;
      else metrics.elapsedMs = event.elapsedMs;
    }
    return;
  }
  const { total, input, cached, output } = event.usage;
  if (input !== null) { metrics.input += input; metrics.inputReports++; }
  if (output !== null) { metrics.output += output; metrics.outputReports++; }
  if (total !== null) {
    metrics.tokens += total;
    metrics.reports++;
    if (event.complete) metrics.fullReports++;
  }
  if (cached !== null && input !== null) {
    metrics.cacheInput += input;
    metrics.cacheRead += cached;
    metrics.cacheReports++;
  }
  if (!worker && (event.complete || event.kind === 'preview') && output !== null && event.elapsedMs > 0) {
    metrics.rate = output * 1000 / event.elapsedMs;
  }
}

module.exports = { normalizeUsage, emptyMetrics, applyMetric };
