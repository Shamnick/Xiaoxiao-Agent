const { randomUUID } = require('node:crypto');

function waitForUser(run, prompt, publish) {
  run.signal.throwIfAborted();
  if (run.response) throw Error('此任务已有待处理的请求');
  const interaction = { ...prompt, id: randomUUID() };
  return new Promise((resolve, reject) => {
    function finish() {
      run.signal.removeEventListener('abort', abort);
      run.interaction = null;
      run.response = null;
      publish({ type: 'interaction', interaction: null });
    }
    function abort() {
      finish();
      reject(run.signal.reason);
    }
    run.response = value => {
      run.signal.throwIfAborted();
      let result;
      if (interaction.kind === 'approval') {
        if (typeof value !== 'boolean') throw Error('请选择允许或拒绝');
        result = value;
      } else {
        if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw Error('请填写 1 至 4000 个字符的回答');
        result = value.trim();
      }
      finish();
      resolve(result);
    };
    run.interaction = interaction;
    run.signal.addEventListener('abort', abort, { once: true });
    publish({ type: 'interaction', interaction });
  });
}

function questionTool({ ask, record }) {
  return {
    name: 'ask_user',
    description: 'Pause this task to ask the user one essential clarification. Use before taking actions that depend on an uncertain requirement. Provide short suggested answers if useful. Actual file, command, and connector permissions are handled separately by the app.',
    parameters: {
      type: 'object', required: ['question'], additionalProperties: false,
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 800 },
        options: { type: 'array', maxItems: 4, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 120 } }
      }
    },
    async execute({ question, options = [] }) {
      const title = question.trim();
      if (!title) throw Error('问题不能为空');
      const answer = await ask({ kind: 'question', title, options: [...new Set(options.map(s => s.trim()).filter(Boolean))] });
      record({ question: title, answer });
      return { answer };
    }
  };
}

module.exports = { waitForUser, questionTool };
