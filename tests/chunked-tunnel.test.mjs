import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{WebSocketBridge,utf8ToBase64,bytesToBase64} from '../worker.js';

function parseEnvelope(html) {
  const m=/<pre id="output">([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(m,'expected HTML Base64 envelope');
  return Buffer.from(m[1],'base64').toString('utf8');
}
function storageStub() {
  const data=new Map();
  return {
    get:async key=>data.get(key),put:async(key,val)=>{data.set(key,val);},
    deleteAll:async()=>{data.clear();},setAlarm:async()=>{},
    get size(){return data.size;}
  };
}
function envStub() {
  const stores=new Map();
  const env={};
  env.WS_BRIDGE={
    idFromName(name){return name;},
    get(id){
      if(!stores.has(id)) {
        const store=storageStub();
        const obj=new WebSocketBridge({storage:store},env);
        stores.set(id,{obj,store});
      }
      return {fetch:req=>stores.get(id).obj.fetch(req)};
    }
  };
  return {env,stores};
}
const workerBase='https://blobzpass.iob-ybbolb.workers.dev/';
const id='123e4567-e89b-42d3-a456-426614174000';
function stagedUrl(part,total,data) {
  return workerBase+'?'+new URLSearchParams({tunnel:'stage',id,part:String(part),total:String(total),data});
}
async function stageQuery(env,raw) {
  const size=1500,total=Math.ceil(raw.length/size);
  for(let i=0;i<total;i++) {
    const fragment=raw.slice(i*size,(i+1)*size);
    const data=Buffer.from(fragment,'utf8').toString('base64url');
    const requestUrl=stagedUrl(i,total,data);
    assert.ok(requestUrl.length<5000,`staged fragment ${i} too long (${requestUrl.length})`);
    const response=await worker.fetch(new Request(requestUrl),env);
    assert.deepEqual(JSON.parse(parseEnvelope(await response.text())),{ok:true,part:i});
  }
  return total;
}

test('64 KB POST can be replayed using bounded GET fragments and a one-use Durable Object',async()=>{
  const {env,stores}=envStub();
  const savedFetch=globalThis.fetch;
  const body=new Uint8Array(64000);
  for(let i=0;i<body.length;i++) body[i]=(i*101+i%27)&255;
  const raw=new URLSearchParams({url:utf8ToBase64('https://example.org/api'),viewer:'1',method:'POST',body:bytesToBase64(body),headers:utf8ToBase64(JSON.stringify({'content-type':'application/octet-stream'}))}).toString();
  assert.ok(raw.length>20000);
  let called=0;
  globalThis.fetch=async(url,opts)=>{
    called++;
    assert.equal(url,'https://example.org/api');assert.equal(opts.method,'POST');
    assert.equal(opts.headers.get('content-type'),'application/octet-stream');
    assert.deepEqual(new Uint8Array(opts.body),body);
    return new Response('POST-OK',{headers:{'content-type':'text/plain'}});
  };
  try {
    const total=await stageQuery(env,raw);
    assert.ok(total>=40 && total<=128,`staged fragments: ${total}`);
    const finished=await worker.fetch(new Request(workerBase+'?tunnel=commit&id='+id),env);
    assert.equal(parseEnvelope(await finished.text()),'POST-OK');
    assert.equal(called,1);
    assert.equal(stores.get('blobzpass-request:'+id).store.size,0,'single-use tunnel clears stored fragments');
    const replay=await worker.fetch(new Request(workerBase+'?tunnel=commit&id='+id),env);
    assert.equal(replay.status,200); // Outer transport always HTML 200.
    assert.match(parseEnvelope(await replay.text()),/Staged request missing or expired/);
    assert.equal(called,1,'cannot replay an already committed POST');
  } finally {globalThis.fetch=savedFetch;}
});

test('Staged tunnel rejects missing fragments without contacting the destination',async()=>{
  const {env}=envStub();
  const savedFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('unexpected upstream fetch');};
  try {
    const payload=Buffer.from('url='+utf8ToBase64('https://example.org/missing')).toString('base64url');
    const request=await worker.fetch(new Request(stagedUrl(0,2,payload)),env);
    assert.equal(JSON.parse(parseEnvelope(await request.text())).ok,true);
    const res=await worker.fetch(new Request(workerBase+'?tunnel=commit&id='+id),env);
    assert.match(parseEnvelope(await res.text()),/Missing staged tunnel fragment/);
  } finally {globalThis.fetch=savedFetch;}
});

test('Staged WebSocket sends dispatch to the existing bridge (no new namespace)',async()=>{
  const {env,stores}=envStub();
  const wsId='6f0e3b8e-9011-4f7a-81b2-ab026ef7b193';
  const calls=[];
  env.WS_BRIDGE.get=function(target){
    if(target==='blobzpass-ws:'+wsId) return {fetch:async request=>{
      calls.push(new URL(request.url));return new Response(JSON.stringify({ok:true}));
    }};
    if(!stores.has(target)){
      const store=storageStub(); stores.set(target,{obj:new WebSocketBridge({storage:store},env),store});
    }
    return {fetch:req=>stores.get(target).obj.fetch(req)};
  };
  const message=Buffer.alloc(8192,0xa6).toString('base64');
  const raw=new URLSearchParams({ws_action:'send',ws_id:wsId,data:message,binary:'1'}).toString();
  await stageQuery(env,raw);
  const res=await worker.fetch(new Request(workerBase+'?tunnel=commit&id='+id),env);
  assert.deepEqual(JSON.parse(parseEnvelope(await res.text())),{ok:true});
  assert.equal(calls.length,1);
  assert.equal(calls[0].pathname,'/send');
  assert.equal(Buffer.from(calls[0].searchParams.get('data'),'base64').length,8192);
});

test('staged image batch replays through the existing WebSocketBridge Durable Object',async()=>{
  const {env,stores}=envStub();
  const original=globalThis.fetch;
  const urls=Array.from({length:40},(_,i)=>({url:`https://images.example.net/${i}/sprite.png?size=small&quality=90`}));
  const raw=new URLSearchParams({batch:utf8ToBase64(JSON.stringify({items:urls}))}).toString();
  assert.ok(raw.length>1900);
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(Uint8Array.of(0x89,0x50,0x4e,0x47),{headers:{'content-type':'image/png'}});};
  try{
    await stageQuery(env,raw);
    const response=await worker.fetch(new Request(workerBase+'?tunnel=commit&id='+id),env);
    const body=Buffer.from(/<pre id="output">([^<]*)<\/pre>/.exec(await response.text())[1],'base64');
    const manifestSize=body.readUInt32BE(0);
    const manifest=JSON.parse(body.subarray(4,4+manifestSize).toString());
    assert.equal(manifest.items.length,40);
    assert.equal(calls,40);
    assert.equal(manifest.items[30].length,4);
    assert.equal(stores.get('blobzpass-request:'+id).store.size,0);
  } finally{globalThis.fetch=original;}
});
