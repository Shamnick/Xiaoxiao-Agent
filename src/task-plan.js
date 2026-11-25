const { randomUUID } = require('node:crypto');
const MAX_DRAFTS = 12;

function taskPlanTool({ signal, save }) {
  return {
    name: 'update_task_plan',
    description: 'Replace the visible task checklist for this conversation. Use for multi-step tasks and update it as work progresses. Mark items completed only when verified. Keep at most one step in progress.',
    parameters: {
      type: 'object', required: ['steps'], additionalProperties: false,
      properties: {
        steps: {
          type: 'array', minItems: 1, maxItems: 10,
          items: {
            type: 'object', required: ['title', 'status'], additionalProperties: false,
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 160 },
              status: { enum: ['pending', 'in_progress', 'completed'] }
            }
          }
        }
      }
    },
    execute({ steps }) {
      signal.throwIfAborted();
      const cleaned = steps.map(({ title, status }) => ({ title: title.trim(), status }));
      if (cleaned.some(step => !step.title)) throw Error('步骤标题不能为空');
      if (cleaned.filter(step => step.status === 'in_progress').length > 1) {
        throw Error('同一时间最多有一个进行中的步骤');
      }
      save(cleaned);
      return 'Task checklist saved and visible in the workspace.';
    }
  };
}

function taskDrafts(conversation) {
  if (Array.isArray(conversation.drafts)) return conversation.drafts;
  return conversation.draft ? [{ ...conversation.draft, id: 'legacy-draft', revision: 1 }] : [];
}

function taskDraftTool({ signal, read, save }) {
  return {
    name: 'save_task_draft',
    description: 'Save a Markdown deliverable in the task inspector without modifying workspace files. Each distinct title creates a separate document. Reuse its title or returned id to revise that document.',
    parameters: {
      type: 'object', required: ['title', 'markdown'], additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64 },
        title: { type: 'string', minLength: 1, maxLength: 100 },
        markdown: { type: 'string', minLength: 1, maxLength: 24000 }
      }
    },
    execute({ id, title, markdown }) {
      signal.throwIfAborted();
      title = title.trim();
      if (!title || !markdown.trim()) throw Error('交付稿需要标题和正文');
      const drafts = read();
      const index = drafts.findIndex(draft => id ? draft.id === id : draft.title === title);
      if (id && index < 0) throw Error('找不到指定的交付稿');
      if (index < 0 && drafts.length >= MAX_DRAFTS) throw Error(`每个会话最多保存 ${MAX_DRAFTS} 份交付稿`);
      if (drafts.some((draft, i) => i !== index && draft.title === title)) throw Error('已有同名交付稿');
      const previous = drafts[index];
      const draft = { id: previous?.id || randomUUID(), title, markdown, revision: (previous?.revision || 0) + 1 };
      const next = drafts.slice();
      if (previous) next[index] = draft;
      else next.push(draft);
      save(next);
      return { id: draft.id, title, revision: draft.revision };
    }
  };
}

module.exports = { taskPlanTool, taskDraftTool, taskDrafts };
