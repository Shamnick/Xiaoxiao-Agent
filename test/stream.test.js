const test=require('node:test'),assert=require('node:assert/strict');
const {runAgent,config}=require('../src/providers');
const p=kind=>({...config({kind,name:'fixture',model:'fixture'}),key:'fixture'});
function sse(events){
  const text=events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');
  const bytes=new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});
}
test('OpenAI streaming tool arguments and multibyte text across chunks',async()=>{
  const bodies=[],output=[];
  const request=async(_,options)=>{
    bodies.push(JSON.parse(options.body));
    if(bodies.length===1)return sse([
      {choices:[{delta:{content:'检查：'}}]},
      {choices:[{delta:{tool_calls:[{index:0,id:'call1',function:{name:'read_file',arguments:'{"path":'}}]}}]},
      {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"a.txt"}'}}]},finish_reason:'tool_calls'}]}
    ]);
    return sse([{choices:[{delta:{content:'完成 ✓'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]}]);
  };
  let executed=0;
  const text=await runAgent(p('openai-compatible'),[{role:'user',content:'inspect'}],{request,onEvent:e=>{if(e.type==='text')output.push(e.text);},tools:[{name:'read_file',description:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},execute:args=>{assert.equal(args.path,'a.txt');executed++;return 'fixture';}}]});
  assert.equal(text,'检查：完成 ✓');assert.equal(output.join(''),text);assert.equal(executed,1);
  assert.equal(bodies[1].messages.at(-1).tool_call_id,'call1');
});
test('Anthropic streaming structured tool result and final answer',async()=>{
  const bodies=[];
  const request=async(_,options)=>{
    bodies.push(JSON.parse(options.body));
    return bodies.length===1?sse([
      {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call1',name:'read_file',input:{}}},
      {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"path":"a"}'}},
      {type:'message_stop'}
    ]):sse([
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'你好'}},
      {type:'message_stop'}
    ]);
  };
  assert.equal(await runAgent(p('anthropic'),[{role:'user',content:'inspect'}],{request,tools:[{name:'read_file',description:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},execute:()=> 'fixture'}]}),'你好');
  assert.deepEqual(bodies[1].messages.at(-1).content,[{type:'tool_result',tool_use_id:'call1',content:'fixture'}]);
});
test('incomplete stream fails instead of saving a partial response as completed',async()=>{
  await assert.rejects(runAgent(p('openai-compatible'),[{role:'user',content:'hi'}],{request:async()=>sse([{choices:[{delta:{content:'partial'}}]}])}),/中途断开/);
});
test('invalid schema arguments do not execute a tool',async()=>{
  let executed=false;
  await assert.rejects(runAgent(p('openai-compatible'),[{role:'user',content:'hi'}],{request:async()=>Response.json({choices:[{message:{tool_calls:[{id:'1',function:{name:'write',arguments:'{"path":5}'}}]}}]}),tools:[{name:'write',description:'write',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},execute:()=>{executed=true;}}]}),/参数无效/);
  assert.equal(executed,false);
});
test('step budget bounds an endlessly requesting agent',async()=>{
  let count=0;
  await assert.rejects(runAgent(p('openai-compatible'),[{role:'user',content:'hi'}],{maxSteps:2,request:async()=>Response.json({choices:[{message:{tool_calls:[{id:'1',function:{name:'read',arguments:'{}'}}]}}]}),tools:[{name:'read',description:'read',parameters:{type:'object',properties:{}},execute:()=>{count++;return 'ok';}}]}),/上限/);
  assert.equal(count,2);
});
test('preserves compatible reasoning and Gemini tool signatures in followup',async()=>{
  let followup;
  let n=0;
  const request=async(_,opts)=>{
    const body=JSON.parse(opts.body);
    if(n++===0)return Response.json({choices:[{message:{content:'',reasoning_content:'private provider reasoning',tool_calls:[{id:'call1',type:'function',function:{name:'read',arguments:'{}'},extra_content:{google:{thought_signature:'fixture-signature'}}}]}}]});
    followup=body.messages;return Response.json({choices:[{message:{content:'done'}}]});
  };
  assert.equal(await runAgent(p('openai-compatible'),[{role:'user',content:'read'}],{request,tools:[{name:'read',description:'read',parameters:{type:'object',properties:{}},execute:()=> 'ok'}]}),'done');
  assert.equal(followup[1].reasoning_content,'private provider reasoning');
  assert.equal(followup[1].tool_calls[0].extra_content.google.thought_signature,'fixture-signature');
});
