'use strict';

// Manufacturer presets for the image generation endpoint. A gateway's explicit
// parameter enums take priority, including an explicitly empty list.
// https://developers.openai.com/api/docs/guides/image-generation
// https://www.volcengine.com/docs/82379/1541523
// https://docs.byteplus.com/en/docs/ModelArk/1541523
function documented(model) {
  const square = ['1024x1024', '1536x1024', '1024x1536'];
  const qualities = ['low', 'medium', 'high'];
  if (/^gpt-image-2(?:-2026-04-21)?$/.test(model))
    return {sizes:[...square, '2048x2048', '2048x1152', '2560x1440', '3840x2160', '2160x3840'], qualities, source:'OpenAI 文档', experimental4k:true};
  if (/^gpt-image-1(?:\.5|-mini)?(?:-\d{4}-\d\d-\d\d)?$/.test(model))
    return {sizes:square, qualities, source:'OpenAI 文档'};
  const seed = /^(?:doubao-)?seedream-(5[-.]0-(?:pro|flash|lite)|5[-.]0|4[-.]5|4[-.]0)(?:-\d{6})?$/.exec(model);
  if (!seed) return {sizes:[], qualities:[], source:''};
  const version = seed[1].replace('.', '-');
  let sizes;
  if (version.endsWith('pro') || version.endsWith('flash')) sizes = ['1K', '1.5K', '2K', '2048x2048', '2816x1584', '1584x2816'];
  else if (version === '4-0') sizes = ['1K', '2K', '4K'];
  else if (version === '4-5') sizes = ['2K', '4K'];
  else if (version.endsWith('lite') || model.endsWith('-260128')) sizes = ['2K', '3K', '4K'];
  else return {sizes:[], qualities:[], source:''};
  return {sizes, qualities:[], source:'方舟文档'};
}

function enumValues(raw, valid) {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.filter(v => typeof v === 'string' && valid.test(v)))].slice(0, 100);
}

function imageSpec(model, entry) {
  const doc = documented(model);
  const data = entry?.capabilities?.image_generation ?? entry?.capabilities?.image ?? entry;
  const fields = data?.parameters?.properties ?? data?.parameters ?? data;
  const sizes = enumValues(fields?.size?.enum ?? fields?.supported_sizes ?? fields?.sizes, /^(?:auto|\d{1,2}(?:\.\d)?K|[1-9]\d{1,4}x[1-9]\d{1,4})$/i);
  const qualities = enumValues(fields?.quality?.enum ?? fields?.supported_qualities ?? fields?.qualities, /^[\w.-]{1,30}$/);
  const countValues = fields?.n?.enum ?? fields?.supported_counts ?? fields?.counts;
  const counts = Array.isArray(countValues) ? [...new Set(countValues.filter(n => Number.isInteger(n) && n >= 1 && n <= 4))] :
    doc.source === 'OpenAI 文档' ? [1, 2, 3, 4] : [1];
  return {
    counts,
    experimental4k:!sizes && Boolean(doc.experimental4k),
    sizes:sizes ?? doc.sizes, qualities:qualities ?? doc.qualities,
    sizeSource:sizes ? '服务商目录' : doc.source, qualitySource:qualities ? '服务商目录' : doc.source
  };
}
module.exports = { imageSpec };
