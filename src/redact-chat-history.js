'use strict';

const { mask } = require('./connection-intent');

// Scrub chat text in place once on upgrade. File paths, binary attachments and IDs
// must keep their original values so existing deliveries continue to open.
function redactChatHistory(rows) {
  let changed = false;
  function scrub(item, field) {
    if (typeof item?.[field] !== 'string') return;
    const safe = mask(item[field]);
    if (safe !== item[field]) {
      item[field] = safe;
      changed = true;
    }
  }
  function turn(message) {
    for (const field of ['content', 'partial', 'error']) scrub(message, field);
    for (const update of message?.updates || []) scrub(update, 'text');
    for (const qa of message?.clarifications || []) {
      scrub(qa, 'question');
      scrub(qa, 'answer');
    }
  }
  for (const row of rows) {
    const first = row.messages?.[0]?.content;
    // Older automatic titles are the first 36 characters, sometimes half a key.
    if (typeof first === 'string' && mask(first) !== first && row.title === first.slice(0, 36)) {
      row.title = mask(first).slice(0, 36);
      changed = true;
    }
    scrub(row, 'title');
    scrub(row, 'systemPrompt');
    for (const msg of row.messages || []) {
      turn(msg);
      turn(msg.recovery);
    }
    turn(row.pendingRun);
  }
  return changed;
}

module.exports = { redactChatHistory };
