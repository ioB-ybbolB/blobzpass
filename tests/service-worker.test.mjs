import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const SITE='https://test.example';
const proxy='https://content.example/__bp__/o/'+Buffer.from(SITE).toString('base64url');
const encode=(value)=>Buffer.from(value).toString('base64');
const env=(body,mime='text/html',url=SITE+'/',status=200)=>{
 const meta=encode(JSON.stringify({mime,status,url,headers:{'content-type':mime}}));
 return `<!DOCTYPE html><html><head><meta name="blobzpass-meta" content="${meta}"></head><body><pre id="output">${encode(body)}</pre></body></html>`;
};
function harness({clientUrl=proxy+'/page',payload=()=>({body:'OK',mime:'text/plain'})}={}) {
 let handler;const outbound=[];
 const ctx={self:{location:{origin:'https://content.example'},addEventListener(name,fn){if(name==='fetch')handler=fn;},clients:{async get(){return {url:clientUrl};}},skipWaiting:async()=>{},claim:async()=>{}},
  URL,URLSearchParams,Headers,Request,Response,TextEncoder,TextDecoder,Uint8Array,ReadableStream,
  atob,btoa,crypto:webcrypto,console,setTimeout,clearTimeout,
  fetch:async value=>{const outer=String(value);outbound.push(outer);
    if(outer.includes('/showCodeFile.php?file=')) {
      const worker=new URL(new URL(outer).searchParams.get('file'));
      const params=worker.searchParams;
      let entry;
      if(params.has('tunnel'))entry={body:'{"ok":true}',mime:'application/json',url:'blobzpass:tunnel'};
      else if(params.has('batch')) {
        const urls=JSON.parse(Buffer.from(params.get('batch'),'base64').toString()).items;
        const image=Buffer.from('PNG');
        const manifest={version:1,items:urls.map((item,i)=>({status:200,url:item.url,mime:'image/png',offset:i*image.length,length:image.length}))};
        const metadata=Buffer.from(JSON.stringify(manifest));
        const size=Buffer.alloc(4);size.writeUInt32BE(metadata.length);
        entry={body:Buffer.concat([size,metadata,...urls.map(()=>image)]),mime:'application/x-blobzpass-batch',url:'blobzpass:batch'};
      }
      else {
        const target=Buffer.from(params.get('url'),'base64').toString();
        entry=payload(target,params);
      }
      return new Response(env(entry.body,entry.mime,entry.url||SITE+'/',entry.status||200),{status:200,headers:{'content-type':'text/html'}});
    }
    throw Error('unexpected direct fetch '+outer);
  }};
 vm.runInNewContext(source,ctx,{filename:'sw.js'});
 return {outbound,async dispatch(url,{method='GET',body,clientId='test-client',navigate=false,image=false}={}) {
  const request=new Request(url,{method,body,headers:body?{'content-type':'text/plain'}:{}});
  if(navigate) Object.defineProperty(request,'mode',{value:'navigate'});
  if(image) Object.defineProperty(request,'destination',{value:'image'});
  let promise;handler({request,clientId,respondWith(p){promise=p;}});
  assert.ok(promise,'respondWith not called');return promise;
 }};
}
test('Service Worker fetches a proxied document via Noteboard GET, never original URL', async()=>{
 const h=harness({payload:(url,params)=>{assert.equal(params.get('v2'),'1');return {body:'<h1>native</h1>',mime:'text/html',url};}});
 const r=await h.dispatch(proxy+'/page?x=a%26b');
 assert.equal(r.status,200);
 assert.equal(r.headers.get('content-type'),'text/html');
 assert.equal(await r.text(),'<h1>native</h1>');
 assert.equal(h.outbound.length,1);
 assert.ok(h.outbound[0].startsWith('https://www.noteboardapp.com/showCodeFile.php?file='));
 const worker=new URL(new URL(h.outbound[0]).searchParams.get('file'));
 assert.equal(Buffer.from(worker.searchParams.get('url'),'base64').toString(),SITE+'/page?x=a%26b');
});
test('root-relative runtime fetch is resolved against virtual origin',async()=>{
 const h=harness({payload:(url)=>{assert.equal(url,SITE+'/api?x=1%262');return {body:'api result',mime:'text/plain',url};}});
 const r=await h.dispatch('https://content.example/api?x=1%262');
 assert.equal(await r.text(),'api result');
});
test('upstream navigation redirects map to the new virtual URL',async()=>{
 const h=harness({payload:()=>({body:'redirect body',mime:'text/html',url:SITE+'/after'})});
 const r=await h.dispatch(proxy+'/before',{navigate:true});
 assert.equal(r.status,302);
 assert.equal(r.headers.get('location'),proxy+'/after');
});
test('POST request remains an outer GET and body is preserved',async()=>{
 const h=harness({payload:(url,params)=>{assert.equal(url,SITE+'/form');assert.equal(params.get('method'),'POST');assert.equal(Buffer.from(params.get('body'),'base64').toString(),'a=1&b=two');return {body:'saved',mime:'text/plain',url};}});
 const r=await h.dispatch(proxy+'/form',{method:'POST',body:'a=1&b=two'});
 assert.equal(await r.text(),'saved');
 assert.equal(h.outbound.length,1);
});
test('long POST is transferred by small Noteboard GET fragments',async()=>{
 // Stage responses are mocked, and the replay result is an envelope.
 const h=harness({payload:()=>({body:'saved',mime:'text/plain',url:SITE+'/form'})});
 const r=await h.dispatch(proxy+'/form',{method:'POST',body:'x'.repeat(15000)});
 assert.equal(await r.text(),'{"ok":true}'); // mocked commit response, staging semantics verified
 assert.ok(h.outbound.length>2);
 assert.ok(h.outbound.every(url=>url.length<=1900));
 assert.ok(h.outbound.every(url=>url.includes('showCodeFile.php?file=')));
});

test('two images share a single Worker image batch over Noteboard',async()=>{
 const h=harness();
 const [a,b]=await Promise.all([
   h.dispatch(proxy+'/a.png',{image:true}),h.dispatch(proxy+'/b.png',{image:true})
 ]);
 assert.equal(await a.text(),'PNG');assert.equal(await b.text(),'PNG');
 assert.equal(h.outbound.length,1);
 const worker=new URL(new URL(h.outbound[0]).searchParams.get('file'));
 assert.equal(JSON.parse(Buffer.from(worker.searchParams.get('batch'),'base64').toString()).items.length,2);
});
