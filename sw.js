/* blobzpass v2 – Service Worker on a SINGLE (viewer + proxied content) origin.
 * All proxied upstream HTTP requests are GETs to Noteboard, never direct
 * fetches from a website and never direct calls to the blobzpass Worker.
 * Deploy at /blobzpass/sw.js with scope /blobzpass/ on GitHub Pages.
 */
'use strict';
const NOTEBOARD = 'https://www.noteboardapp.com/showCodeFile.php?file=';
const WORKER_ORIGIN = 'https://blobzpass.iob-ybbolb.workers.dev';
const APP_BASE = new URL(self.registration.scope).pathname; // e.g. /blobzpass/
const PROXY_BASE = APP_BASE + '__bp__/';
const PROXY_PREFIX = PROXY_BASE + 'o/';
const OUTER_URL_BUDGET = 1900;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_STAGE_PARTS = 256;
const STAGE_PART_CHARS = 850;
const METHODS = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE']);
const ALLOWED_HEADERS = ['accept','accept-language','content-type','authorization','x-requested-with','x-csrf-token','x-xsrf-token','if-none-match','if-modified-since'];

const te = new TextEncoder();
const td = new TextDecoder();
function toB64(bytes) {
  let output = '';
  for (let i = 0; i < bytes.length; i += 12000) {
    output += btoa(String.fromCharCode(...bytes.subarray(i, i + 12000)));
  }
  // 12000 is divisible by 3, so only the final block has padding.
  return output;
}
function fromB64(text) {
  const b = atob(text);
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return bytes;
}
function encodeURLOrigin(origin) { return toB64(te.encode(origin)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function decodeURLOrigin(segment) {
  if (!/^[\w-]{1,512}$/.test(segment)) throw Error('Invalid proxy origin');
  const value = td.decode(fromB64(segment.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4 - segment.length % 4) % 4)));
  const url = new URL(value);
  if (!['https:','http:'].includes(url.protocol) || url.href !== url.origin + '/') throw Error('Invalid proxy origin');
  return url.origin;
}
function proxyRoute(raw) {
  const u = new URL(raw);
  if (!['http:','https:'].includes(u.protocol)) throw Error('Unsupported URL scheme');
  return PROXY_PREFIX + encodeURLOrigin(u.origin) + u.pathname + u.search + u.hash;
}
function targetFromRoute(pathAndQuery) {
  const url = new URL(pathAndQuery, self.location.origin);
  if (!url.pathname.startsWith(PROXY_PREFIX)) return null;
  const rest = url.pathname.slice(PROXY_PREFIX.length);
  const index = rest.indexOf('/');
  if (index < 0) return null;
  const origin = decodeURLOrigin(rest.slice(0,index));
  return origin + rest.slice(index) + url.search;
}

function extractEnvelope(html) {
  const m = /<meta\s+name="blobzpass-meta"\s+content="([a-zA-Z0-9+/=]+)"/i.exec(html);
  const payload = /<pre\s+id="output"[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (!m || !payload) throw Error('Noteboard did not return a blobzpass envelope (CORS, HTTP gateway, or response changed)');
  const metadata = JSON.parse(td.decode(fromB64(m[1])));
  return {metadata, bytes:fromB64(payload[1].replace(/\s/g,''))};
}
async function readWrapped(outer) {
  const r = await fetch(outer,{redirect:'follow',cache:'no-store',credentials:'omit'});
  if (r.status === 414) throw Error('HTTP 414 URI Too Long');
  if (!r.ok) throw Error('Noteboard HTTP ' + r.status);
  return extractEnvelope(await r.text());
}
function fromSearchParams(params) {
  const u = new URL(WORKER_ORIGIN + '/');
  u.search = params.toString();
  return NOTEBOARD + encodeURIComponent(u.href);
}
function stageOuter(id, action, part, total, text) {
  const params = new URLSearchParams({tunnel:action,id});
  if(action==='stage') {
    params.set('part',String(part)); params.set('total',String(total));
    params.set('data',toB64(te.encode(text)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''));
  }
  return fromSearchParams(params);
}
async function stageAndReplay(params) {
  // The Worker already supports this bounded single-use Durable Object tunnel.
  const raw = params.toString();
  const count = Math.ceil(raw.length/STAGE_PART_CHARS);
  if(count < 1 || count > MAX_STAGE_PARTS) throw Error('Request too large for staged GET transport');
  const id = crypto.randomUUID();
  for(let i=0;i<count;i+=3) {
    await Promise.all(Array.from({length:Math.min(3,count-i)},(_,offset)=>{
      const part=i+offset;
      const u=stageOuter(id,'stage',part,count,raw.slice(part*STAGE_PART_CHARS,(part+1)*STAGE_PART_CHARS));
      if(u.length>OUTER_URL_BUDGET) throw Error('Staged URL exceeds budget');
      return readWrapped(u).then(({metadata,bytes})=>{
        const result=JSON.parse(td.decode(bytes));
        if(metadata.status >= 400 || !result.ok) throw Error(result.error||'Stage rejected');
      });
    }));
  }
  return readWrapped(stageOuter(id,'commit'));
}
async function tunnel(params) {
  const full = fromSearchParams(params);
  if(full.length <= OUTER_URL_BUDGET) {
    try { return await readWrapped(full); }
    catch(e) { if(!/414|URI Too Long/.test(String(e))) throw e; }
  }
  return stageAndReplay(params);
}
function filterHeaders(headers) {
  const result={};
  for(const name of ALLOWED_HEADERS) {
    const value=headers.get(name);
    if (value && value.length <= 4096) result[name]=value;
  }
  return result;
}
function errorDocument(message,status=502) {
  const body = '<!doctype html><meta charset="utf-8"><title>blobzpass error</title><style>body{background:#151922;color:#efeff7;font:16px system-ui;padding:48px;line-height:1.5}pre{white-space:pre-wrap;color:#f8b3b3}</style><h1>Proxy request failed</h1><pre></pre><p>Check that Noteboard allows CORS requests from the content origin and the Worker is deployed with the v2 files.</p>';
  // Do not interpolate upstream text into HTML.
  const safe = body.replace('<pre></pre>','<pre>'+String(message).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')+'</pre>');
  return new Response(safe,{status,headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store'}});
}

async function destinationFromClient(event) {
  const id = event.clientId || event.resultingClientId;
  if(!id) return null;
  const client = await self.clients.get(id);
  if(!client) return null;
  try { return targetFromRoute(client.url); } catch { return null; }
}
// Native <img> loads are coalesced into the existing Worker image-batch
// endpoint (45 images, 6 upstream connections, 3 MiB aggregate). Each item
// still falls back to its own GET if the Worker rejects the batch or item.
const pendingImages=[];
let imageTimer=null;
async function targetForEvent(event) {
  const url=new URL(event.request.url);
  if(url.origin===self.location.origin && url.pathname.startsWith(PROXY_PREFIX))return targetFromRoute(event.request.url);
  const base=await destinationFromClient(event);
  if(!base)return null;
  return url.origin===self.location.origin
    ? new URL(url.pathname+url.search,new URL(base).origin).href : url.href;
}
function makeImageResponse(meta,bytes) {
  if(!meta || meta.retry || meta.error || !meta.status || meta.status>=400)return null;
  return new Response(bytes,{status:meta.status,headers:{'content-type':meta.mime||'application/octet-stream','cache-control':'no-store'}});
}
async function flushImages() {
  imageTimer=null;
  const pending=pendingImages.splice(0,45);
  if(!pending.length)return;
  if(pendingImages.length) imageTimer=setTimeout(flushImages,20);
  try {
    const targets=await Promise.all(pending.map(item=>targetForEvent(item.event)));
    const valid=targets.every(t=>t && /^https?:\/\//.test(t) && t.length<=2048);
    if(!valid)throw Error('Some images cannot be included in a batch');
    const batch=toB64(te.encode(JSON.stringify({items:targets.map(url=>({url}))})));
    const {bytes}=await tunnel(new URLSearchParams({batch}));
    if(bytes.length<4)throw Error('Invalid batch response');
    const len=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
    if(len>bytes.length-4 || len>100000)throw Error('Invalid batch manifest');
    const manifest=JSON.parse(td.decode(bytes.subarray(4,4+len)));
    if(manifest.version!==1 || manifest.items?.length!==pending.length)throw Error('Invalid batch shape');
    const bodyStart=4+len;
    pending.forEach((item,i)=>{
      const meta=manifest.items[i];const begin=bodyStart+meta.offset;const end=begin+meta.length;
      const response=begin>=bodyStart && end<=bytes.length && end>=begin ? makeImageResponse(meta,bytes.slice(begin,end)) : null;
      if(response)item.resolve(response);
      else proxyRequest(item.event).then(item.resolve,item.reject);
    });
  } catch(error) {
    pending.forEach(item=>proxyRequest(item.event).then(item.resolve,item.reject));
  }
}
function batchImage(event) {
  return new Promise((resolve,reject)=>{
    pendingImages.push({event,resolve,reject});
    if(pendingImages.length>=45){clearTimeout(imageTimer);imageTimer=null;void flushImages();}
    else if(!imageTimer)imageTimer=setTimeout(flushImages,20);
  });
}
async function proxyRequest(event) {
  const req=event.request;
  const url=new URL(req.url);
  let destination;
  if(url.origin===self.location.origin && url.pathname.startsWith(PROXY_PREFIX)) {
    destination=targetFromRoute(req.url);
  } else {
    const base=await destinationFromClient(event);
    if(!base) {
      // Never fall through to an unproxied third-party request.
      if(url.origin!==self.location.origin) return new Response('Unattributed third-party request denied',{status:502});
      return fetch(req); // static viewer/bootstrap assets on the same GitHub Pages site
    }
    // Root-relative requests from a controlled virtual page are mapped to its
    // original origin. Absolute remote URLs are fetched using the tunnel.
    destination=url.origin===self.location.origin
      ? new URL(url.pathname + url.search,new URL(base).origin).href
      : url.href;
    if(req.mode==='navigate' && url.origin===self.location.origin) {
      return Response.redirect(new URL(proxyRoute(destination),self.location.origin).href,302);
    }
  }
  if(!destination) return errorDocument('Invalid virtual destination',400);
  try {
    const method=req.method.toUpperCase();
    if(!METHODS.has(method)) return errorDocument('Unsupported method '+method,405);
    const params=new URLSearchParams({url:toB64(te.encode(destination)),v2:'1',v2prefix:PROXY_BASE});
    if(method!=='GET') {
      params.set('method',method);
      params.set('nonce',crypto.randomUUID());
    }
    const headers=filterHeaders(req.headers);
    if(Object.keys(headers).length) params.set('headers',toB64(te.encode(JSON.stringify(headers))));
    if(!['GET','HEAD'].includes(method)) {
      const body=new Uint8Array(await req.clone().arrayBuffer());
      if(body.length > MAX_BODY_BYTES) return errorDocument('Request body exceeds 64 KiB',413);
      if(body.length) params.set('body',toB64(body));
    }
    const {metadata,bytes}=await tunnel(params);
    if(metadata.status===414) throw Error('Upstream HTTP 414');
    if(metadata.url && /^https?:\/\//.test(metadata.url) && metadata.url!==destination && req.mode==='navigate') {
      return Response.redirect(new URL(proxyRoute(metadata.url),self.location.origin).href,method==='GET'?302:303);
    }
    const resultHeaders=new Headers();
    const mime=metadata.headers?.['content-type'] || metadata.mime || 'application/octet-stream';
    resultHeaders.set('Content-Type',mime);
    if(metadata.headers?.['content-language']) resultHeaders.set('Content-Language',metadata.headers['content-language']);
    // Site CSP, X-Frame-Options, COOP/COEP, and CORS assumptions cannot be
    // forwarded unchanged from a different origin. Same-origin proxy assets
    // are covered by the browser's normal fetch handling.
    resultHeaders.set('Cache-Control','no-store');
    const status=metadata.status;
    if(status<200||status>599) throw Error('Invalid upstream status '+status);
    return new Response(method==='HEAD'||[204,205,304].includes(status)?null:bytes,{status,headers:resultHeaders});
  } catch(error) {
    console.error('[blobzpass transport]',destination,String(error));
    return req.mode==='navigate' ? errorDocument(error?.message||error) : new Response(String(error?.message||error),{status:502,headers:{'content-type':'text/plain'}});
  }
}
self.addEventListener('install',e=>{e.waitUntil(self.skipWaiting());});
self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin===self.location.origin && url.pathname===PROXY_BASE+'ws') {
    event.respondWith((async()=>{
      try {
        const {metadata,bytes}=await tunnel(new URLSearchParams(url.search));
        return new Response(bytes,{status:metadata.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
      } catch(e) {return Response.json({ok:false,error:String(e.message||e)},{status:502});}
    })());
    return;
  }
  if(url.origin===self.location.origin && [PROXY_BASE+'bridge.js',PROXY_BASE+'config.js'].includes(url.pathname)) {
    event.respondWith(fetch(new URL(APP_BASE+url.pathname.slice(PROXY_BASE.length),self.location.origin)));
    return;
  }
  if(event.request.destination==='image' && event.request.method==='GET') {
    event.respondWith(batchImage(event));
    return;
  }
  event.respondWith(proxyRequest(event));
});
