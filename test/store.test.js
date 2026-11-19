const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store');
test('atomic private storage restores data and rejects corrupt JSON',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoxiao-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir);
 assert.deepEqual(store.read('conversations',[]),[]);
 store.write('conversations',[{id:'test',messages:[{role:'user',content:'hello'}]}]);
 assert.equal(new Store(dir).read('conversations',[])[0].messages[0].content,'hello');
 assert.equal(fs.statSync(path.join(dir,'conversations.json')).mode&0o777,0o600);
 assert.deepEqual(fs.readdirSync(dir),['conversations.json']);
 fs.writeFileSync(path.join(dir,'conversations.json'),'{broken');
 assert.throws(()=>store.read('conversations',[]),/无法读取/);
});
