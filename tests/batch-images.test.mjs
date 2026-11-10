import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {utf8ToBase64} from '../worker.js';

const ORIGIN='https://blobzpass.iob-ybbolb.workers.dev';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function decode(html){
  const payload=html.match(/<pre id="output">([^<]*)<\/pre>/)?.[1];
  assert.ok(payload,'Base64 envelope missing');
  const packet=Buffer.from(payload,'base64');
  const manifestLength=packet.readUInt32BE(0);
  const manifest=JSON.parse(packet.subarray(4,4+manifestLength).toString());
  const data=packet.subarray(4+manifestLength);
  const outputs=manifest.items.map(item=>({
    ...item,bytes:data.subarray(item.offset,item.offset+item.length)
  }));
  return {manifest,outputs};
}
function batchUrl(items){
  return ORIGIN+'/?batch='+encodeURIComponent(utf8ToBase64(JSON.stringify({items})));
}

test('45 image URLs in one Worker invocation: max 45 fetches, six concurrent, binary and metadata preserved',async()=>{
  const original=globalThis.fetch;
  const seen=[];let active=0,maxActive=0;
  globalThis.fetch=async(url)=>{
    active++;maxActive=Math.max(maxActive,active);seen.push(url);
    await delay(4);
    active--;
    const id=Number(new URL(url).searchParams.get('i'));
    return new Response(Uint8Array.of(137,80,78,71,id), {status:id===7?206:200,
      headers:{'content-type':'image/png','cache-control':'max-age=30'}});
  };
  try{
    const items=Array.from({length:45},(_,i)=>({url:`https://img.example.org/sprite.png?i=${i}`,headers:{accept:'image/*'}}));
    const response=await worker.fetch(new Request(batchUrl(items)),{});
    assert.equal(response.status,200);
    const html=await response.text();
    assert.match(html,/application\/x-blobzpass-batch/);
    const {manifest,outputs}=decode(html);
    assert.equal(manifest.version,1);
    assert.equal(seen.length,45);
    assert.ok(maxActive<=6,`Too much concurrency: ${maxActive}`);
    assert.ok(maxActive>=2,`Batch did not run concurrently: ${maxActive}`);
    assert.equal(outputs.length,45);
    for(let i=0;i<45;i++){
      assert.equal(outputs[i].url,items[i].url);
      assert.equal(outputs[i].status,i===7?206:200);
      assert.equal(outputs[i].mime,'image/png');
      assert.equal(outputs[i].headers['cache-control'],'max-age=30');
      assert.deepEqual([...outputs[i].bytes],[137,80,78,71,i]);
    }
  }finally{globalThis.fetch=original;}
});

test('batch redirects share a strict 45-external-subrequest budget',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async (url)=>{
    calls++;
    return new Response(null,{status:302,headers:{location:'/next.png'}});
  };
  try{
    const items=Array.from({length:45},(_,i)=>({url:`https://img.example.org/${i}.png`}));
    const res=await worker.fetch(new Request(batchUrl(items)),{});
    assert.equal(res.status,200);
    const {outputs}=decode(await res.text());
    assert.ok(calls<=45,`Exceeded reserved budget: ${calls}`);
    assert.ok(outputs.some(item=>item.retry),'Budget overflow should be returned for individual retry');
  }finally{globalThis.fetch=original;}
});

test('oversized images get a retry flag, and invalid/too many targets are rejected',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(new Uint8Array(520*1024),{headers:{'content-type':'image/jpeg'}});
  try{
    const res=await worker.fetch(new Request(batchUrl([{url:'https://cdn.example.org/big.jpg'}])),{});
    const {outputs}=decode(await res.text());
    assert.equal(outputs[0].retry,true);
    assert.equal(outputs[0].length,0);
    const tooMany=await worker.fetch(new Request(batchUrl(Array.from({length:46},()=>({url:'https://cdn.example.org/x.png'})))),{});
    assert.equal(tooMany.status,400);
    const privateTarget=await worker.fetch(new Request(batchUrl([{url:'http://127.0.0.1/private.png'}])),{});
    assert.equal(privateTarget.status,400);
  }finally{globalThis.fetch=original;}
});
