'use strict';

{
  let rows = [], editingId = '', saving = false, dirty = false;
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const states = { running: '运行中', completed: '已完成', failed: '未完成' };
  const editedRow = () => rows.find(row => row.id === editingId);
  const statusText = text => { $('scheduleStatus').textContent = text; };
  const updateScope = () => {
    $('scheduleWeekdayLabel').hidden = $('scheduleFrequency').value !== 'weekly';
    $('scheduleScope').textContent = $('scheduleProject').value
      ? '应用运行时按本地时间执行。可读取项目资料和目录，交付物保存在新会话。'
      : '应用运行时按本地时间执行。可读取公开网页，交付物保存在新会话。';
  };

  function renderScheduleList() {
    const list = $('scheduleList');
    const activeId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    list.replaceChildren(...rows.map(row => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'library-choice';
      button.dataset.id = row.id;
      button.disabled = saving;
      button.setAttribute('aria-pressed', String(row.id === editingId));
      const name = document.createElement('span');
      name.textContent = row.title;
      const summary = document.createElement('small');
      summary.textContent = row.nextAt ? `下次 ${dateLabel.format(row.nextAt)}` : '手动运行';
      button.append(name, summary);
      button.onclick = () => selectSchedule(row.id);
      return button;
    }));
    if (activeId && !saving) [...list.children].find(button => button.dataset.id === activeId)?.focus({ preventScroll: true });
    const row = editedRow();
    const running = row?.lastRun?.state === 'running';
    $('removeSchedule').hidden = $('runSchedule').hidden = !row;
    $('runSchedule').disabled = saving || dirty || running;
    $('runSchedule').title = dirty ? '保存更改后运行' : '';
    $('removeSchedule').disabled = saving || running;
    $('newSchedule').disabled = $('closeSchedules').disabled = $('saveSchedule').disabled = saving;
    const last = row?.lastRun;
    $('scheduleResult').hidden = !(last || row?.missedAt);
    const summary = [
      last ? `${dateLabel.format(last.at)} · ${states[last.state] || last.state}` : '',
      last?.error, row?.missedAt ? `错过 ${dateLabel.format(row.missedAt)}` : ''
    ].filter(Boolean).join(' · ');
    const lastStatus = $('scheduleLast');
    if (lastStatus.textContent !== summary) lastStatus.textContent = summary;
    lastStatus.title = summary;
    $('openScheduleResult').hidden = !last?.conversationId;
  }

  function selectSchedule(id) {
    editingId = id;
    dirty = false;
    const row = editedRow();
    $('scheduleName').value = row?.title || '';
    $('schedulePrompt').value = row?.prompt || '';
    $('scheduleProvider').replaceChildren(new Option('选择模型', ''), ...providers.map(provider => new Option(provider.name + ' · ' + provider.model, provider.id)));
    $('scheduleProvider').value = row?.providerId || $('modelSelect').value || providers[0]?.id || '';
    $('scheduleProject').replaceChildren(new Option('无项目', ''), ...projects.map(project => new Option(project.name, project.id)));
    $('scheduleProject').value = row?.projectId || '';
    $('scheduleFrequency').value = row?.frequency || 'daily';
    $('scheduleTime').value = row?.time || '09:00';
    $('scheduleWeekday').value = String(row?.weekday ?? 1);
    $('scheduleEnabled').checked = row?.enabled === true;
    statusText(providers.length ? '' : '请先在设置里连接模型。');
    updateScope();
    renderScheduleList();
  }

  async function scheduleAction(action) {
    if (saving) return;
    saving = true;
    statusText('');
    renderScheduleList();
    try { await action(); }
    catch (error) { statusText(errorMessage(error)); }
    finally { saving = false; renderScheduleList(); }
  }
  const scheduleDialog = $('schedulesDialog');
  $('schedulesButton').onclick = $('schedulesCompact').onclick = () => {
    if (locked) return;
    scheduleDialog.showModal();
    void scheduleAction(async () => {
      rows = await api.schedules.list();
      selectSchedule(editedRow()?.id || rows[0]?.id || '');
    });
  };
  window.addEventListener('beforeunload', api.schedules.onChange(next => {
    rows = next;
    if (scheduleDialog.open) renderScheduleList();
  }));
  $('closeSchedules').onclick = () => scheduleDialog.close();
  scheduleDialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('newSchedule').onclick = () => { selectSchedule(''); $('scheduleName').focus(); };
  $('scheduleForm').oninput = () => { dirty = true; updateScope(); renderScheduleList(); };
  $('scheduleForm').onsubmit = event => {
    event.preventDefault();
    void scheduleAction(async () => {
      const saved = await api.schedules.save({
        id: editingId, title: $('scheduleName').value, prompt: $('schedulePrompt').value,
        providerId: $('scheduleProvider').value, projectId: $('scheduleProject').value,
        frequency: $('scheduleFrequency').value, time: $('scheduleTime').value, weekday: Number($('scheduleWeekday').value),
        enabled: $('scheduleEnabled').checked
      });
      rows = await api.schedules.list();
      selectSchedule(saved.id);
      statusText('计划已保存');
    });
  };
  $('removeSchedule').onclick = () => scheduleAction(async () => {
    await api.schedules.remove(editingId);
    rows = await api.schedules.list();
    selectSchedule(rows[0]?.id || '');
  });
  $('runSchedule').onclick = () => scheduleAction(async () => {
    if (dirty) return;
    await api.schedules.run(editingId);
    rows = await api.schedules.list();
    statusText('已提交运行');
  });
  $('openScheduleResult').onclick = () => {
    const conversationId = editedRow()?.lastRun?.conversationId;
    if (!conversations.some(row => row.id === conversationId)) { statusText('此运行的会话已删除'); return; }
    scheduleDialog.close();
    selectConversation(conversationId);
  };
}
