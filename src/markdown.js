'use strict';

function renderMarkdown(element, source) {
  element.innerHTML = DOMPurify.sanitize(marked.parse(source), {
    ALLOWED_TAGS: ['p','br','strong','em','del','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','pre','code','table','thead','tbody','tr','th','td','hr','a'],
    ALLOWED_ATTR: ['title'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false
  });
}
