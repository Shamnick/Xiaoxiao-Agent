'use strict';

const { lexer } = require('marked');
const {
  AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat, Packer, Paragraph, Table,
  TableCell, TableRow, TextRun, WidthType
} = require('docx');

const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const xmlControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const eastAsia = { darwin: 'Hiragino Sans GB', win32: 'Microsoft YaHei' }[process.platform] || 'Noto Sans CJK SC';
const font = { ascii: 'Arial', hAnsi: 'Arial', eastAsia };
const codeFont = { ...font, ascii: 'Courier New', hAnsi: 'Courier New' };
const language = { value: 'en-US', eastAsia: 'zh-CN' };
const gridLine = { style: BorderStyle.SINGLE, color: 'CBD3CF', size: 5 };

function headingStyle(size, before, after) {
  return {
    run: { font, language, size, bold: true, color: '000000' },
    paragraph: { keepNext: true, keepLines: true, spacing: { before, after, line: 290 } }
  };
}

function plainText(value) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity) => {
    const named = entities[entity.toLowerCase()];
    if (named !== undefined) return named;
    const hex = entity[1].toLowerCase() === 'x';
    const codepoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codepoint <= 0x10ffff && (codepoint < 0xd800 || codepoint > 0xdfff) ? String.fromCodePoint(codepoint) : full;
  }).replace(xmlControls, '');
}

function inlineRuns(tokens, style = {}) {
  return tokens.flatMap(token => {
    if (token.type === 'br') return [new TextRun({ ...style, break: 1 })];
    if (token.type === 'html' || token.type === 'checkbox') return [];
    if (token.type === 'strong') return inlineRuns(token.tokens, { ...style, bold: true });
    if (token.type === 'em') return inlineRuns(token.tokens, { ...style, italics: true });
    if (token.type === 'del') return inlineRuns(token.tokens, { ...style, strike: true });
    if (token.tokens) return inlineRuns(token.tokens, style);
    const code = token.type === 'codespan';
    const text = token.text || token.raw || '';
    return [new TextRun({
      ...style, font: code ? codeFont : font, language,
      text: code ? text.replace(xmlControls, '') : plainText(text).replace(/\n/g, ' ')
    })];
  });
}

async function draftDocx({ title, markdown }) {
  const tokens = lexer(markdown);
  const initialHeading = tokens.findIndex(token => token.type !== 'space');
  if (tokens[initialHeading]?.type === 'heading' && tokens[initialHeading].depth === 1 && tokens[initialHeading].text.trim() === title.trim()) {
    tokens.splice(initialHeading, 1);
  }
  const numbering = [];
  function blocks(nodes, depth = 0) {
    return nodes.flatMap(token => {
      const children = () => inlineRuns(token.tokens || [token]);
      if (token.type === 'space' || token.type === 'html' || token.type === 'def') return [];
      if (token.type === 'heading') return [new Paragraph({ children: children(), heading: headings[token.depth - 1] })];
      if (token.type === 'hr') return [new Paragraph({ thematicBreak: true })];
      if (token.type === 'code') return token.text.split(/\r?\n/).map(text => new Paragraph({
        children: [new TextRun({ text: text.replace(xmlControls, ''), font: codeFont, language, size: 19 })],
        spacing: { after: 30 }, indent: { left: 220 }
      }));
      if (token.type === 'blockquote') return token.text.split(/\n\s*\n/).map(text => new Paragraph({
        children: [new TextRun({ text: plainText(text).replace(/\n/g, ' '), font, language, italics: true })],
        indent: { left: 320 }, border: { left: { ...gridLine, space: 9 } }
      }));
      if (token.type === 'table') return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        margins: { top: 85, bottom: 85, left: 125, right: 125 },
        borders: { top: gridLine, bottom: gridLine, left: gridLine, right: gridLine, insideHorizontal: gridLine, insideVertical: gridLine },
        rows: [token.header, ...token.rows].map((cells, index) => new TableRow({
          tableHeader: index === 0,
          children: cells.map(cell => new TableCell({
            shading: index === 0 ? { fill: 'EDF2EF' } : undefined,
            children: [new Paragraph({ children: inlineRuns(cell.tokens, index === 0 ? { bold: true } : {}), spacing: { after: 0 } })]
          }))
        }))
      })];
      if (token.type === 'list') {
        const left = (Math.min(depth, 8) + 1) * 360;
        const references = new Map();
        function listMarker(checkbox) {
          const marker = checkbox || (token.ordered ? '%1.' : '•');
          if (!references.has(marker)) {
            const reference = `draftList${numbering.length}`;
            numbering.push({ reference, levels: [{
              level: 0, format: token.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET, text: marker,
              start: token.ordered ? token.start : 1, alignment: AlignmentType.START,
              style: { run: { font: { ...font, ascii: 'Arial Unicode MS', hAnsi: 'Arial Unicode MS' } }, paragraph: { indent: { left, hanging: 280 } } }
            }] });
            references.set(marker, reference);
          }
          return { reference: references.get(marker), level: 0 };
        }
        return token.items.flatMap(item => {
          const lines = item.tokens.filter(node => node.type !== 'space' && node.type !== 'checkbox');
          const checkbox = item.task ? (item.checked ? '☑' : '☐') : '';
          let first = true;
          function itemParagraph(content) {
            const options = first ? { numbering: listMarker(token.ordered ? '' : checkbox) } : { indent: { left } };
            if (first && token.ordered && checkbox) {
              content.unshift(new TextRun({ text: `${checkbox} `, font: 'Arial Unicode MS' }));
            }
            first = false;
            return new Paragraph({ ...options, children: content, spacing: { before: 45, after: 90 } });
          }
          if (!lines.length) return [itemParagraph([])];
          return lines.flatMap(node => {
            if (node.type === 'paragraph' || node.type === 'text') return [itemParagraph(inlineRuns(node.tokens || [node]))];
            const nested = blocks([node], depth + 1);
            return first && nested.length ? [itemParagraph([]), ...nested] : nested;
          });
        });
      }
      return [new Paragraph({ children: children() })];
    });
  }

  const documentTitle = title.replace(xmlControls, '');
  const children = [new Paragraph({ children: [new TextRun({ text: documentTitle, font, language })], heading: HeadingLevel.TITLE }), ...blocks(tokens)];
  return Packer.toBuffer(new Document({
    title: documentTitle, creator: require('./brand.json').name, numbering: { config: numbering },
    styles: { default: {
      document: { run: { font, language, color: '222725', size: 22 }, paragraph: { spacing: { after: 155, line: 315 } } },
      title: headingStyle(46, 0, 360),
      heading1: headingStyle(34, 240, 135),
      heading2: headingStyle(29, 210, 115),
      heading3: headingStyle(25, 180, 100),
      heading4: headingStyle(23, 150, 90),
      heading5: headingStyle(22, 130, 80),
      heading6: headingStyle(22, 130, 80)
    } },
    sections: [{ properties: {
      page: { size: { width: 11907, height: 16839 }, margin: { top: 1060, bottom: 1080, left: 1090, right: 1090 } }
    }, children }]
  }));
}

module.exports = { draftDocx };
