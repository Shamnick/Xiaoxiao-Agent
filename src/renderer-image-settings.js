'use strict';

const imageSettings = (() => {
  const cache = new Map();
  let currentKey, revision = 0, loading = false;
  const size = $('generationImageSize'), quality = $('generationImageQuality'), note = $('imageSpecNote');
  const count = $('generationImageCount');
  const labels = {low:'低', medium:'中', high:'高', standard:'标准', hd:'高清', '3840x2160':'4K 横版 · 3840 × 2160', '2160x3840':'4K 竖版 · 2160 × 3840'};
  function fill(select, values, selected) {
    const options = values.filter(v => v !== 'auto').map(v => new Option(labels[v] || v.replace(/(\d)x(\d)/, '$1 × $2'), v));
    select.replaceChildren(new Option('模型默认', ''), ...options);
    select.value = values.includes(selected) && selected !== 'auto' ? selected : '';
    select.disabled = !options.length;
  }
  async function sync(row, fields, force = false) {
    const key = row && JSON.stringify([row.id, row.model, row.baseUrl]);
    if (key === currentKey && !fields && !force) return;
    const changed = currentKey !== key;
    currentKey = key;
    const ticket = ++revision;
    const selectedSize = fields?.generationImageSize ?? (changed ? '' : size.value);
    const selectedQuality = fields?.generationImageQuality ?? (changed ? '' : quality.value);
    const selectedCount = fields?.generationImageCount ?? (changed ? '1' : count.value);
    loading = false;
    if (!row) {
      fill(size, [], ''); fill(quality, [], '');
      count.replaceChildren(new Option('1 张', '1')); count.disabled = true;
      note.textContent = '';
      return;
    }
    let hit = cache.get(key);
    if (!hit || hit.expires < Date.now() || force) {
      hit = {expires:Date.now() + 300000, value:api.providers.imageSpec(row.id)
        .catch(() => ({sizes:[], qualities:[], offline:true}))};
      cache.set(key, hit);
    }
    loading = true;
    size.disabled = quality.disabled = count.disabled = true;
    note.textContent = '读取模型规格…';
    const result = await hit.value;
    if (revision !== ticket) return;
    loading = false;
    fill(size, result.sizes, selectedSize);
    fill(quality, result.qualities, selectedQuality);
    const counts = result.counts?.length ? result.counts : [1];
    count.replaceChildren(...counts.map(n => new Option(n + ' 张', String(n))));
    count.value = counts.includes(Number(selectedCount)) ? selectedCount : String(counts[0]);
    count.disabled = counts.length === 1;
    const sources = [...new Set([result.sizeSource, result.qualitySource].filter(Boolean))];
    const origin = sources.length > 1 ? '尺寸据' + result.sizeSource + '，质量据' + result.qualitySource :
      sources.length ? '规格来自' + sources[0] : '目录未声明尺寸与质量，使用模型默认值';
    note.textContent = result.offline ? '目录暂不可用 · ' + (sources.length ? origin : '使用模型默认值') : origin;
    if (result.experimental4k) note.textContent += ' · 4K 为实验规格';
    updateGenerationComposer();
  }
  return {sync, pending:() => loading};
})();
