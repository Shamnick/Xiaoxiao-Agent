'use strict';
const { _electron: electron } = require('playwright');
const { Store } = require('../src/store');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'xiaoxiao-scale-'));
  let app;
  try {
    const rows = Array.from({length:1000}, (_, i) => ({
      id:'history-'+i,title:'历史样本 '+i,updatedAt:1000-i,
      messages:Array.from({length:20},(_,j)=>({role:j%2?'assistant':'user',content:'合成的项目修改记录。'.repeat(6)+(j===19?' 检索编号-'+String(i).padStart(4,'0'):'')}))
    }));
    new Store(dir).write('conversations',rows);
    const executablePath = process.env.XIAOXIAO_SMOKE_EXECUTABLE;
    const start = performance.now();
    app = await electron.launch({executablePath,args:executablePath?[]:['.'],cwd:path.resolve(__dirname,'..'),env:{...process.env,XIAOXIAO_SMOKE_DIR:dir}});
    const page = await app.firstWindow();
    await page.locator('#presenceKnot:enabled').waitFor();
    const startupMs = Math.round(performance.now()-start);
    await page.keyboard.press('ControlOrMeta+k');
    const searchMs = [];
    const query = page.locator('#historyQuery');
    for (const i of [999,500,1,275,821,106,578,730,46,390]) {
      const begin = performance.now();
      await query.fill('检索编号-'+String(i).padStart(4,'0'));
      await page.locator('#historyResults strong').getByText('历史样本 '+i,{exact:true}).waitFor();
      assert.equal(await page.locator('#historyResults button').count(),1);
      searchMs.push(Math.round(performance.now()-begin));
    }
    await query.press('Enter');
    await page.waitForFunction(()=>document.activeElement.dataset.messageIndex==='19');
    const report = {conversations:rows.length,messages:20000,bytes:(await fs.stat(path.join(dir,'conversations.json'))).size,startupMs,searchMs};
    if (process.env.XIAOXIAO_SMOKE_QA_DIR) {
      const out = process.env.XIAOXIAO_SMOKE_QA_DIR;
      await fs.mkdir(out,{recursive:true});
      await fs.writeFile(path.join(out,'history-scale.json'),JSON.stringify(report,null,2));
    }
    console.log('PASS',report);
  } finally { try { await app?.close(); } finally { await fs.rm(dir,{recursive:true,force:true}); } }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
