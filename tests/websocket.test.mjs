import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WebSocketBridge,utf8ToBase64} from '../worker.js';
import worker from '../worker.js';

const base = 'https://blobzpass.iob-ybbolb.workers.dev/';
function decodeEnvelope(html) {
  const match=html.match(/<pre id="output">([^<]+)<\/pre>/);
  assert.ok(match,'expected Base64 HTML envelope');
  return JSON.parse(Buffer.from(match[1],'base64').toString('utf8'));
}

test('Worker dispatches WebSocket commands to the configured Durable Object and wraps JSON',async()=>{
  const seen=[];
  const env={WS_BRIDGE:{
    idFromName(name){return name;},
    get(id){return {async fetch(request){seen.push({id,url:request.url});return new Response(JSON.stringify({ok:true,protocol:'chat'}));}};}
  }};
  const id='123e4567-e89b-42d3-a456-426614174000';
  const ws='wss://echo.example.org/api';
  const params=new URLSearchParams({ws_action:'connect',ws_id:id,target:utf8ToBase64(ws)});
  const res=await worker.fetch(new Request(base+'?'+params),env);
  assert.equal(res.status,200);
  assert.deepEqual(decodeEnvelope(await res.text()),{ok:true,protocol:'chat'});
  assert.equal(seen.length,1);
  assert.equal(seen[0].id,'blobzpass-ws:'+id);
  assert.equal(new URL(seen[0].url).pathname,'/connect');
  assert.equal(new URL(seen[0].url).searchParams.get('target'),utf8ToBase64(ws));
});

test('Worker refuses private WebSocket destinations before calling DO',async()=>{
  const env={WS_BRIDGE:{idFromName(){throw Error('should not reach DO');}}};
  const qs=new URLSearchParams({ws_action:'connect',ws_id:'123e4567-e89b-42d3-a456-426614174000',target:utf8ToBase64('wss://localhost/secret')});
  const res=await worker.fetch(new Request(base+'?'+qs),env);
  assert.match(decodeEnvelope(await res.text()).error,/local|private|blocked/i);
});

test('Durable Object establishes an upstream WebSocket and relays text and binary',async()=>{
  const nativeFetch=globalThis.fetch;
  const sent=[];
  class FakeSocket extends EventTarget {
    readyState=1;
    accept(){this.accepted=true;}
    send(data){sent.push(data);}
    close(code,reason){this.readyState=3;const e=new Event('close');Object.assign(e,{code,reason,wasClean:true});this.dispatchEvent(e);}
  }
  const socket=new FakeSocket();
  globalThis.fetch=async(url,opt)=>{
    assert.equal(url,'https://echo.example.org/ws');
    assert.equal(opt.headers.get('Upgrade'),'websocket');
    assert.equal(opt.headers.get('Origin'),'https://echo.example.org');
    return {webSocket:socket,headers:new Headers({'sec-websocket-protocol':'chat'})};
  };
  try {
    let alarmAt=0;
    const bridge=new WebSocketBridge({storage:{async setAlarm(value){alarmAt=value;}}},{});
    const make=u=>new Request('https://bridge.internal/'+u);
    const connect='connect?target='+encodeURIComponent(utf8ToBase64('wss://echo.example.org/ws'))+'&origin='+encodeURIComponent(utf8ToBase64('https://echo.example.org'))+'&protocols='+encodeURIComponent(utf8ToBase64('["chat"]'));
    assert.equal((await (await bridge.fetch(make(connect))).json()).protocol,'chat');
    assert.equal(socket.accepted,true);
    assert.ok(alarmAt > Date.now());
    const msg=new MessageEvent('message',{data:'hello'});
    socket.dispatchEvent(msg);
    const polling=await (await bridge.fetch(make('poll'))).json();
    assert.deepEqual(polling.events,[{type:'message',data:'hello',binary:false}]);
    const data=new Uint8Array([0,1,2,255]);
    socket.dispatchEvent(new MessageEvent('message',{data:data.buffer}));
    const binary=await (await bridge.fetch(make('poll'))).json();
    assert.equal(Buffer.from(binary.events[0].data,'base64').toString('hex'),'000102ff');
    assert.equal(binary.events[0].binary,true);
    const payload=Buffer.from('ping').toString('base64');
    assert.equal((await (await bridge.fetch(make('send?data='+encodeURIComponent(payload)))).json()).ok,true);
    assert.equal(sent[0],'ping');
    assert.equal((await (await bridge.fetch(make('close?code=1000'))).json()).ok,true);
    const closing=await (await bridge.fetch(make('poll'))).json();
    assert.equal(closing.events.at(-1).type,'close');
  } finally {globalThis.fetch=nativeFetch;}
});

test('Wrangler configurations declare and bind WebSocketBridge SQLite namespace without removing CookieSession',()=>{
  for(const name of ['wrangler.toml','wrangler.legacy-kv.toml']) {
    const config=readFileSync(new URL('../'+name,import.meta.url),'utf8');
    assert.match(config,/\[exports\.CookieSession\]/);
    assert.match(config,/\[exports\.WebSocketBridge\][\s\S]*?storage\s*=\s*"sqlite"/);
    assert.match(config,/name\s*=\s*"WS_BRIDGE"/);
    assert.match(config,/class_name\s*=\s*"WebSocketBridge"/);
  }
});

test('Standalone client retains sandbox and explicitly guards reCAPTCHA instead of weakening origin isolation',()=>{
  const html=readFileSync(new URL('../standalone.html',import.meta.url),'utf8');
  assert.match(html,/frame\.sandbox='allow-scripts allow-forms allow-popups'/);
  assert.doesNotMatch(html,/sandbox="[^"]*allow-same-origin/);
  assert.match(html,/class TunnelingWebSocket extends EventTarget/);
  assert.match(html,/window.WebSocket=TunnelingWebSocket/);
  assert.match(html,/id="captchaNotice"/);
  assert.match(html,/isRecaptchaResource/);
});
