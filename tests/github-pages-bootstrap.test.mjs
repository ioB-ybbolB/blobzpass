import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import worker,{rewriteHtml} from '../worker.js';

const content=readFileSync(new URL('../content.html',import.meta.url),'utf8');

test('content.html registers under GitHub Pages scope and retains nested URL parameters',async()=>{
  const target='https://example.org/demon/42?url=https%3A%2F%2Fnested.example%2F%3Fx%3D1%26y%3D2&plus=a%2Bb';
  const loc=new URL('https://iob-ybbolb.github.io/blobzpass/content.html?url='+encodeURIComponent(target));
  let registered,redirected;
  const script=content.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const context={
    location:{href:loc.href,search:loc.search,replace(value){redirected=value;}},
    navigator:{serviceWorker:{controller:{},ready:Promise.resolve(),async register(scriptUrl,options){registered={scriptUrl,...options};return {};}}},
    document:{getElementById(){return {textContent:''};}},
    TextEncoder,URL,URLSearchParams,btoa,Uint8Array,setTimeout,clearTimeout,console
  };
  vm.runInNewContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(registered.scriptUrl,'/blobzpass/sw.js');
  assert.equal(registered.scope,'/blobzpass/');
  assert.ok(redirected.startsWith('/blobzpass/__bp__/o/'),redirected);
  const match=redirected.match(/^\/blobzpass\/__bp__\/o\/([^/]+)(\/.*)$/);
  assert.ok(match);
  assert.equal(Buffer.from(match[1],'base64url').toString(),'https://example.org');
  assert.equal(match[2],'/demon/42?url=https%3A%2F%2Fnested.example%2F%3Fx%3D1%26y%3D2&plus=a%2Bb');
});

test('Worker injects the scoped bridge URL and rejects invalid v2 path prefixes',async()=>{
  const original=globalThis.HTMLRewriter;let bridgePath;
  globalThis.HTMLRewriter=class{
    on(selector,callbacks){if(selector==='head')this.head=callbacks;return this;}
    transform(response){this.head.element({prepend(html){bridgePath=html;}});return response;}
  };
  try{
    rewriteHtml('<html><head></head><body></body></html>','https://example.org/','v2','/blobzpass/__bp__/');
    assert.equal(bridgePath,'<script src="/blobzpass/__bp__/bridge.js"></script>');
  }finally{
    if(original===undefined)delete globalThis.HTMLRewriter;
    else globalThis.HTMLRewriter=original;
  }
  const query=new URLSearchParams({url:Buffer.from('https://example.org/').toString('base64'),v2:'1',v2prefix:'//evil/__bp__/' });
  const response=await worker.fetch(new Request('https://blobzpass.example/?'+query),{});
  assert.equal(response.status,400);
});
