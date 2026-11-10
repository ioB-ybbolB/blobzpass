/**
 * blobzpass Worker — adapted from the HyperZProxy URL/CSS/HTML-rewrite design.
 * Original HyperZProxy authors: HyperZTeam. See README and upstream/.
 *
 * GET /?url=<base64-url>&method=POST&body=<base64-bytes>&headers=<base64-json>
 * The outer HTTP method always remains GET; the Worker replays the encoded method.
 * Returns <!doctype html><html>...<pre id="output">BASE64_BODY</pre>...</html>
 * All rewritten HTML/CSS URLs use the Noteboard -> blobzpass Worker chain.
 * HTML, CSS, JS and binary content are transported using the same envelope.
 * v1.3 streams Base64 and bridges WebSocket messages through GET polling.
 */

const WORKER_URL = 'https://blobzpass.iob-ybbolb.workers.dev/?url=';
const NOTEBOARD_URL = 'https://www.noteboardapp.com/showCodeFile.php?file=';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024; // URL transport is likely to impose a *smaller* limit
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'authorization', 'cookie', 'origin', 'referer', 'x-requested-with', 'x-csrf-token', 'x-xsrf-token', 'if-none-match', 'if-modified-since', 'cache-control']);
const RESPONSE_HEADERS = ['content-type','content-language','location','etag','last-modified','cache-control'];
const MAX_REDIRECTS = 5;
// One batch may consume at most 45 external fetch subrequests (including
// redirects). Limit in-flight upstream requests to Cloudflare's 6-connection cap.
const MAX_BATCH_IMAGES = 45;
const MAX_BATCH_CONNECTIONS = 6;
const MAX_BATCH_ITEM_BYTES = 512 * 1024;
const MAX_BATCH_TOTAL_BYTES = 3 * 1024 * 1024;
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'imagesrc'];
const SRCSET_ATTRS = ['srcset', 'imagesrcset'];

function utf8ToBase64(value) {
  return bytesToBase64(new TextEncoder().encode(value));
}
/** Encode small chunks with V8's native Base64 path where available. Never
 * build a whole-response binary string: that was a main CPU/memory hotspot.
 * 12,288 is divisible by 3, so chunk concatenation never inserts mid-body '='.
 */
function bytesToBase64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 12288) {
    const part = bytes.subarray(offset, offset + 12288);
    parts.push(typeof part.toBase64 === 'function'
      ? part.toBase64()
      : btoa(String.fromCharCode(...part)));
  }
  return parts.join('');
}
function base64ToBytes(value) {
  if (typeof value !== 'string' || !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid Base64 data');
  }
  return Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
}
function base64ToUtf8(value) {
  return new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(value));
}
function parseReplay(searchParams) {
  const method = (searchParams.get('method') || 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new Error('Unsupported upstream method');
  const body = searchParams.has('body') ? base64ToBytes(searchParams.get('body')) : null;
  if (body && body.byteLength > MAX_REQUEST_BYTES) throw new Error('Encoded request body exceeds 64 KiB');
  if ((method === 'GET' || method === 'HEAD') && body?.length) throw new Error('GET/HEAD cannot contain an upstream body');
  const headers = new Headers();
  if (searchParams.has('headers')) {
    const parsed = JSON.parse(base64ToUtf8(searchParams.get('headers')));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length > 32) {
      throw new Error('Invalid encoded request headers');
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (!SAFE_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid request header value');
      headers.set(name, value);
    }
  }
  if (!headers.has('accept')) headers.set('Accept', '*/*');
  return { method, body, headers };
}
function wrapUrl(absoluteUrl) {
  const intermediate = WORKER_URL + encodeURIComponent(utf8ToBase64(absoluteUrl));
  return NOTEBOARD_URL + encodeURIComponent(intermediate);
}
function isWrapped(url) {
  try {
    const u = new URL(url);
    return u.origin === new URL(NOTEBOARD_URL).origin &&
      u.pathname === new URL(NOTEBOARD_URL).pathname && !!u.searchParams.get('file');
  } catch { return false; }
}
function targetUrl(raw, base) {
  if (!raw || /^(?:#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(raw.trim())) return null;
  let u;
  try { u = new URL(raw.trim(), base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (isWrapped(u.href)) return null;
  return u.href;
}
function rewriteUrl(raw, base) {
  const dest = targetUrl(raw, base);
  return dest ? wrapUrl(dest) : raw;
}
// v2: real, same-origin proxy paths for Service Worker controlled documents.
// The encoded origin distinguishes HTTPS from HTTP and keeps relative paths native.
function base64Url(value) {
  return utf8ToBase64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function routeUrl(raw, base, proxyBase = '/__bp__/') {
  const dest = targetUrl(raw, base);
  if (!dest) return raw;
  const parsed = new URL(dest);
  return proxyBase + 'o/' + base64Url(parsed.origin) + parsed.pathname + parsed.search + parsed.hash;
}
function rewriteSrcsetMode(value, base, fn) {
  if (/data:/i.test(value)) return value;
  return value.split(',').map(entry => {
    const match = /^(\s*)(\S+)([\s\S]*)$/.exec(entry);
    return match ? match[1] + fn(match[2], base) + match[3] : entry;
  }).join(',');
}
function rewriteCssMode(css, base, fn) {
  return String(css)
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (all, a, b, c) => {
      const inner = (a ?? b ?? c ?? '').trim();
      if (!inner) return all;
      return 'url("' + fn(inner, base).replace(/"/g, '%22') + '")';
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (all, quote, url) => '@import ' + quote + fn(url, base) + quote);
}
function rewriteSrcset(value, base) {
  // srcset with data: URLs is unchanged; a comma inside one is not a separator.
  if (/data:/i.test(value)) return value;
  return value.split(',').map(entry => {
    const match = /^(\s*)(\S+)([\s\S]*)$/.exec(entry);
    return match ? match[1] + rewriteUrl(match[2], base) + match[3] : entry;
  }).join(',');
}
function rewriteCss(css, base) {
  return String(css)
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (all, quoted1, quoted2, bare) => {
      const inner = (quoted1 ?? quoted2 ?? bare ?? '').trim();
      if (!inner) return all;
      return 'url("' + rewriteUrl(inner, base).replace(/"/g, '%22') + '")';
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (_all, quote, url) => '@import ' + quote + rewriteUrl(url, base) + quote);
}
function escapeAttr(str) {
  return String(str).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
function stripMetaRefresh(content, base, fn = rewriteUrl) {
  return String(content).replace(/(url\s*=\s*)(?:(["'])(.*?)\2|([^;\s]+))/i, (m, start, quote, quoted, bare) => {
    const dest = fn(quoted ?? bare ?? '', base);
    return start + (quote || '"') + dest + (quote || '"');
  });
}
function rewriteHtml(htmlOrResponse, requestBase, mode = 'legacy', proxyBase = '/__bp__/') {
  const v2 = mode === 'v2';
  const rewrite = v2 ? (raw, base) => routeUrl(raw, base, proxyBase) : rewriteUrl;
  // Streaming HTMLRewriter avoids buffering HTML twice before encoding it.
  // A <base> element can change the base for subsequent tags in the stream.
  let base = requestBase;
  // Rewriting is done by Cloudflare's HTML parser, not regex over HTML markup.
  const rewriter = new HTMLRewriter()
    .on('*', {
      element(element) {
        const tag = element.tagName.toLowerCase();
        // Cloudflare HTMLRewriter's attributes iterator is invalidated when an
        // attribute changes. Fully consume it first, then build a separate list
        // of changes and ONLY AFTER THAT mutate the element. Never keep an
        // attribute iterator alive across setAttribute/removeAttribute calls.
        const original = new Map(Array.from(element.attributes, ([name, value]) => [name.toLowerCase(), value]));
        const changes = new Map();
        const removals = [];
        if (tag === 'base') {
          const declaredBase = original.get('href');
          if (declaredBase) {
            try {
              const resolved = new URL(declaredBase, requestBase);
              if (resolved.protocol === 'https:' || resolved.protocol === 'http:') base = resolved.href;
            } catch { /* keep the document's base */ }
          }
          const rewrittenBase = v2 ? rewrite(base, requestBase) : base;
          if (original.get('href') !== rewrittenBase) changes.set('href', rewrittenBase);
        } else {
          for (const attr of URL_ATTRS) {
            const raw = original.get(attr);
            if (raw === undefined) continue;
            const rewritten = rewrite(raw, base);
            if (rewritten !== raw) changes.set(attr, rewritten);
          }
          for (const attr of SRCSET_ATTRS) {
            const raw = original.get(attr);
            if (raw === undefined) continue;
            const rewritten = v2 ? rewriteSrcsetMode(raw, base, rewrite) : rewriteSrcset(raw, base);
            if (rewritten !== raw) changes.set(attr, rewritten);
          }
          const inlineCss = original.get('style');
          if (inlineCss) {
            const rewritten = v2 ? rewriteCssMode(inlineCss, base, rewrite) : rewriteCss(inlineCss, base);
            if (rewritten !== inlineCss) changes.set('style', rewritten);
          }
          if (tag === 'meta') {
            const equiv = (original.get('http-equiv') || '').toLowerCase();
            if (equiv === 'refresh') {
              const raw = original.get('content') || '';
              const rewritten = stripMetaRefresh(raw, base, rewrite);
              if (rewritten !== raw) changes.set('content', rewritten);
            } else if (/content-security-policy/i.test(equiv)) {
              element.remove();
              return;
            }
          }
          if (tag === 'script' || tag === 'link') {
            if (original.has('integrity')) removals.push('integrity');
            if (original.has('nonce')) removals.push('nonce');
          }
        }
        // All reads and iteration are complete. Apply buffered mutations now.
        for (const [name, value] of changes) element.setAttribute(name, value);
        for (const name of removals) element.removeAttribute(name);
      }
    })
    .on('style', {
      text(text) {
        // Chunk-boundary CSS rewriting is best-effort; full CSS files handled below.
        text.replace(v2 ? rewriteCssMode(text.text, base, rewrite) : rewriteCss(text.text, base));
      }
    })
    .on('head', {
      element(element) {
        if (v2) element.prepend('<script src="' + escapeAttr(proxyBase + 'bridge.js') + '"></script>', {html:true});
      }
    });
  return rewriter.transform(typeof htmlOrResponse === 'string'
    ? new Response(htmlOrResponse, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : htmlOrResponse);
}

function validatePublicTarget(value, env) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Malformed URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only HTTP(S) URLs are supported');
  if (u.username || u.password) throw new Error('Embedded credentials are not supported');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('Nonstandard ports are blocked');
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') ||
      host.endsWith('.invalid') || host.endsWith('.example') ||
      /^\[.*\]$/.test(host) || /^(?:\d+\.){3}\d+$/.test(host) || /^\d+$/.test(host)) {
    throw new Error('Local, private, or numeric hosts are blocked');
  }
  // Optional restriction: comma-separated hostnames and subdomains.
  const allowList = String(env?.ALLOWED_HOSTS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (allowList.length && !allowList.some(allowed => host === allowed || host.endsWith('.' + allowed))) {
    throw new Error('Host is not in ALLOWED_HOSTS');
  }
  return u;
}

async function fetchPublic(url, env, replay = { method: 'GET', body: null, headers: new Headers() }, takeSubrequest = null) {
  let current = validatePublicTarget(url, env);
  let method = replay.method;
  let body = replay.body;
  const headers = new Headers(replay.headers);
  const originalOrigin = current.origin;
  const redirectCookies = [];
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    // Credentials must not be sent to a different host after a redirect.
    const outgoing = new Headers(headers);
    if (current.origin !== originalOrigin) {
      outgoing.delete('authorization'); outgoing.delete('cookie');
      outgoing.delete('origin'); outgoing.delete('referer');
    }
    if (takeSubrequest && !takeSubrequest()) throw new Error('Batch external subrequest budget exhausted');
    const response = await fetch(current.href, {
      method, redirect: 'manual', headers: outgoing,
      body: method === 'GET' || method === 'HEAD' ? undefined : body
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const rawCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect without Location');
      const previousOrigin = current.origin;
      current = validatePublicTarget(new URL(location, current).href, env);
      // Cross-origin redirect cookies belong to a different site; do not
      // attach them to the final URL's cookie jar or leak them across hosts.
      if (previousOrigin === current.origin && rawCookies.length) {
        redirectCookies.push(...rawCookies);
        const existing = new Map((headers.get('cookie') || '').split(';').map(v => v.trim()).filter(Boolean)
          .map(v => [v.split('=')[0], v.slice(v.indexOf('=')+1)]));
        for (const value of rawCookies) {
          const pair = value.split(';')[0];
          const pos = pair.indexOf('=');
          if (pos > 0) existing.set(pair.slice(0,pos), pair.slice(pos+1));
        }
        headers.set('cookie', [...existing].map(([k,v]) => k + '=' + v).join('; '));
      }
      // Browser-compatible redirect rules: 303 and POST 301/302 switch to GET.
      if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
        method = 'GET'; body = null;
        headers.delete('content-type');
      }
      // Never leave an unread redirect response stream consuming resources.
      if (response.body) await response.body.cancel();
      continue;
    }
    return { response, finalUrl: current.href, redirectCookies };
  }
  throw new Error('Too many redirects');
}

/**
 * A bounded Base64 envelope stream. Before this change we buffered the entire
 * upstream body in an array of chunks, copied it, converted the copy into a
 * single binary string, then allocated a single enormous HTML string. On the
 * Workers Free 10ms CPU budget (and 128 MiB isolate heap) that can produce 1102.
 *
 * Pull one small block at a time, preserving 0-2 leftover bytes so Base64
 * padding occurs only at EOF. Backpressure and cancellation propagate upstream.
 * Declared oversized responses are rejected before headers are sent; unknown-
 * length oversize streams fail closed instead of consuming unbounded memory.
 */
function streamBase64Envelope(sourceBody, prefix, maxBytes = MAX_RESPONSE_BYTES) {
  const enc = new TextEncoder();
  const source = sourceBody || new ReadableStream({ start(c) { c.close(); } });
  const reader = source.getReader();
  let pending = null;
  let offset = 0;
  let carry = new Uint8Array(0);
  let bytesSeen = 0;
  let ended = false;
  const finish = () => { try { reader.releaseLock(); } catch { /* already released */ } };
  return new ReadableStream({
    start(controller) { controller.enqueue(enc.encode(prefix)); },
    async pull(controller) {
      if (ended) return;
      try {
        // A 1- or 2-byte chunk produces no full Base64 quantum. Keep
        // reading until we can enqueue output or reach EOF; otherwise some
        // stream implementations stop pulling and the response hangs.
        for (;;) {
        if (!pending || offset >= pending.byteLength) {
          const { done, value } = await reader.read();
          if (done) {
            if (carry.byteLength) controller.enqueue(enc.encode(bytesToBase64(carry)));
            controller.enqueue(enc.encode('</pre></body></html>'));
            ended = true;
            finish();
            controller.close();
            return;
          }
          bytesSeen += value.byteLength;
          if (bytesSeen > maxBytes) throw new Error('Upstream body exceeds 10 MiB');
          pending = value;
          offset = 0;
          if (!pending.byteLength) continue;
        }
        // Build at most 24 KiB of binary input per pull. In particular, never
        // spread an unbounded fetch() chunk through String.fromCharCode().
        const nextEnd = Math.min(offset + 24576, pending.byteLength);
        const block = pending.subarray(offset, nextEnd);
        offset = nextEnd;
        const joined = new Uint8Array(carry.byteLength + block.byteLength);
        joined.set(carry);
        joined.set(block, carry.byteLength);
        const full = joined.byteLength - joined.byteLength % 3;
        carry = joined.slice(full); // at most two bytes
        if (full) {
          controller.enqueue(enc.encode(bytesToBase64(joined.subarray(0, full))));
          return;
        }
        }
      } catch (error) {
        ended = true;
        controller.error(error);
        try { await reader.cancel(error); } catch { /* already errored */ }
        finish();
      }
    },
    async cancel(reason) {
      if (ended) return;
      ended = true;
      try { await reader.cancel(reason); } finally { finish(); }
    }
  });
}

function envelope(bodyStream, mime, status, finalUrl, upstreamHeaders = new Headers(), redirectCookies = []) {
  const responseHeaders = {};
  for (const name of RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value) responseHeaders[name] = value;
  }
  const cookies = typeof upstreamHeaders.getSetCookie === 'function' ? upstreamHeaders.getSetCookie() : [];
  if (cookies.length || redirectCookies.length) responseHeaders['set-cookie'] = [...redirectCookies, ...cookies];
  const encodedHeaders = utf8ToBase64(JSON.stringify(responseHeaders));
  const encodedMeta = utf8ToBase64(JSON.stringify({mime, status, url:finalUrl, headers:responseHeaders}));
  const prefix = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="blobzpass-type" content="' + escapeAttr(mime) + '">' +
    '<meta name="blobzpass-status" content="' + escapeAttr(status) + '">' +
    '<meta name="blobzpass-url" content="' + escapeAttr(finalUrl) + '">' +
    '<meta name="blobzpass-headers" content="' + escapeAttr(encodedHeaders) + '">' +
    '<meta name="blobzpass-meta" content="' + encodedMeta + '">' +
    '</head><body><pre id="output">';
  return new Response(streamBase64Envelope(bodyStream, prefix), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function errorResponse(message, status = 400) {
  return new Response('blobzpass: ' + message, {
    status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

/**
 * Compatibility export for Workers that already have a Durable Object namespace
 * named CookieSession. Cloudflare will reject replacing the script if this
 * previously deployed class disappears (error 10064).
 *
 * The original CookieSession implementation is NOT included in the supplied
 * HyperZProxy source. Do not modify, clear, or migrate existing storage here.
 * This placeholder is intentionally inert: it only preserves the export name.
 * If another Worker still calls CookieSession, restore its original class
 * implementation instead of relying on this placeholder.
 *
 * No new namespace or migration should be created for this pre-existing class.
 */
export class CookieSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    return new Response('CookieSession: original implementation not bundled with blobzpass', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}


/**
 * Per-connection state in a Durable Object. No socket is created in the
 * standalone HTML: all control requests go through Noteboard as ordinary GETs.
 * An outbound WebSocket pins the DO while connected and incurs duration cost.
 * Messages are bounded to protect Worker/DO CPU and memory budgets.
 */
const WS_MAX_MESSAGE_BYTES = 32768;
const WS_MAX_QUEUE = 24;
const WS_POLL_MS = 5000;
const WS_IDLE_MS = 120000; // Prevent abandoned outbound sockets from pinning a DO indefinitely.
// The outer Noteboard URL is always a GET. Large encoded requests are staged
// in bounded pieces using the EXISTING WebSocketBridge namespace; no new DO
// export, migration, or browser-to-Worker request is required.
const TUNNEL_MAX_PARTS = 256;
const TUNNEL_PART_CHARS = 1500;
const TUNNEL_TTL_MS = 90000;
const TUNNEL_MAX_QUERY_CHARS = TUNNEL_MAX_PARTS * TUNNEL_PART_CHARS;

function wsJson(data, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
  });
}
function wsFailure(error) { return {ok:false,error:String(error?.message || error)}; }
export class WebSocketBridge {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.socket = null;
    this.queue = [];
    this.waiters = new Set();
    this.closed = false;
    this.lastActivity = Date.now();
  }
  async alarm() {
    // Staged HTTP/WebSocket requests expire even if the originating browser
    // closes before issuing its final commit GET.
    if (!this.socket) {
      const expiry = await this.state.storage?.get?.('tunnel:expiry');
      if (expiry && Date.now() >= expiry) await this.state.storage?.deleteAll?.();
      else if (expiry) await this.state.storage?.setAlarm?.(expiry);
      return;
    }
    if (this.closed) return;
    if (Date.now() - this.lastActivity >= WS_IDLE_MS) {
      try { this.socket.close(1001,'Idle WebSocket tunnel'); } catch {}
      this.closed = true;
      this.wake();
    } else {
      await this.state.storage?.setAlarm?.(this.lastActivity + WS_IDLE_MS);
    }
  }
  wake() { for (const wake of [...this.waiters]) wake(); }
  queueEvent(event) {
    if (this.queue.length >= WS_MAX_QUEUE) {
      this.queue.length = 0;
      this.queue.push({type:'error',message:'WebSocket receive queue exceeded 24 messages'});
      this.closed = true;
      try {this.socket?.close(1009,'Receive queue full');} catch {}
    } else this.queue.push(event);
    this.wake();
  }
  async fetch(request) {
    try {
      const u = new URL(request.url);
      const action = u.pathname.slice(1);
      this.lastActivity = Date.now();
      if (action === 'stage') {
        const store = this.state.storage;
        if (!store?.put || !store?.get) throw new Error('Durable Object storage unavailable for staged GET tunnel');
        const part = Number(u.searchParams.get('part'));
        const total = Number(u.searchParams.get('total'));
        const fragment64 = u.searchParams.get('data') || '';
        if (!/^[A-Za-z0-9_-]{1,2400}$/.test(fragment64)) throw new Error('Invalid staged Base64URL fragment');
        const canonical = fragment64.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-fragment64.length%4)%4);
        const data = base64ToUtf8(canonical);
        if (!Number.isInteger(part) || !Number.isInteger(total) || total < 1 || total > TUNNEL_MAX_PARTS || part < 0 || part >= total ||
            data.length > TUNNEL_PART_CHARS || !/^[A-Za-z0-9%&=+_.~\-]*$/.test(data)) throw new Error('Invalid staged tunnel fragment');
        let declared = await store.get('tunnel:total');
        if (declared !== undefined && declared !== total) throw new Error('Inconsistent tunnel fragment count');
        const expiry = await store.get('tunnel:expiry');
        if (expiry && Date.now() > expiry) throw new Error('Staged request expired');
        if (declared === undefined) {
          await store.put('tunnel:total',total);
          await store.put('tunnel:expiry',Date.now()+TUNNEL_TTL_MS);
          await store.setAlarm?.(Date.now()+TUNNEL_TTL_MS);
        }
        await store.put('tunnel:part:' + part,data);
        return wsJson({ok:true,part});
      }
      if (action === 'replay') {
        const store = this.state.storage;
        if (!store?.get) throw new Error('Durable Object storage unavailable for staged GET tunnel');
        const total = await store.get('tunnel:total');
        const expiry = await store.get('tunnel:expiry');
        if (!total || !expiry || Date.now() > expiry) throw new Error('Staged request missing or expired');
        const parts = [];
        for (let i = 0; i < total; i++) {
          const fragment = await store.get('tunnel:part:' + i);
          if (typeof fragment !== 'string') throw new Error('Missing staged tunnel fragment ' + i);
          parts.push(fragment);
        }
        const raw = parts.join('');
        if (raw.length > TUNNEL_MAX_QUERY_CHARS || raw.includes('#')) throw new Error('Staged request exceeds bounds');
        await store.deleteAll?.(); // Single use: never replay state-changing POSTs.
        const params = new URLSearchParams(raw);
        if (params.has('tunnel')) throw new Error('Nested staged tunnel is forbidden');
        return params.has('ws_action') ? wsBridgeRequest(params,this.env) : params.has('batch') ? proxyImageBatch(params,this.env) : proxyRequestFromParams(params,this.env,'GET');
      }
      if (action === 'connect') {
        if (this.socket) throw new Error('WebSocket session already connected');
        const dest = base64ToUtf8(u.searchParams.get('target') || '');
        const parsed = new URL(dest);
        if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') throw new Error('Expected ws: or wss: URL');
        const target = parsed.href.replace(/^wss:/,'https:').replace(/^ws:/,'http:');
        validatePublicTarget(target, this.env);
        const protocols = u.searchParams.has('protocols') ? JSON.parse(base64ToUtf8(u.searchParams.get('protocols'))) : [];
        if (!Array.isArray(protocols) || protocols.length > 12 || protocols.some(p => typeof p !== 'string' || p.length > 80 || !/^[!#$%&'*+.^_`|~\w-]+$/.test(p))) {
          throw new Error('Invalid WebSocket subprotocols');
        }
        const origin = u.searchParams.has('origin') ? base64ToUtf8(u.searchParams.get('origin')) : '';
        if (origin && (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(origin) || origin.length > 200)) throw new Error('Invalid WebSocket Origin');
        const headers = new Headers({'Upgrade':'websocket'});
        if (protocols.length) headers.set('Sec-WebSocket-Protocol', protocols.join(', '));
        if (origin) headers.set('Origin', origin);
        const cookie = u.searchParams.has('cookie') ? base64ToUtf8(u.searchParams.get('cookie')) : '';
        if (cookie) {
          if (cookie.length > 2048 || /[\r\n]/.test(cookie)) throw new Error('Invalid cookie header');
          headers.set('Cookie', cookie);
        }
        const response = await fetch(target, {headers});
        if (!response.webSocket) throw new Error('Upstream refused WebSocket upgrade: HTTP ' + response.status);
        const socket = response.webSocket;
        this.socket = socket;
        this.closed = false;
        socket.binaryType = 'arraybuffer';
        socket.accept();
        await this.state.storage?.setAlarm?.(this.lastActivity + WS_IDLE_MS);
        socket.addEventListener('message', e => {
          if (typeof e.data === 'string') {
            if (new TextEncoder().encode(e.data).byteLength > WS_MAX_MESSAGE_BYTES) {
              this.queueEvent({type:'error',message:'WebSocket frame exceeds 32 KiB'});
              try {socket.close(1009,'Frame too large');} catch {}
            } else this.queueEvent({type:'message',data:e.data,binary:false});
          } else {
            const bytes = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array(0);
            if (bytes.byteLength > WS_MAX_MESSAGE_BYTES) {
              this.queueEvent({type:'error',message:'Binary WebSocket frame exceeds 32 KiB'});
              try {socket.close(1009,'Frame too large');} catch {}
            } else this.queueEvent({type:'message',data:bytesToBase64(bytes),binary:true});
          }
        });
        socket.addEventListener('close',e=>{
          this.closed=true;
          this.queueEvent({type:'close',code:e.code || 1000,reason:e.reason || '',wasClean:!!e.wasClean});
        });
        socket.addEventListener('error',()=>{this.queueEvent({type:'error',message:'Upstream WebSocket error'});this.wake();});
        return wsJson({ok:true,protocol:response.headers.get('sec-websocket-protocol') || ''});
      }
      if (!this.socket) throw new Error('WebSocket session not connected');
      if (action === 'send') {
        const data = base64ToBytes(u.searchParams.get('data') || '');
        if (data.length > WS_MAX_MESSAGE_BYTES) throw new Error('WebSocket message exceeds 32 KiB');
        if (this.closed || this.socket.readyState !== 1) throw new Error('WebSocket already closed');
        this.socket.send(u.searchParams.get('binary') === '1' ? data : new TextDecoder('utf-8',{fatal:true}).decode(data));
        return wsJson({ok:true});
      }
      if (action === 'poll') {
        if (!this.queue.length && !this.closed) await new Promise(resolve => {
          let timer;
          const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
          this.waiters.add(wake);
          timer = setTimeout(wake,WS_POLL_MS);
        });
        const batch=[];let chars=0;
        while(this.queue.length&&batch.length<16){const next=this.queue[0];const size=JSON.stringify(next).length;
          if(batch.length&&chars+size>60000)break;batch.push(this.queue.shift());chars+=size;
        }
        return wsJson({ok:true,events:batch,closed:this.closed&&!this.queue.length});
      }
      if (action === 'close') {
        const code = Number(u.searchParams.get('code') || 1000);
        const reason = u.searchParams.has('reason') ? base64ToUtf8(u.searchParams.get('reason')) : '';
        if (!(code===1000 || (code>=3000 && code<=4999)) || new TextEncoder().encode(reason).length > 123) throw new Error('Invalid WebSocket close code or reason');
        this.closed = true;
        if (this.socket.readyState <= 1) this.socket.close(code,reason);
        this.wake();
        return wsJson({ok:true});
      }
      throw new Error('Unknown WebSocket operation');
    } catch (e) { return wsJson(wsFailure(e)); }
  }
}

function validateWebSocketUrl(raw, env) {
  const u = new URL(raw);
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error('Only ws: and wss: URLs are supported');
  validatePublicTarget(u.href.replace(/^wss:/,'https:').replace(/^ws:/,'http:'),env);
  return u.href;
}
async function wsBridgeRequest(params, env) {
  try {
    if (!env?.WS_BRIDGE) throw new Error('Missing WS_BRIDGE Durable Object binding. Deploy with the updated wrangler configuration.');
    const action = params.get('ws_action');
    if (!['connect','send','poll','close'].includes(action)) throw new Error('Invalid WebSocket action');
    const id = params.get('ws_id') || '';
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid WebSocket session ID');
    if (String(params).length > 14000) throw new Error('WebSocket tunnel URL exceeds size limit');
    if (action === 'connect') validateWebSocketUrl(base64ToUtf8(params.get('target') || ''),env);
    if (action === 'send') {
      const bytes = base64ToBytes(params.get('data') || '');
      if (bytes.length > WS_MAX_MESSAGE_BYTES) throw new Error('WebSocket send exceeds 32 KiB');
    }
    const stub = env.WS_BRIDGE.get(env.WS_BRIDGE.idFromName('blobzpass-ws:' + id));
    const internal = new URL('https://bridge.internal/' + action);
    for (const [name,value] of params) {
      if (['target','data','binary','protocols','origin','cookie','code','reason'].includes(name)) internal.searchParams.set(name,value);
    }
    const bridgeResponse = await stub.fetch(new Request(internal.href));
    const payload = await bridgeResponse.text();
    if (payload.length > 100000) throw new Error('WebSocket poll response exceeds size limit');
    return envelope(new Response(payload).body,'application/json',200,'blobzpass:ws');
  } catch (e) {
    return envelope(new Response(JSON.stringify(wsFailure(e))).body,'application/json',200,'blobzpass:ws');
  }
}

async function stagedTunnelRequest(params,env) {
  try {
    if (!env?.WS_BRIDGE) throw new Error('Missing WS_BRIDGE binding for chunked GET requests');
    const action = params.get('tunnel');
    if (!['stage','commit'].includes(action)) throw new Error('Invalid tunnel action');
    const id = params.get('id') || '';
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid tunnel ID');
    const stub = env.WS_BRIDGE.get(env.WS_BRIDGE.idFromName('blobzpass-request:' + id));
    const u = new URL('https://bridge.internal/' + (action==='commit'?'replay':'stage'));
    if (action==='stage') {
      for (const k of ['part','total','data']) u.searchParams.set(k,params.get(k)||'');
      if (u.href.length > 7500) throw new Error('Staged fragment is too large');
    }
    const result = await stub.fetch(new Request(u));
    if (action === 'commit') {
      if ((result.headers.get('content-type') || '').includes('text/html')) return result;
      // Durable Object errors and upstream validation failures also need a
      // Base64 wrapper, otherwise the standalone viewer cannot read them.
      return envelope(result.body,result.headers.get('content-type')||'text/plain',result.status===200?400:result.status,'blobzpass:tunnel');
    }
    return envelope(result.body,'application/json',result.status,'blobzpass:tunnel');
  } catch(e) {
    return envelope(new Response(JSON.stringify(wsFailure(e))).body,'application/json',400,'blobzpass:tunnel');
  }
}

/** GET /?batch=<base64-JSON>  (still wrapped by Noteboard, as before).
 * One Worker invocation fetches up to 45 images, with 6 concurrent upstream
 * connections and a shared 45-external-subrequest budget including redirects.
 * Binary format: uint32 BE manifest length | UTF-8 manifest JSON | concatenated
 * image bytes. Outer transport is the existing Base64 <pre id="output">.
 * Per-item and aggregate caps keep this safe on Free Workers (128 MiB / 10ms CPU).
 */
async function proxyImageBatch(params, env) {
  let items;
  try {
    const raw = base64ToUtf8(params.get('batch') || '');
    if (raw.length > 40000) throw new Error('Batch URL list too large');
    const payload = JSON.parse(raw);
    items = payload?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH_IMAGES) {
      throw new Error('Batch must contain 1 to 45 image requests');
    }
    items = items.map((item) => {
      if (!item || typeof item.url !== 'string' || item.url.length > 2048)
        throw new Error('Invalid image URL in batch');
      validatePublicTarget(item.url, env);
      const params = new URLSearchParams();
      if (item.headers) params.set('headers', utf8ToBase64(JSON.stringify(item.headers)));
      const replay = parseReplay(params);
      if (replay.method !== 'GET' || replay.body) throw new Error('Images must use GET');
      return {url:item.url, replay};
    });
  } catch (error) { return errorResponse(error.message || 'Invalid image batch'); }

  // Central budget reserves 5 external calls of Free-tier headroom (including redirects).
  let externalCalls = 0, nextIndex = 0, aggregateBytes = 0;
  const takeSubrequest = () => {
    if (externalCalls >= MAX_BATCH_IMAGES) return false;
    externalCalls++;
    return true;
  };
  const results = Array(items.length);
  async function handle(index) {
    const item = items[index];
    let upstream;
    try {
      if (aggregateBytes >= MAX_BATCH_TOTAL_BYTES) {
        results[index] = {retry:true, reason:'Batch aggregate limit reached'};return;
      }
      const {response,finalUrl,redirectCookies} = await fetchPublic(item.url,env,item.replay,takeSubrequest);
      upstream=response;
      const contentType=(response.headers.get('content-type')||'application/octet-stream').split(';')[0].trim().toLowerCase();
      const contentLength = Number(response.headers.get('content-length'));
      if (response.headers.has('content-length') && contentLength > MAX_BATCH_ITEM_BYTES) {
        await response.body?.cancel();
        results[index] = {retry:true,reason:'Image exceeds batch item limit'};return;
      }
      const chunks=[];let size=0;
      if (response.body) {
        const reader=response.body.getReader();
        try {
          for (;;) {
            const {done,value}=await reader.read();
            if(done) break;
            size+=value.byteLength;
            if(size>MAX_BATCH_ITEM_BYTES) {
              await reader.cancel('Image exceeds batch item limit');
              results[index]={retry:true,reason:'Image exceeds batch item limit'};return;
            }
            chunks.push(value);
          }
        } finally {try{reader.releaseLock();}catch{}}
      }
      if (aggregateBytes + size > MAX_BATCH_TOTAL_BYTES) {
        results[index]={retry:true,reason:'Image exceeds remaining batch budget'};return;
      }
      aggregateBytes += size;
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const headers={};
      for(const name of RESPONSE_HEADERS) {
        const value=response.headers.get(name);if(value)headers[name]=value;
      }
      const cookies=typeof response.headers.getSetCookie==='function' ? response.headers.getSetCookie() : [];
      if(cookies.length || redirectCookies.length) headers['set-cookie']=[...redirectCookies,...cookies];
      results[index]={url:finalUrl,mime:contentType,status:response.status,headers,bytes};
    } catch(error) {
      results[index] = /budget exhausted/.test(String(error?.message))
        ? {retry:true,reason:'Batch request budget exhausted'}
        : {status:502,url:item.url,mime:'text/plain',headers:{},error:String(error?.message||error)};
      try{await upstream?.body?.cancel();}catch{}
    }
  }
  const workers = Array.from({length:Math.min(MAX_BATCH_CONNECTIONS,items.length)},async()=>{
    while (nextIndex < items.length) {
      const index=nextIndex++;
      await handle(index);
    }
  });
  await Promise.all(workers);
  const manifest={version:1,items:[]};
  let dataBytes=0;
  const bodies=[];
  for(let index=0;index<results.length;index++) {
    const result=results[index] || {retry:true,reason:'Not fetched'};
    const {bytes,...meta}=result;
    const length=bytes?.byteLength||0;
    manifest.items.push({...meta,offset:dataBytes,length});
    if(length){bodies.push(bytes);dataBytes+=length;}
  }
  const metadata=new TextEncoder().encode(JSON.stringify(manifest));
  const packet=new Uint8Array(4+metadata.byteLength+dataBytes);
  new DataView(packet.buffer).setUint32(0,metadata.byteLength);
  packet.set(metadata,4);
  let cursor=4+metadata.byteLength;
  for(const bytes of bodies){packet.set(bytes,cursor);cursor+=bytes.byteLength;}
  return envelope(new Response(packet).body,'application/x-blobzpass-batch',200,'blobzpass:batch');
}

async function proxyRequestFromParams(params, env, requestMethod='GET') {
  if (!params.has('url')) return errorResponse('Expected /?url=<base64-of-https-url>',400);
  const viewerMode=params.get('viewer')==='1';
  const v2Mode=params.get('v2')==='1';
  const v2Prefix=params.get('v2prefix')||'/__bp__/';
  if(v2Mode && (v2Prefix.length>160 || !/^\/(?:[a-zA-Z0-9_-]+\/)*__bp__\/$/.test(v2Prefix))) {
    return errorResponse('Invalid v2 proxy path prefix',400);
  }
  const v2Route=(raw,base)=>routeUrl(raw,base,v2Prefix);
  let target,replay;
  try {
    target=base64ToUtf8(params.get('url'));
    validatePublicTarget(target,env);
    replay=parseReplay(params);
  } catch(e) {return errorResponse(e.message || 'Invalid request envelope');}
  try {
    const {response,finalUrl,redirectCookies}=await fetchPublic(target,env,replay);
    let mime=(response.headers.get('content-type')||'application/octet-stream').split(';')[0].trim().toLowerCase();
    const claimedSize=Number(response.headers.get('content-length'));
    if (claimedSize > MAX_RESPONSE_BYTES) {
      if (response.body) await response.body.cancel();
      return errorResponse('Upstream body exceeds 10 MiB',413);
    }
    if (requestMethod==='HEAD') {
      if(response.body) await response.body.cancel();
      const result=envelope(null,mime,response.status,finalUrl,response.headers,redirectCookies);
      await result.body.cancel();
      return new Response(null,{headers:result.headers});
    }
    let body=response.body;
    if (v2Mode && (mime==='text/html'||mime==='application/xhtml+xml')) {
      body=rewriteHtml(new Response(body,{headers:{'Content-Type':'text/html; charset=utf-8'}}),finalUrl,'v2',v2Prefix).body;
      mime='text/html';
    } else if (v2Mode && mime==='text/css') {
      const rawCss=await new Response(body).text();
      if (new TextEncoder().encode(rawCss).byteLength>MAX_RESPONSE_BYTES) return errorResponse('Upstream body exceeds 10 MiB',413);
      body=new Response(rewriteCssMode(rawCss,finalUrl,v2Route)).body;
    } else if (!viewerMode && (mime==='text/html'||mime==='application/xhtml+xml')) {
      body=rewriteHtml(new Response(body,{headers:{'Content-Type':'text/html; charset=utf-8'}}),finalUrl).body;
      mime='text/html';
    } else if (!viewerMode && mime==='text/css') {
      const rawCss=await new Response(body).text();
      if (new TextEncoder().encode(rawCss).byteLength>MAX_RESPONSE_BYTES) return errorResponse('Upstream body exceeds 10 MiB',413);
      body=new Response(rewriteCss(rawCss,finalUrl)).body;
    }
    return envelope(body,mime,response.status,finalUrl,response.headers,redirectCookies);
  } catch(e) {return errorResponse(e.message||'Upstream unavailable',/exceeds 10 MiB/.test(e.message||'')?413:502);}
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      } });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse('Only GET and HEAD are available', 405);
    const url = new URL(request.url);
    if (url.searchParams.has('tunnel')) return stagedTunnelRequest(url.searchParams,env);
    if (url.searchParams.has('batch')) return proxyImageBatch(url.searchParams,env);
    if (url.searchParams.has('ws_action')) return wsBridgeRequest(url.searchParams, env);
    return proxyRequestFromParams(url.searchParams,env,request.method);

  }
};

export { utf8ToBase64, base64ToUtf8, base64ToBytes, bytesToBase64, parseReplay, wrapUrl, rewriteCss, rewriteSrcset, rewriteUrl, validatePublicTarget, proxyImageBatch, routeUrl, rewriteHtml, rewriteCssMode };
