'use strict';

function createModelPicker({ $, list, selected, choose, discover, manage, errorMessage }) {
  const panel = $('modelMenu'), query = $('modelQuery'), results = $('modelResults');
  const trigger = $('chooseModel'), more = $('discoverModels');
  let catalog = [], generation = 0;

  function notice(message) {
    $('modelNotice').textContent = message;
    $('modelNotice').hidden = !message;
  }
  function render() {
    const current = selected(), saved = list();
    const term = query.value.trim().toLowerCase();
    const rows = [...saved, ...catalog].filter(p => (p.name + ' ' + p.model).toLowerCase().includes(term));
    results.replaceChildren(...rows.map(p => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'model-option';
      const active = Boolean(p.id && p.id === current?.id);
      button.setAttribute('aria-pressed', String(active));
      const copy = document.createElement('span'), name = document.createElement('strong'), source = document.createElement('small');
      name.textContent = p.model;
      source.textContent = p.name;
      copy.append(name, source);
      button.append(copy);
      if (active) {
        const check = document.createElement('span');
        check.className = 'ui-icon i-check';
        check.setAttribute('aria-hidden', 'true');
        button.append(check);
      }
      button.onclick = () => { panel.hidePopover(); choose(p); };
      return button;
    }));
    const source = current || saved[0];
    const typed = query.value.trim();
    const useId = $('useModelId');
    useId.hidden = !source || !typed || typed.length > 200 || /\s/.test(typed) ||
      rows.some(row => row.model === typed && (row.connectionId || row.id) === (source.connectionId || source.id));
    if (!useId.hidden) {
      useId.textContent = '在 ' + source.name + ' 使用「' + typed + '」';
      useId.onclick = () => {
        panel.hidePopover();
        choose({ connectionId: source.connectionId || source.id, model: typed });
      };
    }
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = '没有匹配的模型';
      results.append(empty);
    }
  }
  panel.addEventListener('toggle', e => {
    generation++;
    if (e.newState !== 'open') return;
    query.value = '';
    catalog = [];
    const p = selected() || list()[0];
    more.disabled = !p;
    more.title = p ? '获取 ' + p.name + ' 的模型列表' : '';
    notice('');
    render();
    query.focus();
  });
  query.oninput = render;
  panel.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      panel.hidePopover();
      trigger.focus();
      return;
    }
    const options = [...results.querySelectorAll('button')];
    if (!$('useModelId').hidden) options.push($('useModelId'));
    if (e.target === query && e.key === 'Enter') {
      e.preventDefault();
      options[0]?.click();
    }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      if (!options.length) return;
      const index = options.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? index + 1 : index < 0 ? -1 : index - 1;
      options[(next + options.length) % options.length].focus();
    }
  });
  more.onclick = async () => {
    const p = selected() || list()[0];
    if (!p) return;
    const connectionId = p.connectionId || p.id;
    const request = generation;
    notice('正在获取 ' + p.name + ' 的模型…');
    more.disabled = true;
    try {
      const names = await discover(connectionId);
      if (request !== generation || !panel.matches(':popover-open')) return;
      const known = new Set(list().filter(row => (row.connectionId || row.id) === connectionId).map(row => row.model));
      catalog = [...new Set(names)].filter(model => !known.has(model)).map(model => ({ connectionId, name: p.name, model }));
      render();
      notice(catalog.length ? '已获取 ' + p.name + ' 的模型列表' : '该连接没有更多模型');
      query.focus();
    } catch (error) {
      if (request === generation) notice(errorMessage(error));
    } finally {
      if (request === generation) more.disabled = false;
    }
  };
  $('manageModels').onclick = () => { panel.hidePopover(); manage(); };
  return {
    update(disabled) {
      const p = selected();
      trigger.disabled = disabled;
      $('modelName').textContent = p?.model || '选择模型';
      trigger.title = (p ? p.name + ' · ' + p.model + '  ' : '') + '切换模型 (⌘/Ctrl + Shift + M)';
      if (disabled && panel.matches(':popover-open')) panel.hidePopover();
    }
  };
}
