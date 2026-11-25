'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { verifyWrittenText } = require('./write-verification');

const formats = Object.freeze({
  html: { name: 'HTML 网页', extensions: ['html', 'htm'] },
  svg: { name: 'SVG 图像', extensions: ['svg'] },
  css: { name: 'CSS 样式', extensions: ['css'] },
  js: { name: 'JavaScript', extensions: ['js'] },
  json: { name: 'JSON 数据', extensions: ['json'] },
  pdf: { name: 'PDF 文档', extensions: ['pdf'] },
  md: { name: 'Markdown 文档', extensions: ['md'] },
  txt: { name: '文本文件', extensions: ['txt'] }
});
function createArtifactTool({ choosePath, signal, renderPdf } = {}) {
  return {
    name: 'save_artifact',
    description: 'Create a standalone user-requested file (HTML, SVG, CSS, JavaScript, JSON, Markdown, text, or PDF). For PDF use a .pdf filename and provide the full document as Markdown, which the app typesets locally. Ask the user to choose its save location, write the complete file, and return the saved path. Use this instead of replying with a code block when the user asks for a file they can open. Do not run or test the created file unless asked.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', minLength: 1, maxLength: 180 },
        content: { type: 'string', minLength: 1 }
      },
      required: ['filename', 'content'],
      additionalProperties: false
    },
    async execute({ filename, content } = {}) {
      signal?.throwIfAborted();
      if (typeof filename !== 'string' || filename.length > 180 || filename.startsWith('.') ||
          filename !== path.basename(filename) || /[\\/:\x00-\x1f\x7f]/.test(filename)) {
        throw new Error('文件名只能包含文件名本身，不能包含路径');
      }
      const extension = path.extname(filename).slice(1).toLowerCase();
      const format = formats[extension] || (extension === 'htm' ? formats.html : null);
      if (!Object.hasOwn(formats, extension) && extension !== 'htm') throw new Error('支持 HTML、SVG、CSS、JavaScript、JSON、Markdown、TXT 和 PDF 文件');
      if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > 512 * 1024) {
        throw new Error('文件内容不能为空，最大为 512 KiB');
      }
      const destination = await choosePath({ filename, format, extension });
      if (!destination) return { canceled: true };
      signal?.throwIfAborted();
      const target = path.resolve(destination);
      if (!format.extensions.includes(path.extname(target).slice(1).toLowerCase())) {
        throw new Error('保存扩展名与生成文件类型不一致');
      }
      const bytes = extension === 'pdf'
        ? await renderPdf({ title: path.parse(filename).name, markdown: content })
        : Buffer.from(content, 'utf8');
      signal?.throwIfAborted();
      const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + randomUUID() + '.tmp');
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        signal?.throwIfAborted();
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      const verification = await verifyWrittenText(target, bytes);
      return { path: target, bytesWritten: bytes.length, extension, verification };
    }
  };
}

module.exports = { createArtifactTool };
