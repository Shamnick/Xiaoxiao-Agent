'use strict';

const creationMetrics = (() => {
  const labels = {prepare:'准备请求', submit:'等待服务响应', headers:'收到响应头', receive:'接收接口响应', asset:'下载图像', render:'服务端生成', pollReceive:'读取任务状态'};
  function duration(ms) {
    if (ms < 10000) return (ms / 1000).toFixed(1) + ' 秒';
    const secs = Math.floor(ms / 1000);
    return secs < 60 ? secs + ' 秒' : Math.floor(secs / 60) + ' 分 ' + secs % 60 + ' 秒';
  }
  function bytes(n) {
    if (n < 1024) return n + ' B';
    return n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(1) + ' MiB';
  }
  function create(item) {
    const card = document.createElement('section');
    card.className = 'creation-telemetry';
    card.setAttribute('aria-label', '本轮实测');
    // Fixed markup only. Provider and model data are always set via textContent.
    card.innerHTML = '<header><strong class="telemetry-phase"></strong><span class="telemetry-model"></span></header><progress aria-label="当前响应传输进度"></progress><dl></dl>';
    card.querySelector('.telemetry-model').textContent = item.modelLabel || '';
    return card;
  }
  function update(item, elapsed) {
    const card = document.getElementById('creation-' + item.id)?.querySelector('.creation-telemetry');
    if (!card) return;
    const m = item.metrics;
    const live = item.state === 'running';
    const part = live && ['receive','asset'].includes(m.phase) && m.partTotal > 0;
    const heading = card.querySelector('strong');
    const status = live ? labels[m.phase] || '处理中' :
      ({done:'生成完成', failed:'生成失败', stopped:'已停止'})[item.state] || '运行记录';
    const serverPercent = live && m.phase === 'render' && m.percent != null;
    const title = serverPercent ? status + ' · ' + m.percent + '%' : part ? status + ' · ' + Math.floor(m.partBytes / m.partTotal * 100) + '%' : status;
    if (heading.textContent !== title) heading.textContent = title;
    const progress = card.querySelector('progress');
    progress.hidden = !live;
    progress.setAttribute('aria-label', serverPercent ? '服务端生成进度' : '当前响应传输进度');
    if (serverPercent) { progress.max = 100; progress.value = m.percent; }
    else if (part) { progress.max = m.partTotal; progress.value = m.partBytes; }
    else progress.removeAttribute('value');
    const values = [
      ['本轮耗时', live ? duration(elapsed) : m.elapsed != null ? duration(m.elapsed) : null],
      ['响应头耗时', m.headersMs != null ? duration(m.headersMs) : null],
      ['HTTP', m.httpStatus],
      ['累计接收', m.received != null ? bytes(m.received) : null],
      ['输出', m.outputs != null ? m.outputs + ' 张 · ' + bytes(m.outputBytes) : null],
      ['服务端 tokens', m.tokens],
      ['状态查询', m.attempt ? m.attempt + ' 次' : null],
      ['开始时间', new Date(m.startedAt).toLocaleTimeString('zh-CN', {hour12:false})],
      ['请求尺寸', item.fields?.generationImageSize || '模型默认'],
      ['排队用时', m.queuedMs >= 500 ? duration(m.queuedMs) : null]
    ];
    const dl = card.querySelector('dl');
    for (const [i, [label, value]] of values.entries()) {
      if (value == null) continue;
      let cell = dl.querySelector('[data-metric="' + i + '"]');
      if (!cell) {
        cell = document.createElement('div');
        cell.dataset.metric = i;
        const dt = document.createElement('dt');
        dt.textContent = label;
        cell.append(dt, document.createElement('dd'));
        const after = [...dl.children].find(row => Number(row.dataset.metric) > i);
        dl.insertBefore(cell, after || null);
      }
      const dd = cell.lastChild;
      if (dd.textContent !== String(value)) dd.textContent = value;
    }
  }
  return {create, update};
})();
