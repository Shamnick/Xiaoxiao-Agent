'use strict';

// Parse the saved source, never the rendered (sanitized) Markdown DOM.
function replyFiles(source) {
  if (typeof source !== 'string') return [];
  const extensions = { html: 'html', htm: 'html', svg: 'svg', css: 'css', javascript: 'js', js: 'js',
    json: 'json', markdown: 'md', md: 'md', text: 'txt', txt: 'txt', plaintext: 'txt' };
  const files = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)\r?\n([\s\S]*?)^ {0,3}\1[ \t]*\r?$/gm;
  for (const match of source.matchAll(fence)) {
    const content = match[3];
    const language = match[2].trim().toLowerCase().split(/\s/)[0];
    const extension = Object.hasOwn(extensions, language) ? extensions[language]
      : !language && /^\s*(?:<!doctype html\b|<html\b)/i.test(content) ? 'html' : '';
    if (!extension || !content.trim()) continue;
    const title = extension === 'html' && /<title\b[^>]*>([^<>]{1,100})<\/title>/i.exec(content)?.[1];
    const name = (title || '作品').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 64) || '作品';
    files.push({ filename: name + (files.length ? '-' + (files.length + 1) : '') + '.' + extension, content });
    if (files.length >= 16) break;
  }
  return files;
}

if (typeof module !== 'undefined') module.exports = { replyFiles };
