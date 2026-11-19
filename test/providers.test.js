const test = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const {config,run} = require('../src/providers');
const doc = {name:'notes.txt',text:'fixture text'};
const messages = [{role:'user',content:'Summarize this file.'}];
for (const kind of ['openai-compatible','anthropic','ollama']) test(kind + ' request and tool round-trip', async t => {
  const requests = [];
  const claude = kind === 'anthropic';
  const wrap = message => claude ? {content:message} : {choices:[{message}]};
  const server = createServer(async (req,res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({url:req.url,headers:req.headers,...JSON.parse(raw)});
    const tool = claude ? [{type:'tool_use', name:'read_selected_document', input:{}, id:'file'}] : {content:null,tool_calls:[{id:'file',type:'function',function:{name:'read_selected_document',arguments:'{}'}}]};
    const response = requests.length === 1 ? tool : (claude ? [{type:'text',text:'Summary'}] : {content:'Summary'});
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(wrap(response)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const provider = config({kind,name:'test',model:'test-model',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1/'});
  if (kind !== 'ollama') provider.key = 'test-key';
  const files = [];
  assert.equal(await run(provider,messages,doc,AbortSignal.timeout(5000),fetch,name=>files.push(name)),'Summary');
  assert.equal(requests.length,2);
  assert.equal(requests[0].url,claude ? '/v1/messages' : '/v1/chat/completions');
  assert.equal(requests[0].headers[claude?'x-api-key':'authorization'],claude ? 'test-key' : kind==='ollama' ? undefined : 'Bearer test-key');
  assert.equal(requests[0].tools.length,1);
  assert.equal(requests[1].tools.length,1);
  assert.match(JSON.stringify(requests[1].messages.at(-1)),/fixture text/);
  assert.deepEqual(files,['notes.txt']);
});
test('rejects an unauthorized tool before exposing document contents',async()=>{
  let requests = 0;
  const fake = async()=>{requests++; return Response.json({choices:[{message:{tool_calls:[{id:'bad',function:{name:'arbitrary_tool',arguments:'{}'}}]}}]});};
  await assert.rejects(run(config({kind:'openai-compatible',name:'test',model:'test'}),messages,doc,undefined,fake),/工具调用参数无效/);
  assert.equal(requests,1);
});
