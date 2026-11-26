'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'artifacts', 'phase-five');
const ledger = path.join(dir, 'beta.json');
const week = 7 * 24 * 60 * 60 * 1000;
const statuses = ['pending', 'independent', 'assisted', 'failed', 'withdrew'];
const fields = ['id', 'startedAt', 'firstDelivery', 'secondProjectAt', 'followUp'];
const template = {participants:[]};

function instant(value, field, now) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
      !Number.isFinite(time) || time > now) throw Error('请核对 ' + field + ' 的时间和时区。');
  return time;
}

function summarize(data, now = Date.now()) {
  if (!data || !Array.isArray(data.participants) || Object.keys(data).some(key => key !== 'participants')) {
    throw Error('记录格式应为含 participants 数组的对象。');
  }
  const seen = new Set();
  const counts = { enrolled:0, independent:0, assisted:0, failed:0, pending:0, withdrew:0,
    reused:0, closed:0, observing:0, missed:0 };
  for (const row of data.participants) {
    if (!row || Object.keys(row).some(key => !fields.includes(key)) || !/^P\d{2,4}$/.test(row.id) || seen.has(row.id)) {
      throw Error('请使用唯一的匿名编号 P01 等，并核对记录字段。');
    }
    seen.add(row.id);
    if (!statuses.includes(row.firstDelivery) || !['open','confirmed','lost'].includes(row.followUp)) {
      throw Error(row.id + ' 的交付或回访状态无效。');
    }
    const start = instant(row.startedAt, row.id + ' startedAt', now);
    const mature = now - start >= week;
    if (row.followUp === 'lost' && !mature) throw Error(row.id + ' 的七天观察期尚未结束。');
    if (row.secondProjectAt != null) {
      const second = instant(row.secondProjectAt, row.id + ' secondProjectAt', now);
      if (second < start) throw Error(row.id + ' 的复用时间早于入组。');
      if (second <= start + week) counts.reused++;
    }
    counts.enrolled++;
    counts[row.firstDelivery]++;
    if (mature) counts.closed++;
    else counts.observing++;
    if (row.followUp === 'lost') counts.missed++;
  }
  return counts;
}

function format(c) {
  const n = c.enrolled;
  const metric = count => n ? count + '/' + n : '暂无样本';
  return [
    '第五期 Mac 公测 · 已入组 ' + n + ' 人，计划 10 人',
    '独立完成首次作品交付 ' + metric(c.independent),
    '一周内主动使用第二个项目 ' + metric(c.reused),
    '首次交付记录 · 有协助 ' + c.assisted + '，失败 ' + c.failed + '，退出 ' + c.withdrew + '，待记录 ' + c.pending,
    '七天观察期 · 已满 ' + c.closed + '，进行中 ' + c.observing + '，失访 ' + c.missed
  ].join('\n');
}

function main(args) {
  if (args.length === 1 && args[0] === '--init') {
    fs.mkdirSync(dir, {recursive:true,mode:0o700});
    fs.writeFileSync(ledger, JSON.stringify(template,null,2) + '\n', {flag:'wx',mode:0o600});
    console.log('已创建空白公测记录 ' + ledger);
    return;
  }
  if (args.length) throw Error('使用 npm run beta:report 查看统计，加 -- --init 创建空白记录。');
  let contents;
  try { contents = fs.readFileSync(ledger,'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('本机尚无公测记录。可用 npm run beta:report -- --init 创建。');
    return;
  }
  console.log(format(summarize(JSON.parse(contents))));
}

module.exports = { summarize, format };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error.code === 'EEXIST' ? '本机已有公测记录，请继续使用原文件。' :
      error instanceof SyntaxError ? '公测记录 JSON 格式无效，请核对本机文件。' : error.message);
    process.exitCode = 1;
  }
}
