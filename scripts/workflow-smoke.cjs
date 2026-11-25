const enterWorkspace = require('./enter-workspace.cjs');
const { _electron: electron } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Store } = require('../src/store');

const root = path.resolve(__dirname, '..');
const launchTask = '整理季度发布资料';
const supportTask = '汇总本周支持工单';
const scheduledPrompt = '整理资料并输出定时简报';
const workflowMarker = 'WORKFLOW_RULE_73';
const audience = '面向产品团队';
const followUp = '补充：将每条待确认事项控制在一行。';
const attachmentTask = '核对附件里的阶段名称';
const oldChecklist = '# 发布核对表\n\n- [ ] 核对邀请名单';
const approvedText = '# 发布核对表\n\n- [ ] 复核定稿时间';
const overview = { title: '发布简报', markdown: '# 发布简报\n\n- 面向产品团队。' };
const checklist = { title: '复核清单', markdown: '# 复核清单\n\n## 定稿安排\n\n1. 核对定稿时间。\n2. 确认交付范围。\n\n- [ ] 复核收件人\n  - [x] 更新项目邮件组' };
const pieces = [
  { goal: '复核上线日期', context: '约定日期为周五，时区待确认。' },
  { goal: '复核共享范围', context: '内部团队可以查阅。' }
];
const qa = process.env.XIAOXIAO_SMOKE_QA_DIR;

function createFixture() {
  const seen = { updates: [], answers: [], writes: {}, analyses: [] };
  let finishFirstRound, releaseFailedAnalyst;
  const analysts = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const userMessage = body.messages.find(message => message.role === 'user')?.content;
      const user = userMessage?.startsWith('Workspace conventions supplied') ? userMessage.split('\n\nUser request:\n').at(-1) : userMessage;
      const results = Object.fromEntries(body.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]));
      res.setHeader('content-type', 'text/event-stream');
      const send = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
      const finish = content => { send({ content }, 'stop'); res.end(); };
      const call = (...tools) => {
        send({ tool_calls: tools.map(([name, args, id = name], index) => ({ index, id, function: { name, arguments: JSON.stringify(args) } })) }, 'tool_calls');
        res.end();
      };
      if (body.messages[0]?.content.startsWith('You are an independent analyst')) {
        assert.equal(body.tools, undefined);
        assert.equal(body.messages.length, 2);
        const piece = JSON.parse(user);
        const index = pieces.findIndex(value => value.goal === piece.goal);
        assert.deepEqual(piece, pieces[index]);
        seen.analyses.push(index);
        analysts[index] = index === 0 ? () => finish('已核实是周五，时区仍待确认。') : () => res.destroy();
        if (analysts.filter(Boolean).length === 2) {
          analysts[0]();
          releaseFailedAnalyst = analysts[1];
        }
        return;
      }
      if (user === attachmentTask) {
        if (!results.read_selected_document) { call(['read_selected_document', {}]); return; }
        assert.match(results.read_selected_document, /最终阶段/);
        finish('已核对最终阶段。');
        return;
      }
      if (user === supportTask) { send({ content: '正在汇总工单类别及负责人。' }); return; }
      if (user === scheduledPrompt) {
        assert(!userMessage.includes('PROJECT_GUIDANCE_FIXTURE'));
        seen.scheduleTools = body.tools.map(tool => tool.function.name);
        if (!results.save_task_draft) { call(['save_task_draft', { title: '定时简报', markdown: '# 定时简报\n\n已归档。' }]); return; }
        finish('定时简报已归档。'); return;
      }
      if (user === '三号任务等待' || user === '四号任务等待') { send({ content: '第三个任务正在工作。' }); return; }
      if (user !== launchTask) { finish('独立任务完成。'); return; }
      seen.system = body.messages[0].content;
      assert(!seen.system.includes('PROJECT_GUIDANCE_FIXTURE'));
      assert(userMessage.includes('PROJECT_GUIDANCE_FIXTURE'));
      if (!results.checklist_read) {
        call(['read_file', {path:'checklist.md'}, 'checklist_read'], ['read_file', {path:'dates.md'}, 'dates_read']);
        return;
      }
      assert.equal(JSON.parse(results.checklist_read).path, 'checklist.md');
      assert.equal(JSON.parse(results.dates_read).path, 'dates.md');
      const submittedUpdate = body.messages.find(message => message.role === 'user' && message.content === followUp);
      if (submittedUpdate) seen.updates.push(submittedUpdate.content);
      if (!results.update_task_plan) {
        send({ content: '我会核对发布资料并分别整理简报和清单。' });
        finishFirstRound = () => call(['update_task_plan', { steps: [
          { title: '核对资料', status: 'completed' },
          { title: '确认简报读者', status: 'in_progress' },
          { title: '整理简报与清单', status: 'pending' }
        ] }]);
      } else if (!results.ask_user) {
        call(['ask_user', { question: '这份发布简报主要给谁阅读？', options: [audience, '面向管理团队'] }]);
      } else if (!results.approve_file) {
        seen.answers.push(JSON.parse(results.ask_user).answer);
        call(['write_file', { path: 'checklist.md', content: approvedText }, 'approve_file']);
      } else if (!results.deny_file) {
        seen.writes.approved = results.approve_file;
        call(['write_file', { path: 'notes.md', content: '# 额外说明' }, 'deny_file']);
      } else if (!results.stale_file) {
        seen.writes.denied = results.deny_file;
        call(['write_file', { path: 'dates.md', content: '# 模型拟定的发布日期' }, 'stale_file']);
      } else if (!results.analysis) {
        seen.writes.stale = results.stale_file;
        call(['delegate_analysis', { pieces }, 'analysis']);
      } else if (!results.overview) {
        const { results: analyzed } = JSON.parse(results.analysis);
        assert.equal(analyzed[0].state, 'completed');
        assert.match(analyzed[0].text, /时区仍待确认/);
        assert.equal(analyzed[1].state, 'failed');
        call(['save_task_draft', overview, 'overview'], ['save_task_draft', checklist, 'checklist']);
      } else if (!results.revision) {
        const { id } = JSON.parse(results.overview);
        call(['save_task_draft', { id, ...overview, markdown: overview.markdown + '\n- 时间待确认。' }, 'revision']);
      } else {
        finish('\n\n**发布简报和复核清单**已保存。');
      }
    } catch (error) {
      seen.error = error;
      res.destroy();
    }
  });
  return { server, seen, release: () => finishFirstRound(), failAnalyst: () => releaseFailedAnalyst() };
}

async function main() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxiao-workflows-')));
  const workspace = path.join(dir, '发布项目');
  const nested = path.join(workspace, '素材');
  const anotherWorkspace = path.join(dir, '客户访谈');
  const skill = path.join(dir, 'SKILL.md');
  const unsentFile = path.join(dir, '留待下一轮.md');
  const fixture = createFixture();
  let app;
  try {
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(anotherWorkspace);
    await fs.writeFile(path.join(workspace, 'CLAUDE.md'), 'PROJECT_GUIDANCE_FIXTURE');
    await fs.writeFile(path.join(workspace, 'checklist.md'), oldChecklist);
    await fs.writeFile(path.join(workspace, 'dates.md'), '# 待确认日期');
    await fs.writeFile(path.join(nested, '只属于发布项目.md'), '# 发布素材');
    await fs.writeFile(path.join(anotherWorkspace, 'checklist.md'), '# 阶段草稿');
    await fs.writeFile(path.join(anotherWorkspace, 'interview.md'), '# 访谈记录');
    await fs.writeFile(skill, `---\nname: 发布资料审校\ndescription: 检查产品发布资料并产出交付物\n---\n${workflowMarker}\n`);
    await fs.writeFile(unsentFile, '此文件用于验证切换会话时不会丢失未发送附件。');
    if (qa) await fs.mkdir(qa, { recursive: true });
    await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
    const store = new Store(dir);
    store.write('providers', [{ id: 'fixture', name: '本地助手', model: 'fixture-model', kind: 'ollama', baseUrl: `http://127.0.0.1:${fixture.server.address().port}/v1` }]);
    store.write('projects', [{ id: 'launch', name: '产品发布', instructions: '发布资料统一使用中文。', workspace, sources: [] }]);
    const base = { agent: true, providerId: 'fixture', systemPrompt: '', messages: [], updatedAt: Date.now() };
    store.write('conversations', [
      { ...base, id: 'launch', title: launchTask, projectId: 'launch', workspace: '' },
      { ...base, id: 'support', title: supportTask, workspace: '' },
      { ...base, id: 'overlap', title: '复核项目素材', workspace: nested },
      { ...base, id: 'third', title: '归档项目笔记', workspace: '' },
      { ...base, id: 'fourth', title: '整理共享日历', workspace: '' }
    ]);
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    const launch = () => electron.launch({ args: executablePath ? [] : ['.'], executablePath, cwd: root, env: { ...process.env, XIAOXIAO_SMOKE_DIR: dir } });
    app = await launch();
    let page = await app.firstWindow();
    await enterWorkspace(page);
    const errors = [];
    const watch = () => { page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); };
    watch();
    const ready = () => page.waitForFunction(() => Boolean(document.getElementById('modelSelect')?.value) &&
      !document.getElementById('openFolder')?.disabled);
    const click = id => page.locator(`#${id}`).click();
    const select = title => page.locator('#history .session-link').filter({ hasText: title }).click();
    const running = id => page.locator(`#runningList button[data-id="${id}"]`);
    const prompt = text => page.locator('#prompt').fill(text);
    const send = async text => { await prompt(text); await click('send'); };
    const waitText = (selector, text) => page.locator(selector).getByText(text, { exact: false }).first().waitFor();
    const pick = filename => app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, filename);
    const openFile = name => page.locator('#fileEntries').getByRole('button', { name, exact: true }).click();
    const changeRow = () => page.locator('#changesList button').filter({ hasText: 'checklist.md' });
    const theme = appearance => app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, appearance);
    const capture = async name => {
      if (!qa) return;
      await page.evaluate(() => document.activeElement?.blur());
      await page.screenshot({ path: path.join(qa, `${name}.png`), scale: 'css', animations: 'disabled' });
    };

    await ready();
    await theme('light');
    await pick(anotherWorkspace);
    await click('openFolder');
    await waitText('#conversationScope', '客户访谈');
    await click('openFolder');
    await page.waitForFunction(() => !document.getElementById('openFolder').disabled);
    const projectRows = await page.evaluate(() => window.nova.projects.list());
    assert.equal(projectRows.filter(row => row.workspace === anotherWorkspace).length, 1);
    const folderProject = projectRows.find(row => row.workspace === anotherWorkspace);
    if (!(await page.locator('#fileBrowser').isVisible())) await click('workspaceBrowserButton');
    await page.locator('#fileEntries').getByRole('button', { name: 'interview.md' }).waitFor();
    const filter = page.locator('#fileFilter');
    await filter.fill('miss');
    await waitText('#fileListStatus', '0 个匹配项');
    await filter.press('Escape');
    assert.equal(await filter.inputValue(), '');
    await filter.fill('CHECK');
    await waitText('#fileListStatus', '1 个匹配项');
    assert.equal(await page.locator('#fileEntries button').count(), 1);
    await filter.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.path), 'checklist.md');
    await page.keyboard.press('Enter');
    await waitText('#fileLines', '阶段草稿');
    await fs.writeFile(path.join(anotherWorkspace, 'checklist.md'), '# 最终阶段');
    await click('attachPreview');
    await waitText('#previewStatus', '文件已更新');
    await click('refreshPreview');
    await waitText('#fileLines', '最终阶段');
    await click('attachPreview');
    await waitText('#attachmentLabel', 'checklist.md');
    await send(attachmentTask);
    await waitText('#chat', '已核对最终阶段');
    await page.locator('#stop').waitFor({ state: 'hidden' });
    const crossScope = { projectId: folderProject.id, workspace, path: 'checklist.md' };
    await assert.rejects(page.evaluate(input => window.nova.workspace.preview(input), crossScope), /工作目录已切换/);
    const folderTarget = { ...crossScope, workspace: anotherWorkspace };
    const preview = await page.evaluate(input => window.nova.workspace.preview(input), folderTarget);
    const { id: attachedId } = await page.evaluate(input => window.nova.workspace.attach(input), { ...folderTarget, revision: preview.revision });
    await assert.rejects(page.evaluate(attachmentId => window.nova.chat.send({ conversationId: 'support', text: '检查附件隔离', attachmentId, requestId: 'wrong-scope' }), attachedId), /工作目录或会话已切换/);
    await page.evaluate(id => window.nova.attachment.clear(id), attachedId);
    await page.locator('#projectList').getByRole('button', { name: '全部会话', exact: true }).click();
    await select(launchTask);
    await click('skillsButton');
    await pick(skill);
    await click('importSkill');
    await page.waitForFunction(() => document.getElementById('skillBody').value.includes('WORKFLOW_RULE_73'));
    await click('saveSkill');
    await click('toggleSkill');
    await waitText('#skillStatus', '已用于此任务');
    await capture('skills-light');
    await click('closeSkills');
    await send(launchTask);
    await waitText('#chat', '我会核对发布资料');
    assert.match(fixture.seen.system, /WORKFLOW_RULE_73/);
    await prompt(followUp);
    await click('steer');
    await waitText('#chat', '等待送达');
    await click('workspaceBrowserButton');
    await openFile('素材');
    await waitText('#fileLocationPath', '素材');
    await openFile('只属于发布项目.md');
    await waitText('#fileLines', '发布素材');
    assert.equal(await page.locator('#attachPreview').isEnabled(), false);
    fixture.release();
    await waitText('#interactionPanel', '这份发布简报主要给谁阅读？');
    assert.equal(await page.locator('#filePreview').isVisible(), false);
    assert(fixture.seen.updates.includes(followUp));
    const launchRun = (await page.evaluate(() => window.nova.chat.runs())).find(run => run.conversationId === 'launch');
    assert.equal(launchRun.interaction.kind, 'question');
    await page.locator('#answerText').fill('可编辑的回答');

    await select('复核项目素材');
    await send('检查重叠目录');
    await waitText('#errorBanner', '这个工作目录已有任务运行');
    assert.equal(await page.locator('#prompt').inputValue(), '检查重叠目录');
    await select(supportTask);
    await send(supportTask);
    await waitText('#chat', '正在汇总工单类别');
    assert.equal(await page.locator('#runningList .session-link').count(), 2);
    await select('归档项目笔记');
    await send('三号任务等待');
    await waitText('#chat', '第三个任务正在工作');
    await select('整理共享日历');
    await send('四号任务等待');
    await waitText('#errorBanner', '最多同时运行 3 个会话');
    assert.equal(await page.locator('#prompt').inputValue(), '四号任务等待');
    await running('third').click();
    await click('stop');
    await waitText('#chat', '任务已停止');
    await running('support').click();
    await prompt('下轮留用的内容');
    await capture('parallel-tasks-light');
    const wrongStop = await page.evaluate(id => window.nova.chat.stop({ conversationId: 'support', requestId: id }), launchRun.requestId);
    assert.equal(wrongStop, false);
    await click('stop');
    await waitText('#chat', '任务已停止');
    await pick(unsentFile);
    await click('composerToolsButton');
    await click('attach');
    await waitText('#attachmentLabel', '留待下一轮.md');
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('#historyFilters [data-scope=attention]').click();
    const waiting = page.locator('#historyResults [data-session="launch"]');
    await waitText('#historyResults [data-session="launch"]', '待回答');
    await waiting.click();
    await page.waitForFunction(() => document.activeElement.id === 'answerText');
    assert.equal(await page.locator('#answerText').inputValue(), '可编辑的回答');
    await capture('clarification-light');
    await select(supportTask);
    assert.equal(await page.locator('#prompt').inputValue(), '下轮留用的内容');
    await waitText('#attachmentLabel', '留待下一轮.md');
    await running('launch').click();
    await page.getByRole('button', { name: audience, exact: true }).click();
    await click('sendAnswer');
    await waitText('#interactionPanel', '文件改动待审阅');
    await waitText('#runStatus', '待审阅');
    await click('openChangeReview');
    await waitText('#changeReviewBody .diff-remove', '核对邀请名单');
    await waitText('#changeReviewBody .diff-add', '复核定稿时间');
    await click('reviewBefore');
    await waitText('#changeReviewBody', '核对邀请名单');
    await click('reviewAfter');
    await waitText('#changeReviewBody', '复核定稿时间');
    await click('reviewDiff');
    await capture('file-review-light');
    await page.keyboard.press('Escape');
    await page.locator('#changeReviewDialog').waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(path.join(workspace, 'checklist.md'), 'utf8'), oldChecklist);
    await assert.rejects(page.evaluate(id => window.nova.chat.answer({ conversationId: 'launch', requestId: id, interactionId: 'old', answer: true }), launchRun.requestId), /已经结束/);

    await page.reload();
    await enterWorkspace(page);
    await running('launch').click();
    await waitText('#interactionPanel', '文件改动待审阅');
    await click('openChangeReview');
    await click('applyReviewedWrite');
    await waitText('#openChangeReview', 'notes.md');
    await click('openChangeReview');
    assert.equal(await page.locator('#reviewBefore').isVisible(), false);
    await click('rejectReviewedWrite');
    await waitText('#openChangeReview', 'dates.md');
    await click('openChangeReview');
    await waitText('#changeReviewBody .diff-add', '模型拟定');
    await fs.writeFile(path.join(workspace, 'dates.md'), '# 用户同时修改了日期');
    await click('applyReviewedWrite');
    await waitText('#writeConflict', '已保留磁盘上的版本');
    await page.waitForFunction(() => document.getElementById('activityLog').textContent.includes('1/2 项已返回'));
    assert.deepEqual([...fixture.seen.analyses].sort(), [0, 1]);
    await capture('analysis-running-light');
    fixture.failAnalyst();
    await waitText('#chat', '发布简报和复核清单');
    await page.waitForFunction(() => document.getElementById('activityLog').textContent.includes('2/2 项已返回 · 1 项未完成'));
    await page.locator('#runningSection').waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(path.join(workspace, 'checklist.md'), 'utf8'), approvedText);
    await assert.rejects(fs.stat(path.join(workspace, 'notes.md')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(workspace, 'dates.md'), 'utf8'), '# 用户同时修改了日期');
    assert.equal(JSON.parse(fixture.seen.writes.approved).verification, 'matched');
    assert.match(fixture.seen.writes.stale, /文件在确认期间已更改/);
    assert.match(fixture.seen.writes.denied, /Approval denied/);
    assert.deepEqual(fixture.seen.answers, [audience]);
    const rows = await page.evaluate(() => window.nova.conversations.list());
    const recorded = rows.find(row => row.id === 'launch').workspaceChanges;
    assert.equal(recorded.length, 1);
    const [record] = recorded;
    assert(record.hasSnapshot);
    assert(!Object.hasOwn(record, 'before') && !Object.hasOwn(record, 'after'));
    await assert.rejects(page.evaluate(changeId => window.nova.workspace.change({ conversationId: 'support', changeId }), record.id), /没有这份改动记录/);

    const currentText = approvedText + '\n- 已由用户补充';
    await fs.writeFile(path.join(workspace, 'checklist.md'), currentText);
    await click('changesShortcut');
    await waitText('#changesCount', '1 次写入');
    await changeRow().click();
    await waitText('#changeReviewTitle', '写入记录');
    await waitText('#changeReviewBody .diff-add', '复核定稿时间');
    assert.equal(await page.locator('#applyReviewedWrite').isVisible(), false);
    assert.equal(await page.locator('#rejectReviewedWrite').isVisible(), false);
    await click('reviewAfter');
    assert.equal(await page.locator('#changeReviewBody').textContent(), approvedText);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('changeReviewDialog').open && document.activeElement.closest('#changesList'));
    await changeRow().click();
    await click('openCurrentFile');
    await waitText('#fileLines', '已由用户补充');
    await capture('file-preview-light');
    await click('inspectorFiles');
    await openFile('素材');
    await waitText('#fileLocationPath', '素材');
    await click('fileParent');
    await page.locator('#fileEntries').getByRole('button', { name: 'checklist.md' }).waitFor();
    await capture('file-browser-light');
    await click('returnToChat');
    await click('closeTaskPane');
    await click('draftShortcut');
    assert.equal(await page.locator('#draftList button').count(), 2);
    await page.locator('#draftList button').filter({ hasText: overview.title }).click();
    await waitText('#draftRevision', '第 2 版');
    await waitText('#renderedDraft', '时间待确认');
    await click('closeDraft');
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
    await page.waitForFunction(() => innerWidth <= 900 && innerHeight <= 600);
    await capture('multi-deliverable-dark-compact');
    await changeRow().click();
    await waitText('#changeReviewBody .diff-remove', '核对邀请名单');
    assert(await page.locator('#openCurrentFile').evaluate(node => {
      const { left, right, bottom, top } = node.getBoundingClientRect();
      return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight;
    }));
    await capture('file-history-dark-compact');
    await click('closeChangeReview');
    await page.locator('#draftList button').filter({ hasText: checklist.title }).click();
    const exported = path.join(dir, 'second-deliverable.md');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exported);
    await click('exportDraft');
    await waitText('#draftStatus', 'Markdown 已保存');
    assert.equal(await fs.readFile(exported, 'utf8'), checklist.markdown);
    const word = path.join(dir, 'second-deliverable.docx');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, word);
    await click('exportDraftDocx');
    await waitText('#draftStatus', 'Word 已保存');
    const docx = await fs.readFile(word);
    assert.equal(docx.readUInt32LE(0), 0x04034b50);
    assert(docx.includes(Buffer.from('word/document.xml')));
    if (process.platform === 'darwin') {
      const xml = execFileSync('/usr/bin/unzip', ['-p', word, 'word/document.xml'], { encoding: 'utf8' });
      const numbering = execFileSync('/usr/bin/unzip', ['-p', word, 'word/numbering.xml'], { encoding: 'utf8' });
      assert.equal(xml.match(/>复核清单</g)?.length, 1);
      assert.match(xml, /w:pStyle w:val="Heading2"/);
      assert.match(xml, /更新项目邮件组/);
      assert.doesNotMatch(xml, />\[[x ]\]</i);
      for (const marker of ['%1.', '☐', '☑']) assert(numbering.includes(`<w:lvlText w:val="${marker}"`));
    }
    await click('closeDraft');
    await click('closeTaskPane');

    await click('schedulesButton');
    await page.locator('#scheduleName').fill('发布资料简报');
    await page.locator('#schedulePrompt').fill(scheduledPrompt);
    await page.locator('#scheduleProject').selectOption('launch');
    await page.locator('#scheduleFrequency').selectOption('weekly');
    await page.locator('#scheduleWeekday').selectOption('5');
    await click('saveSchedule');
    await waitText('#scheduleStatus', '计划已保存');
    await click('runSchedule');
    await waitText('#scheduleResult', '已完成');
    assert(fixture.seen.scheduleTools.includes('read_file'));
    assert(fixture.seen.scheduleTools.includes('save_task_draft'));
    assert(!fixture.seen.scheduleTools.some(name => /write_file|run_command|ask_user|delegate_analysis|fetch_url|^mcp_/.test(name)));
    const visibleResultAction = () => {
      const button = document.getElementById('openScheduleResult');
      const { x, y, width, height } = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    };
    assert(await page.evaluate(visibleResultAction));
    await capture('schedule-dark-compact');
    await page.locator('.schedule-form-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert(await page.evaluate(visibleResultAction));
    await page.locator('.schedule-form-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await capture('schedule-light-compact');
    await click('openScheduleResult');
    await waitText('#chat', '定时简报已归档');
    assert.equal(await page.locator('#draftShortcutName').textContent(), '定时简报');
    const runId = (await page.evaluate(() => window.nova.schedules.list()))[0].lastRun.conversationId;

    // The app is about to open again. Seed one due recurrence in the isolated profile.
    await app.close();
    app = null;
    const existing = store.read('schedules', [])[0];
    store.write('schedules', [{ ...existing, enabled: true, nextAt: Date.now() - 1000 }]);
    app = await launch();
    page = await app.firstWindow();
    await enterWorkspace(page);
    watch();
    await ready();
    await click('schedulesButton');
    await page.locator('#schedulesDialog').waitFor();
    try {
      await page.waitForFunction(() => document.getElementById('scheduleLast').textContent.includes('已完成'));
    } catch (error) {
      const row = store.read('schedules', [])[0];
      const last = await page.locator('#scheduleLast').textContent();
      error.message += `\nAutomatic schedule: ${JSON.stringify({ last, state: row.lastRun, nextInMs: row.nextAt - Date.now() })}`;
      throw error;
    }
    const automatic = (await page.evaluate(() => window.nova.schedules.list()))[0];
    assert.notEqual(automatic.lastRun.conversationId, runId);
    assert(automatic.nextAt > Date.now());
    await click('closeSchedules');
    await select(launchTask);
    await waitText('#chat', '发布简报和复核清单');
    assert.match(await page.locator('#chat').textContent(), /面向产品团队/);
    await click('draftShortcut');
    assert.equal(await page.locator('#draftList button').count(), 2);
    await changeRow().click();
    await waitText('#changeReviewBody .diff-remove', '核对邀请名单');
    await click('closeChangeReview');
    await click('closeTaskPane');
    await pick(anotherWorkspace);
    await click('workspace');
    await waitText('#workspaceLabel', '客户访谈');
    await click('changesShortcut');
    await changeRow().click();
    await waitText('#changeReviewBody .diff-add', '复核定稿时间');
    assert.equal(await page.locator('#openCurrentFile').isVisible(), false);
    await click('closeChangeReview');
    const journal = path.join(dir, 'WorkspaceReviews');
    assert.equal((await fs.readdir(journal)).length, 1);
    await page.evaluate(() => window.nova.conversations.delete('launch'));
    assert.deepEqual(await fs.readdir(journal), []);
    assert.equal(await fs.readFile(path.join(workspace, 'checklist.md'), 'utf8'), currentText);
    assert.deepEqual(errors, []);
    assert.equal(fixture.seen.error, undefined);
    console.log('PASS: Folder filtering and attachment scope, approval/denial/conflict, original and written versions after restart, journal isolation and deletion, concurrent analysis, live steering, clarity prompts, skill import, Markdown/Word export, and read-only schedules.');
  } finally {
    if (app) await app.close();
    fixture.server.closeAllConnections();
    fixture.server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
