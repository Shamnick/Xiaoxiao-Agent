'use strict';

// The preview and file share one raster. Grow the sheet for long copy and
// preserve the artwork's fixed position when only the text changes.
async function renderProofPoster(version, artUrl) {
  const image = new Image();
  image.src = artUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const sans = 'system-ui, sans-serif';
  const serif = '"Songti SC", "Noto Serif CJK SC", serif';
  const titleFont = '600 64px ' + serif;
  const bodyFont = '30px ' + sans;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  function wrap(text, font, width) {
    ctx.font = font;
    const lines = [];
    for (const paragraph of text.split(/\r\n|[\r\n]/u)) {
      let line = '';
      for (const { segment } of segmenter.segment(paragraph)) {
        if (line && ctx.measureText(line + segment).width > width) {
          lines.push(line);
          line = '';
        }
        line += segment;
      }
      lines.push(line);
    }
    return lines;
  }
  const titles = wrap(version.current.title,titleFont,610);
  const body = wrap(version.current.body,bodyFont,610);
  const contentHeight = titles.length * 84 + 36 + body.length * 48;
  canvas.width = 1440;
  const height = Math.max(900, 246 + contentHeight + 96);
  if (height > 6000) throw Error('文案换行过多，请合并部分段落后再导出海报');
  canvas.height = height;
  const invitation = version.asset.id === 'proof-workspace.png';
  ctx.fillStyle = invitation ? '#eee5db' : '#f3edf6';
  ctx.fillRect(0,0,canvas.width,height);
  ctx.fillStyle = '#302936';
  ctx.font = '600 30px ' + sans;
  ctx.fillText('Xiaoxiao Agent',78,95);
  ctx.textAlign = 'right';
  ctx.font = '25px ' + sans;
  ctx.fillText(version.brief.edition,1362,95);
  ctx.textAlign = 'left';
  ctx.fillStyle = invitation ? '#c7b7aa' : '#ccbdcf';
  ctx.fillRect(78,130,1284,2);
  const scale = Math.min(610 / image.naturalWidth, 590 / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  ctx.drawImage(image, 1050 - w / 2, 470 - h / 2, w, h);
  let y = Math.max(246, 426 - contentHeight / 3);
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#29232f';
  ctx.font = titleFont;
  for (const line of titles) { ctx.fillText(line,78,y); y += 84; }
  y += 36;
  ctx.fillStyle = '#514753';
  ctx.font = bodyFont;
  for (const line of body) { ctx.fillText(line,78,y); y += 48; }
  return {url:canvas.toDataURL('image/png'),width:canvas.width,height};
}
