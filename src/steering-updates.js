'use strict';

const SteeringUpdates = (() => {
  function label(update, running) {
    if (update.delivery === 'accepted') return '模型服务已响应';
    if (update.delivery === 'requested') return running ? '正在等待服务响应' : '未确认服务响应';
    if (update.sent) return '已加入模型请求（旧记录）';
    return running ? '已排队，等待下一次请求' : '本轮未发出';
  }

  function title(update, running) {
    return (update.immediate ? '立即改向' : '补充要求') + ' · ' + label(update, running);
  }

  // Recovered instructions are already part of resumeContext's input. Only
  // newly queued instructions need to be appended to the model's context.
  function track(updates, save, publish, transport = fetch) {
    const inherited = updates.length;
    let included = inherited;
    const changed = () => { save(); publish(); };
    function enqueue(update) {
      if (updates.length - inherited >= 8) throw Error('此轮补充要求已达到 8 条');
      updates.push(update);
      try { save(); }
      catch (error) { updates.pop(); throw error; }
      publish();
    }
    function take() {
      const pending = updates.slice(included);
      included = updates.length;
      return pending.map(update => update.text).join('\n\n');
    }
    async function request(url, init) {
      init.signal?.throwIfAborted();
      // Freeze membership for this attempt: arrivals while fetch is pending
      // cannot have been included in its already serialized body.
      const batch = updates.slice(0, included).filter(update => update.delivery !== 'accepted');
      const fresh = batch.filter(update => update.delivery !== 'requested');
      if (fresh.length) {
        for (const update of fresh) update.delivery = 'requested';
        changed();
      }
      const response = await transport(url, init);
      if (response.ok && !init.signal?.aborted && batch.length) {
        for (const update of batch) Object.assign(update, { delivery: 'accepted', sent: true });
        changed();
      }
      return response;
    }
    return { enqueue, take, request };
  }
  return { title, track };
})();
if (typeof module !== 'undefined') module.exports = SteeringUpdates;
