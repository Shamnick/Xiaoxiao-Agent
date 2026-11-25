const MAX_PIECES = 3;
const DEFAULT_TIMEOUT = 45000;
const RESULT_LIMIT = 6500;

function parallelAnalysisTool({ signal, analyze, report, timeoutMs = DEFAULT_TIMEOUT }) {
  let used = false;
  return {
    name: 'delegate_analysis',
    description: 'Analyze two or three independent parts of this task in parallel with the current model. Each analyst sees only its supplied goal and context, and has no tools or workspace access. Include relevant source excerpts. Use for substantial comparisons or reviews, then verify and integrate the results. Available once per request.',
    parameters: {
      type: 'object', required: ['pieces'], additionalProperties: false,
      properties: {
        pieces: {
          type: 'array', minItems: 2, maxItems: MAX_PIECES, uniqueItems: true,
          items: {
            type: 'object', additionalProperties: false, required: ['goal', 'context'],
            properties: {
              goal: { type: 'string', minLength: 1, maxLength: 800 },
              context: { type: 'string', minLength: 1, maxLength: 16000 }
            }
          }
        }
      }
    },
    async execute({ pieces }) {
      signal.throwIfAborted();
      if (used) return { error: '此轮已进行过并行分析，请整合现有结果后继续。' };
      if (pieces.some(piece => !piece.goal.trim() || !piece.context.trim())) throw Error('请为每项分析提供目标与资料');
      used = true;
      let finished = 0;
      let failed = 0;
      const publish = () => report({ total: pieces.length, finished, failed });
      publish();
      const results = await Promise.all(pieces.map(async ({ goal, context }) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const workerSignal = AbortSignal.any([signal, timeout]);
        let result;
        try {
          const text = (await analyze({ goal, context }, workerSignal)).trim();
          workerSignal.throwIfAborted();
          if (!text) throw Error('Empty analysis');
          result = { goal, state: 'completed', text: text.slice(0, RESULT_LIMIT), truncated: text.length > RESULT_LIMIT };
        } catch {
          signal.throwIfAborted();
          failed++;
          result = { goal, state: 'failed', error: timeout.aborted ? '分析请求超时' : '模型未返回可用分析' };
        }
        finished++;
        publish();
        return result;
      }));
      return { results };
    }
  };
}

module.exports = { parallelAnalysisTool };
