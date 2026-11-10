import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import worker, {CookieSession,utf8ToBase64,base64ToUtf8,wrapUrl,rewriteCss,rewriteSrcset,validatePublicTarget} from '../worker.js';

const workerOrigin = 'https://blobzpass.iob-ybbolb.workers.dev';
const noteboardOrigin = 'https://www.noteboardapp.com';
function unwrap(url) {
  const nb = new URL(url);
  assert.equal(nb.origin, noteboardOrigin);
  assert.equal(nb.pathname, '/showCodeFile.php');
  const intermediary = new URL(nb.searchParams.get('file'));
  assert.equal(intermediary.origin, workerOrigin);
  return base64ToUtf8(intermediary.searchParams.get('url'));
}

test('UTF-8 Base64 roundtrip for Unicode URLs', () => {
  const original = 'https://example.org/π?q=🌍&message=é';
  assert.equal(base64ToUtf8(utf8ToBase64(original)), original);
});

test('URL double nesting matches standalone link chain', () => {
  const target = 'https://www.example.org/a?x=1&y=Z#fragment';
  const nested = wrapUrl(target);
  assert.ok(nested.startsWith('https://www.noteboardapp.com/showCodeFile.php?file='));
  assert.equal(unwrap(nested), target);
});

test('CSS url() and @import recursively use Noteboard transport', () => {
  const result = rewriteCss('a{background:url(../img/pic.png)} @import "./main.css";', 'https://example.org/css/style.css');
  const urls = [...result.matchAll(/https:\/\/www\.noteboardapp\.com\/showCodeFile\.php\?file=[^"\s)]+/g)];
  assert.equal(urls.length, 2);
  assert.equal(unwrap(urls[0][0]), 'https://example.org/img/pic.png');
  assert.equal(unwrap(urls[1][0]), 'https://example.org/css/main.css');
});

test('srcset rewrites each URL, not descriptor text', () => {
  const srcset = rewriteSrcset('one.jpg 1x, /two.jpg 2x', 'https://example.org/sub/page');
  assert.ok(srcset.includes(' 1x, '));
  assert.ok(srcset.endsWith(' 2x'));
  assert.equal((srcset.match(/noteboardapp/g) || []).length, 2);
});

test('private/local/numeric targets are rejected', () => {
  for (const bad of [
    'http://127.0.0.1/path', 'http://10.0.0.1', 'http://[::1]',
    'http://localhost', 'http://local.internal', 'file:///etc/passwd', 'https://example.com:8080'
  ]) assert.throws(() => validatePublicTarget(bad, {}), undefined, bad);
  assert.equal(validatePublicTarget('https://sub.example.com', {}).hostname, 'sub.example.com');
  assert.throws(() => validatePublicTarget('https://unlisted.com', {ALLOWED_HOSTS:'example.org'}));
});

test('Worker returns pre#output containing encoded binary bytes, with MIME metadata', async () => {
  const originalFetch = globalThis.fetch;
  const binary = Uint8Array.of(0, 1, 2, 123, 200, 255);
  globalThis.fetch = async () => new Response(binary, {status:200,headers:{'content-type':'image/png'}});
  try {
    const encodedUrl = encodeURIComponent(utf8ToBase64('https://example.org/a.png'));
    const response = await worker.fetch(new Request(workerOrigin + '/?url=' + encodedUrl), {});
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.startsWith('<!DOCTYPE html><html>'));
    assert.match(body, /<meta name="blobzpass-type" content="image\/png">/);
    const payload = body.match(/<pre id="output">(.*?)<\/pre>/)?.[1];
    assert.ok(payload);
    assert.deepEqual(Uint8Array.from(atob(payload), ch=>ch.charCodeAt(0)), binary);
  } finally { globalThis.fetch = originalFetch; }
});

test('Worker follows redirects but blocks redirects to local URLs', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(url);
    return new Response(null, {status:302, headers:{location:'http://127.0.0.1/private'}});
  };
  try {
    const res = await worker.fetch(new Request(workerOrigin + '/?url=' + encodeURIComponent(utf8ToBase64('https://example.org'))), {});
    assert.equal(res.status, 502);
    assert.equal(seen.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('Standalone and its iframe runtime scripts parse as JavaScript', () => {
  const html = readFileSync(new URL('../standalone.html', import.meta.url), 'utf8');
  const main = /<script>\s*([\s\S]*?)<\/script>\s*<\/body>/.exec(html)?.[1];
  assert.ok(main);
  new Script(main);
  const embedded = /function runtimeScript\(realPageUrl, realBase, hasExplicitBase, pageToken(?:, depth=0)?\) \{[\s\S]*?return String\.raw`([\s\S]*?)`/.exec(main)?.[1];
  assert.ok(embedded);
  // Template literal interpolations inside runtimeScript aren't used.
  new Script(embedded.replace('@@INITIAL_REAL_URL@@', '"https://example.org/docs/"')
    .replace('@@INITIAL_REAL_BASE@@', '"https://example.org/docs/"')
    .replace('@@PAGE_TOKEN@@', '1')
    .replace('@@FRAME_DEPTH@@','0')
    .replace('@@EXPLICIT_BASE@@', 'false')
    .replace('@@INITIAL_LOCAL_STORAGE@@','{}')
    .replace('@@INITIAL_SESSION_STORAGE@@','{}')
    .replace('@@INITIAL_COOKIE@@','""'));
});


test('Worker reconstructs POST method, UTF-8 body, and selected headers from GET query', async () => {
  const realFetch = globalThis.fetch;
  const seen=[];
  globalThis.fetch = async (url,opts) => {
    seen.push({url, method:opts.method, headers:new Headers(opts.headers), body:opts.body});
    return new Response(JSON.stringify({ok:true}),{status:201,headers:{'content-type':'application/json','x-ignored':'secret','etag':'abc'}});
  };
  try {
    const target='https://example.org/api/post';
    const body=new TextEncoder().encode(JSON.stringify({message:'π🌟',id:12}));
    const encodedHeaders=utf8ToBase64(JSON.stringify({'content-type':'application/json','x-csrf-token':'abc','host':'evil.test'}));
    const requestUrl=workerOrigin + '/?url=' + encodeURIComponent(utf8ToBase64(target))+
       '&method=POST&headers=' + encodeURIComponent(encodedHeaders) +
       '&body=' + encodeURIComponent(btoa(String.fromCharCode(...body)));
    const response=await worker.fetch(new Request(requestUrl), {});
    const html=await response.text();
    assert.equal(seen.length,1);
    assert.equal(seen[0].method,'POST');
    assert.equal(seen[0].headers.get('content-type'),'application/json');
    assert.equal(seen[0].headers.get('x-csrf-token'),'abc');
    assert.equal(seen[0].headers.get('host'),null);
    assert.deepEqual(new Uint8Array(seen[0].body), body);
    assert.match(html, /<meta name="blobzpass-status" content="201">/);
    const payload=html.match(/<pre id="output">(.*?)<\/pre>/)?.[1];
    assert.equal(Buffer.from(payload,'base64').toString(),'{"ok":true}');
    const headersMeta=html.match(/<meta name="blobzpass-headers" content="(.*?)">/)?.[1];
    const metadata=JSON.parse(Buffer.from(headersMeta,'base64').toString());
    assert.equal(metadata['etag'],'abc');
    assert.equal(metadata['x-ignored'],undefined);
  } finally { globalThis.fetch=realFetch; }
});

test('Worker follows POST 302 as GET and includes redirect session cookie', async () => {
  const realFetch=globalThis.fetch;
  const seen=[];
  globalThis.fetch=async (url,opts) => {
    seen.push({url,method:opts.method,cookie:opts.headers.get('cookie')});
    if (seen.length===1) {
      const r=new Response(null,{status:302,headers:{location:'/dashboard'}});
      // Node/Workers support getSetCookie; use an explicit test double.
      r.headers.getSetCookie=()=>['session=abc; Path=/; HttpOnly'];
      return r;
    }
    return new Response('ok',{status:200,headers:{'content-type':'text/plain'}});
  };
  try {
    const url=workerOrigin+'/?url='+encodeURIComponent(utf8ToBase64('https://example.org/login'))+
      '&method=POST&body='+encodeURIComponent(utf8ToBase64('q=test'));
    const response=await worker.fetch(new Request(url),{});
    const html=await response.text();
    assert.deepEqual(seen.map(x=>x.method),['POST','GET']);
    assert.equal(seen[1].cookie,'session=abc');
    assert.equal(seen[1].url,'https://example.org/dashboard');
    const meta=html.match(/<meta name="blobzpass-headers" content="(.*?)">/)?.[1];
    assert.deepEqual(JSON.parse(Buffer.from(meta,'base64').toString())['set-cookie'],['session=abc; Path=/; HttpOnly']);
  } finally {globalThis.fetch=realFetch;}
});

test('GET tunnel rejects bodies on GET and blocks unsupported upstream methods', async () => {
  const target=encodeURIComponent(utf8ToBase64('https://example.org/a'));
  const data=encodeURIComponent(utf8ToBase64('secret'));
  for (const suffix of ['&method=GET&body='+data,'&method=TRACE','&method=POST&body=invalid%21']) {
    const response=await worker.fetch(new Request(workerOrigin+'/?url='+target+suffix),{});
    assert.equal(response.status,400);
  }
});


test('Standalone supports virtual origin query and keeps a sandboxed iframe', () => {
  const html = readFileSync(new URL('../standalone.html', import.meta.url), 'utf8');
  assert.match(html, /initialParams\.get\('origin'\)/);
  assert.match(html, /const origin=originParam\?new URL\(normalizeUrl\(originParam\)\)\.origin/);
  assert.match(html, /top\.searchParams\.set\('origin', virtualOrigin\)/);
  assert.match(html, /top\.searchParams\.set\('url', current\.pathname/);
  assert.match(html, /frame\.sandbox='allow-scripts allow-forms allow-popups'/);
  assert.doesNotMatch(html, /sandbox="[^"]*allow-same-origin/);
});

test('Virtual runtime resolves Request(relative) URLs and dynamic resources', () => {
  const html = readFileSync(new URL('../standalone.html', import.meta.url), 'utf8');
  assert.match(html, /window\.Request = new Proxy\(NativeRequest/);
  assert.match(html, /if \(typeof next\[0\] === 'string'/);
  assert.match(html, /setVirtualUrl\(next,true,method===/);
  assert.match(html, /\[HTMLImageElement, 'src'\]/);
  assert.match(html, /\[HTMLScriptElement, 'src'\]/);
  assert.match(html, /attributeFilter:.*'srcset'/);
});

// Regression: Cloudflare HTMLRewriter attribute iterators become invalid as
// soon as an element's attributes are set/removed. The callback must finish
// reading every attribute before it changes any of them.
test('HTMLRewriter snapshots attributes before applying recursive URL rewrites', async () => {
  const originalFetch = globalThis.fetch;
  const originalRewriter = globalThis.HTMLRewriter;
  const visited = [];

  class StrictElement {
    constructor(tagName, attrs) {
      this.tagName = tagName;
      this.values = new Map(Object.entries(attrs));
      this.version = 0;
      this.snapshotCompleted = false;
      this.removed = false;
    }
    get attributes() {
      const element = this;
      const entries = [...this.values];
      const version = this.version;
      return {
        *[Symbol.iterator]() {
          for (const entry of entries) {
            if (element.version !== version) throw Error('The attributes of this element have been modified during iteration. You must create a new iterator after modifying attributes.');
            yield entry;
          }
          element.snapshotCompleted = true;
        }
      };
    }
    getAttribute() { throw Error('Attribute reads must use the immutable snapshot'); }
    setAttribute(name, value) {
      assert.ok(this.snapshotCompleted, 'changed an attribute before exhausting the snapshot iterator');
      this.version++;
      this.values.set(name, value);
    }
    removeAttribute(name) {
      assert.ok(this.snapshotCompleted, 'removed an attribute before exhausting the snapshot iterator');
      this.version++;
      this.values.delete(name);
    }
    remove() { this.removed = true; }
  }

  const items = [
    new StrictElement('img', {src:'/image.png', srcset:'a.webp 1x, b.webp 2x', style:'background:url(/bg.png)'}),
    new StrictElement('script', {src:'../app.js', integrity:'sha384-test', nonce:'abc'}),
    new StrictElement('meta', {'http-equiv':'refresh', content:'0; url=/next'}),
    new StrictElement('base', {href:'https://old.example.org/'}),
    new StrictElement('meta', {'http-equiv':'Content-Security-Policy', content:'default-src none'})
  ];
  globalThis.HTMLRewriter = class {
    on(selector, handler) { if (selector === '*') this.handler = handler; return this; }
    transform(response) {
      for (const element of items) {
        this.handler.element(element);
        visited.push(element);
      }
      return response;
    }
  };
  globalThis.fetch = async () => new Response('<html><body>ok</body></html>', {headers:{'content-type':'text/html'}});
  try {
    const requestUrl = workerOrigin + '/?url=' + encodeURIComponent(utf8ToBase64('https://example.org/folder/page'));
    const result = await worker.fetch(new Request(requestUrl), {});
    assert.equal(result.status, 200);
    assert.equal(visited.length, items.length);
    assert.ok(items.every(el => el.snapshotCompleted), 'snapshot should be exhausted for every element');
    assert.equal(unwrap(items[0].values.get('src')), 'https://example.org/image.png');
    assert.match(items[0].values.get('srcset'), /noteboardapp/);
    assert.match(items[0].values.get('style'), /noteboardapp/);
    assert.equal(unwrap(items[1].values.get('src')), 'https://example.org/app.js');
    assert.equal(items[1].values.has('integrity'), false);
    assert.equal(items[1].values.has('nonce'), false);
    assert.match(items[2].values.get('content'), /noteboardapp/);
    assert.equal(items[3].values.get('href'), 'https://old.example.org/'); // the streaming rewriter honors an explicit <base> when it appears
    assert.equal(items[4].removed, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRewriter === undefined) delete globalThis.HTMLRewriter;
    else globalThis.HTMLRewriter = originalRewriter;
  }
});


test('existing CookieSession Durable Object export remains available without modifying persisted storage', async () => {
  const calls = [];
  const state = { storage: {
    get: async () => { calls.push('get'); throw Error('should not access storage'); },
    deleteAll: async () => { calls.push('deleteAll'); throw Error('should not delete storage'); }
  } };
  assert.equal(typeof CookieSession, 'function');
  const object = new CookieSession(state, {});
  assert.equal(object.state, state);
  const response = await object.fetch(new Request('https://example.org/'));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /original implementation not bundled/);
  assert.deepEqual(calls, []);
});


test('Wrangler exports map declares existing CookieSession with both supported storage variants', () => {
  const sqlite = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const legacy = readFileSync(new URL('../wrangler.legacy-kv.toml', import.meta.url), 'utf8');
  for (const [text, backend] of [[sqlite, 'sqlite'], [legacy, 'legacy-kv']]) {
    assert.match(text, /^name = "blobzpass"$/m);
    assert.match(text, /^\[exports\.CookieSession\]$/m);
    assert.match(text, /^type = "durable-object"$/m);
    assert.match(text, new RegExp(`^storage = "${backend}"$`, 'm'));
    assert.doesNotMatch(text, /\[\[migrations\]\]|state\s*=\s*"(?:deleted|renamed|transferred)"/);
  }
});

test('viewer=1 avoids redundant HTML/CSS rewriting while retaining the Base64 envelope', async () => {
  const originalFetch = globalThis.fetch;
  const realTarget = 'https://example.org/docs/index.html';
  const rawHtml = '<!doctype html><html><head><link rel="stylesheet" href="/site.css"></head><body><img src="/photo.png"></body></html>';
  const rawCss = 'body{background:url("/bg.png")}';
  let fetchCalls = 0;
  globalThis.fetch = async url => {
    fetchCalls++;
    if (url.endsWith('.css')) return new Response(rawCss, {headers:{'content-type':'text/css'}});
    return new Response(rawHtml,{headers:{'content-type':'text/html'}});
  };
  try {
    for (const [target, expected] of [[realTarget,rawHtml],['https://example.org/site.css',rawCss]]) {
      const query = encodeURIComponent(utf8ToBase64(target));
      const response = await worker.fetch(new Request(workerOrigin + '/?url=' + query + '&viewer=1'), {});
      assert.equal(response.status,200);
      const html = await response.text();
      assert.equal(Buffer.from(html.match(/<pre id="output">(.*?)<\/pre>/)?.[1], 'base64').toString(),expected);
      const meta = JSON.parse(Buffer.from(html.match(/<meta name="blobzpass-meta" content="(.*?)"/)?.[1],'base64').toString());
      assert.equal(meta.url,target);
    }
    assert.equal(fetchCalls,2);
  } finally {globalThis.fetch=originalFetch;}
});

test('standalone uses Worker viewer=1 route, preloads only blocking scripts/styles and defers media', () => {
  const html = readFileSync(new URL('../standalone.html', import.meta.url), 'utf8');
  assert.match(html, /encodeURIComponent\(utf8Base64\(realUrl\)\) \+ '&viewer=1'/);
  assert.match(html, /el\.setAttribute\('data-blobzpass-' \+ attr,original\)/);
  assert.match(html, /tag === 'script' \|\| \(tag === 'link'/);
  assert.match(html, /MAX_PARALLEL_REQUESTS = 12/);
});

test('streaming Base64 envelope preserves binary data across uneven chunk boundaries', async () => {
  const originalFetch = globalThis.fetch;
  const payload = Uint8Array.from({length: 512 * 1024 + 5}, (_, i) => (i * 71 + 13) % 256);
  const chunkSizes = [1,2,4,5,7,8191,11111,32768,3,27];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      let pos = 0, ci = 0;
      while (pos < payload.byteLength) {
        const end = Math.min(pos + chunkSizes[ci++ % chunkSizes.length], payload.byteLength);
        controller.enqueue(payload.subarray(pos, end));
        pos = end;
      }
      controller.close();
    }
  }), {headers: {'content-type':'application/octet-stream'}});
  try {
    const target = workerOrigin + '/?url=' + encodeURIComponent(utf8ToBase64('https://example.org/binary')) + '&viewer=1';
    const response = await worker.fetch(new Request(target), {});
    const html = await response.text();
    const base64 = html.match(/<pre id="output">([^<]*)<\/pre>/)?.[1];
    assert.ok(base64);
    assert.deepEqual(new Uint8Array(Buffer.from(base64, 'base64')), payload);
    assert.equal((base64.match(/=/g)||[]).length, 2); // padding only at EOF
  } finally { globalThis.fetch = originalFetch; }
});

test('streaming envelope sends its HTML prefix before upstream body has finished', async () => {
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { upstream = controller; }
  }), {headers:{'content-type':'text/plain'}});
  try {
    const target = workerOrigin + '/?url=' + encodeURIComponent(utf8ToBase64('https://example.org/wait')) + '&viewer=1';
    const response = await worker.fetch(new Request(target), {});
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /<pre id="output">$/);
    upstream.enqueue(Uint8Array.of(123, 34, 125));
    upstream.close();
    let tail = '';
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      tail += new TextDecoder().decode(value);
    }
    assert.equal(tail, 'eyJ9</pre></body></html>');
  } finally { globalThis.fetch = originalFetch; }
});

test('oversized Content-Length produces a 413 before trying to stream', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('small', {
    headers: {'content-type':'application/octet-stream','content-length':String(11 * 1024 * 1024)}
  });
  try {
    const target = workerOrigin + '/?url=' + encodeURIComponent(utf8ToBase64('https://example.org/large')) + '&viewer=1';
    const response = await worker.fetch(new Request(target), {});
    assert.equal(response.status, 413);
    assert.match(await response.text(), /exceeds 10 MiB/);
  } finally {globalThis.fetch = originalFetch;}
});

test('unknown-length oversized upstream streams are terminated rather than fully buffered', async () => {
  const originalFetch = globalThis.fetch;
  let canceled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { canceled = true; }
  }), {headers:{'content-type':'application/octet-stream'}});
  try {
    const target = workerOrigin + '/?url=' + encodeURIComponent(utf8ToBase64('https://example.org/unknown')) + '&viewer=1';
    const response = await worker.fetch(new Request(target), {});
    await assert.rejects(response.arrayBuffer(), /Upstream body exceeds 10 MiB/);
    assert.equal(canceled, true);
  } finally {globalThis.fetch = originalFetch;}
});
