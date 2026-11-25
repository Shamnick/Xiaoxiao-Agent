'use strict';

function createPresence() {
  const screen = $('presence'), knot = $('presenceKnot'), entry = $('presenceEntry');
  const composer = $('composer'), marker = document.createComment('workspace composer');
  const main = document.querySelector('main.main');
  composer.before(marker);
  let sampleTimer, generation = 0, previous;
  const history = { cpu: [], memory: [] };
  let voiceEnabled = false, lastUtterance;
  const isHome = () => !screen.hidden;
  const isDrawer = () => isHome() && !$('sidebar').hidden;
  const field = createSilkField({ screen, canvas: $('silkField'), knot, entry,
    sculpture: knot.querySelector('.presence-sculpture') });

  function resetMetrics() {
    previous = null;
    for (const series of Object.values(history)) series.length = 0;
    for (const id of ['presenceCpu', 'presenceMemory']) $(id).textContent = '—';
    for (const id of ['presenceCpuPlot', 'presenceMemoryPlot']) $(id).removeAttribute('points');
  }
  function plot(id, series, value, range) {
    series.push(value);
    if (series.length > 31) series.shift();
    const low = Math.min(...series), span = Math.max(range, Math.max(...series) - low);
    const points = series.map((n, i) => [120 - (series.length - 1 - i) * 4, (23 - 20 * (n - low) / span).toFixed(1)].join(','));
    $(id).setAttribute('points', points.join(' '));
  }
  async function sample(token) {
    try {
      const next = await api.presence.sample();
      if (generation !== token) return;
      const mib = next.residentBytes / 1048576;
      $('presenceMemory').textContent = Math.round(mib) + ' MiB';
      plot('presenceMemoryPlot', history.memory, mib, 2);
      if (previous && next.at > previous.at) {
        const cpu = Math.max(0, (next.cpuMicros - previous.cpuMicros) / (10 * (next.at - previous.at)));
        $('presenceCpu').textContent = cpu.toFixed(1) + '%';
        plot('presenceCpuPlot', history.cpu, cpu, 5);
      }
      previous = next;
    } catch {
      if (generation !== token) return;
      resetMetrics();
    }
    $('presenceClock').textContent = new Date().toLocaleTimeString([], { hour12: false });
    sampleTimer = setTimeout(() => sample(token), 1200);
  }
  function syncSampling() {
    field.sync();
    clearTimeout(sampleTimer);
    const token = ++generation;
    resetMetrics();
    if (isHome() && !document.hidden) void sample(token);
  }
  document.addEventListener('visibilitychange', syncSampling);

  function voiceHint(message = '') {
    $('dictationHint').textContent = message;
    $('dictationHint').hidden = !message;
  }
  function cancelSpeech() {
    if (lastUtterance) window.speechSynthesis?.cancel();
    lastUtterance = null;
  }
  function setVoiceEnabled(on) {
    voiceEnabled = on;
    $('speakReply').setAttribute('aria-pressed', String(on));
    if (!on) cancelSpeech();
  }
  $('speakReply').hidden = !window.speechSynthesis;
  $('speakReply').onclick = () => setVoiceEnabled(!voiceEnabled);
  $('dictate').onclick = async () => {
    if (locked) return;
    cancelSpeech();
    $('prompt').focus();
    if (!mac) {
      voiceHint(api.platform === 'win32' ? '按 Win + H 听写。确认文字后发送。' : '可用系统输入法听写，或直接键入消息。');
      return;
    }
    try {
      const result = await api.presence.dictate();
      voiceHint(result === 'requested'
        ? '请在系统听写结束后确认文字并发送。若未启动，可在系统设置 → 键盘中启用听写。'
        : '请激活窗口后再试，也可以使用系统听写快捷键。');
    } catch { voiceHint('系统听写暂时不可用。你可以继续打字。'); }
  };
  function readReply(turn) {
    if (!voiceEnabled || document.hidden || isHome() || !$('generationStudio').hidden ||
        document.querySelector('dialog[open]') || turn?.role !== 'assistant' || !turn.content || turn.failed) return;
    cancelSpeech();
    const utterance = new SpeechSynthesisUtterance(turn.content);
    lastUtterance = utterance;
    utterance.onend = () => { if (lastUtterance === utterance) lastUtterance = null; };
    utterance.onerror = event => {
      if (lastUtterance !== utterance) return;
      lastUtterance = null;
      if (!['canceled', 'interrupted'].includes(event.error)) voiceHint('系统朗读暂时不可用，回复已显示在会话中。');
    };
    window.speechSynthesis.speak(utterance);
  }

  function collapseEntry() {
    entry.hidden = true;
    knot.setAttribute('aria-expanded', 'false');
    $('presenceHint').textContent = current || fileOpened || taskPaneOpen ? '点击丝结，回到工作区' : '点击丝结，开始对话';
    knot.setAttribute('aria-label', current || fileOpened || taskPaneOpen ? '回到工作区' : '开始语音或文字对话');
    if (entry.contains(composer)) marker.after(composer);
    voiceHint();
  }
  function syncDrawer() {
    const drawer = isDrawer();
    $('presenceBackdrop').hidden = !drawer;
    screen.inert = drawer;
    field.sync();
  }
  function showWorkspace(withSidebar = false) {
    if (!isHome()) return;
    collapseEntry();
    screen.hidden = true;
    main.inert = false;
    document.body.classList.remove('presence-home');
    setRailCollapsed(!withSidebar);
    syncSampling();
  }
  function enterConversation() {
    const animate = document.body.dataset.conversationScene === 'silk' &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = animate && knot.querySelector('img').getBoundingClientRect();
    showWorkspace();
    focusPrompt();
    if (!from?.width) return;

    // Move a decorative copy so focus and the real toolbar stay usable throughout.
    const target = $('returnPresence').querySelector('img');
    const to = target.getBoundingClientRect();
    if (!to.width) return;
    const copy = target.cloneNode();
    copy.className = 'conversation-arrival-knot';
    copy.setAttribute('aria-hidden', 'true');
    Object.assign(copy.style, { left: to.x + 'px', top: to.y + 'px', width: to.width + 'px' });
    document.body.append(copy);
    const flight = copy.animate([
      { transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width})` },
      { transform: 'none' }
    ], { duration: 350, easing: 'cubic-bezier(.22,.74,.27,1)' });
    flight.onfinish = flight.oncancel = () => copy.remove();
  }
  function home() {
    if (locked) return;
    cancelSpeech();
    screen.hidden = false;
    main.inert = true;
    document.body.classList.add('presence-home');
    setRailCollapsed(true);
    collapseEntry();
    syncSampling();
    knot.focus({ preventScroll: true });
  }
  function focus() {
    if (isDrawer()) $('toggleSidebar').focus();
    else if (entry.hidden) knot.focus({ preventScroll: true });
    else $('prompt').focus({ preventScroll: true });
  }
  knot.onclick = async () => {
    if (locked) return;
    // Return to the exact conversation/editor when home was opened from a workspace.
    if (current || fileOpened || taskPaneOpen) {
      showWorkspace();
      focusPrompt();
      return;
    }
    if (!entry.hidden) {
      collapseEntry();
      knot.focus();
      return;
    }
    if (!$('prompt').value && !attachments.length && !selectedProjectId && !skillIds.length && !systemEdits.has(viewKey())) await setMode('chat');
    entry.append(composer);
    entry.hidden = false;
    knot.setAttribute('aria-expanded', 'true');
    $('presenceHint').textContent = '收起输入框';
    knot.setAttribute('aria-label', '收起输入框');
    $('prompt').focus();
    update();
  };
  $('returnPresence').onclick = home;
  $('brandHome').onclick = event => { event.preventDefault(); home(); };
  $('enterWorkspace').onclick = () => { showWorkspace(true); focusPrompt(); };
  $('presenceBackdrop').onclick = () => { setRailCollapsed(true); $('toggleSidebar').focus(); };
  $('sidebar').addEventListener('click', event => {
    if (isHome() && event.target.closest('button') && !event.target.closest('#enterWorkspace, #findHistory, #openProofFromRail')) showWorkspace(true);
  }, true);
  document.addEventListener('keydown', event => {
    if (!isHome() || event.isComposing || document.querySelector('dialog[open], :popover-open')) return;
    if (event.key === 'Escape' && (isDrawer() || !entry.hidden)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isDrawer()) $('presenceBackdrop').click();
      else { collapseEntry(); knot.focus(); }
    } else if ((event.ctrlKey || event.metaKey) && ['n', 'o', ','].includes(event.key.toLowerCase())) {
      showWorkspace(true);
    }
  }, true);
  window.addEventListener('pagehide', () => { ++generation; clearTimeout(sampleTimer); cancelSpeech(); });
  syncSampling();
  return { isHome, showWorkspace, enterConversation, syncDrawer, focus, readReply, cancelSpeech, voiceHint };
}
