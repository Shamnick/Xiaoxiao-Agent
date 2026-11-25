'use strict';

const formatMetric = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const compactFloor = new Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:1, roundingMode:'floor' });
function renderConversationMetrics(conversation, run) {
  const byId = id => document.getElementById(id);
  const bar = byId('conversationMetrics');
  const detail = byId('metricsDetail');
  const key = conversation?.id || '';
  if (bar.dataset.conversation !== key && detail.matches(':popover-open')) detail.hidePopover();
  bar.dataset.conversation = key;
  bar.hidden = !conversation?.messages?.length;
  if (bar.hidden) return;

  let rounds = 0, steps = 0, tokens = 0, reports = 0, fullReports = 0;
  let cacheRead = 0, cacheInput = 0, cacheReports = 0, legacy = 0, latest;
  let requests = 0, input = 0, inputReports = 0, output = 0, outputReports = 0, untrackedRequests = 0;
  function include(metrics) {
    latest = metrics;
    if (!metrics) { legacy++; return; }
    steps += metrics.steps;
    tokens += metrics.tokens;
    reports += metrics.reports;
    fullReports += metrics.fullReports;
    cacheRead += metrics.cacheRead;
    cacheInput += metrics.cacheInput;
    cacheReports += metrics.cacheReports;
    if (metrics.requests == null) untrackedRequests++;
    requests += metrics.requests ?? 0;
    input += metrics.input ?? 0;
    inputReports += metrics.inputReports ?? 0;
    output += metrics.output ?? 0;
    outputReports += metrics.outputReports ?? 0;
  }
  for (const message of conversation.messages) {
    if (message.role === 'user' && !Number.isInteger(message.resumedFrom)) rounds++;
    if (message.role === 'assistant') include(message.metrics);
  }
  if (conversation.pendingRun) include(run?.metrics || conversation.pendingRun.metrics);

  const rate = latest?.rate;
  const budget = latest?.budget;
  const pct = budget > 0 ? Math.round(latest.size / budget * 100) : null;
  const cachePct = cacheInput > 0 ? Math.round(cacheRead / cacheInput * 100) : null;
  const value = (id, text) => { byId(id).textContent = text; };
  value('metricRounds', rounds);
  value('metricSteps', legacy ? (steps ? '≥' + steps : '—') : steps);
  value('metricRate', rate != null ? formatMetric.format(rate) : '—');
  const partial = legacy || untrackedRequests || fullReports < requests || reports > fullReports;
  // A compact rounded figure must not overstate a lower bound.
  value('metricTokens', reports ? (partial ? '≥' + compactFloor.format(tokens) : formatMetric.format(tokens)) : '—');
  value('metricCache', cachePct !== null ? cachePct + '%' : '—');
  value('metricContext', pct !== null ? '≈' + pct + '%' : '—');
  byId('metricArc').setAttribute('stroke-dasharray', Math.min(100, pct ?? 0) + ' 100');
  value('metricExecutionNote', rounds + ' 轮提问，已记录 ' + steps + ' 个模型执行步骤，含并行分析。补充和恢复计入原轮。');
  const duration = value => value == null ? '—' : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(2) + ' s';
  value('metricFirstBody', duration(latest?.firstBodyMs) + ' · 主请求发出至首段正文到达');
  value('metricElapsed', duration(latest?.elapsedMs) + ' · 最近结束的主请求，含等待和接收');
  value('metricBreakdown', (inputReports ? input.toLocaleString('zh-CN') : '—') + ' / ' +
    (outputReports ? output.toLocaleString('zh-CN') : '—') + ' tok。输入有 ' + inputReports + ' 次上报，输出有 ' + outputReports + ' 次上报。');
  value('metricCoverage', (untrackedRequests || legacy ? '部分历史缺少请求计数。' : '') +
    (requests ? fullReports + ' / ' + requests + ' 次请求收到完整用量。含并行、重试和中断。' : '暂无可核对的请求记录。'));
  value('metricRateNote', (rate != null ? rate.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' tok/s。' : '暂无速度数据。') +
    '最近主模型请求的输出 token 除以请求耗时，含等待首字的时间。');
  value('metricUsageNote', (reports ? tokens.toLocaleString('zh-CN') + ' 个已上报的 token。' : '暂无接口用量报告。') +
    '合计模型输入与输出。' + (partial ? '部分请求或历史记录缺少完整用量。' : ''));
  value('metricCacheNote', cacheReports ? cacheRead.toLocaleString('zh-CN') + ' 个缓存读取 token / ' +
    cacheInput.toLocaleString('zh-CN') + ' 个输入 token，仅统计提供缓存数据的步骤。' : '接口尚未提供可计算命中率的缓存用量。');
  value('metricContextNote', (budget ? latest.size.toLocaleString('zh-CN') + ' / ' + budget.toLocaleString('zh-CN') + '。' : '') +
    '最近主请求占本地上下文整理预算的比例，按文本长度和图像权重估算。');
  const button = byId('metricsToggle');
  button.setAttribute('aria-label', '查看会话统计详情，' + button.textContent.trim().replace(/\s+/g, ' ') + ' 上下文占用');
}
