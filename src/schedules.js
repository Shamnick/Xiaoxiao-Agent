const { randomUUID } = require('node:crypto');

const MAX_SCHEDULES = 20;
const GRACE_MS = 5 * 60 * 1000;

function nextOccurrence(schedule, after) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const next = new Date(after);
  next.setHours(hour, minute, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (next.getTime() > after && (schedule.frequency === 'daily' || next.getDay() === schedule.weekday)) return next.getTime();
    next.setDate(next.getDate() + 1);
    next.setHours(hour, minute, 0, 0);
  }
  throw Error('无法计算下次运行时间');
}

function scheduleFields(raw) {
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 80) throw Error('任务名称需要 1 至 80 个字符');
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 16000) throw Error('任务说明需要 1 至 16000 个字符');
  if (typeof raw.providerId !== 'string' || !raw.providerId) throw Error('请选择模型');
  if (typeof raw.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) throw Error('请选择有效的本地时间');
  if (!['daily', 'weekly'].includes(raw.frequency)) throw Error('请选择重复周期');
  if (raw.frequency === 'weekly' && (!Number.isInteger(raw.weekday) || raw.weekday < 0 || raw.weekday > 6)) throw Error('请选择每周运行的日期');
  return {
    title: raw.title.trim(), prompt: raw.prompt.trim(), providerId: raw.providerId, projectId: raw.projectId || '',
    frequency: raw.frequency, weekday: raw.frequency === 'weekly' ? raw.weekday : 1, time: raw.time, enabled: raw.enabled === true
  };
}

class ScheduleBook {
  constructor(store, now = Date.now) { this.store = store; this.now = now; }
  list() { return this.store.read('schedules', []); }
  get(id) { return this.list().find(row => row.id === id); }
  update(id, transform) {
    const rows = this.list();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) return null;
    rows[index] = transform(rows[index]);
    this.store.write('schedules', rows);
    return rows[index];
  }
  save(raw) {
    const rows = this.list();
    const old = raw.id ? rows.find(row => row.id === raw.id) : null;
    if (raw.id && !old) throw Error('计划任务已移除');
    if (!old && rows.length >= MAX_SCHEDULES) throw Error(`最多可保存 ${MAX_SCHEDULES} 项计划任务`);
    const fields = scheduleFields(raw);
    const record = { ...old, ...fields, id: old?.id || randomUUID(), nextAt: fields.enabled ? nextOccurrence(fields, this.now()) : null };
    if (old) return this.update(old.id, () => record);
    this.store.write('schedules', [...rows, record]);
    return record;
  }
  remove(id) { this.store.write('schedules', this.list().filter(row => row.id !== id)); }
  begin(id, conversationId, consumeDue = false) {
    const now = this.now();
    return this.update(id, row => ({
      ...row,
      ...(consumeDue ? { nextAt: nextOccurrence(row, now) } : {}),
      lastRun: { state: 'running', at: now, conversationId }
    }));
  }
  finish(id, conversationId, failure) {
    const row = this.get(id);
    if (row?.lastRun?.conversationId !== conversationId) return;
    this.update(id, current => ({
      ...current, lastRun: { ...current.lastRun, state: failure ? 'failed' : 'completed', ...(failure ? { error: failure } : {}) }
    }));
  }
  recover() {
    for (const row of this.list()) if (row.lastRun?.state === 'running') this.finish(row.id, row.lastRun.conversationId, '应用退出，任务已中断');
  }
  due() {
    const now = this.now();
    const ready = [];
    for (const row of this.list()) {
      if (!row.enabled || !row.nextAt || row.nextAt > now) continue;
      if (now - row.nextAt <= GRACE_MS) ready.push(row);
      else this.update(row.id, current => ({ ...current, nextAt: nextOccurrence(current, now), missedAt: row.nextAt }));
    }
    return ready.sort((a, b) => a.nextAt - b.nextAt);
  }
}

module.exports = { ScheduleBook, nextOccurrence };
