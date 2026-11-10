/* Loaded into proxied documents by Worker HTMLRewriter. Runs only on the
 * untrusted content origin. It never runs inside the browser toolbar. */
(()=>{
'use strict';
const PREFIX='/__bp__/o/';
const cfg = '/__bp__/config.js'; // configuration is static and must stay on content host
function b64url(s){const b=new TextEncoder().encode(s);let out='';for(let i=0;i<b.length;i+=12000)out+=btoa(String.fromCharCode(...b.subarray(i,i+12000)));return out.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function fromB64(s){return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0)));}
function originalUrl(){try{const parts=location.pathname.slice(PREFIX.length);if(!location.pathname.startsWith(PREFIX))return null;const cut=parts.indexOf('/');if(cut<0)return null;return fromB64(parts.slice(0,cut))+parts.slice(cut)+location.search+location.hash;}catch{return null;}}
function proxyUrl(raw,base=originalUrl()){try{const u=new URL(raw,base||location.href);if(!/^https?:$/.test(u.protocol))return raw;return PREFIX+b64url(u.origin)+u.pathname+u.search+u.hash;}catch{return raw;}}
function favicon(){const icon=document.querySelector('link[rel~="icon"]');if(icon){const v=icon.getAttribute('href');if(v){try {return proxyUrl(v,originalUrl());}catch{}}}try{return proxyUrl(new URL('/favicon.ico',originalUrl()).href);}catch{return '';}}
function emit(){const url=originalUrl();if(!url)return;window.parent?.postMessage({type:'blobzpass:state',url,title:document.title||new URL(url).hostname,icon:favicon()},'*');}
function init(){emit();const t=document.querySelector('title');if(t){new MutationObserver(emit).observe(t,{subtree:true,childList:true,characterData:true});}
  const head=document.head;
  if(head)new MutationObserver(emit).observe(head,{subtree:false,childList:true});
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});else init();
window.addEventListener('pageshow',emit);window.addEventListener('popstate',emit);window.addEventListener('hashchange',emit);
for(const method of ['pushState','replaceState']){const prev=history[method];history[method]=function(...args){const r=prev.apply(this,args);queueMicrotask(emit);return r;};}
// HTML from the Worker already rewrites static src/href attributes. Handle a
// common dynamic iframe case before the browser makes a direct navigation.
function rewriteFrame(el){if(el?.tagName!=='IFRAME')return;const raw=el.getAttribute('src');if(!raw||/^(?:data:|about:|javascript:|blob:|#)/i.test(raw)||raw.startsWith(PREFIX))return;
  const newValue=proxyUrl(raw,originalUrl());if(newValue!==raw)el.setAttribute('src',newValue);
}
const nativeSet=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){if(this.tagName==='IFRAME'&&String(name).toLowerCase()==='src'&&value) value=proxyUrl(value,originalUrl());return nativeSet.call(this,name,value);};
const frameDesc=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
if(frameDesc?.set && frameDesc?.get){Object.defineProperty(HTMLIFrameElement.prototype,'src',{configurable:true,enumerable:frameDesc.enumerable,get:frameDesc.get,set(value){frameDesc.set.call(this,proxyUrl(value,originalUrl()));}});}
function scan(node){if(node.nodeType!==1&&node.nodeType!==11)return;if(node.nodeType===1)rewriteFrame(node);node.querySelectorAll?.('iframe[src]').forEach(rewriteFrame);}
for(const method of ['appendChild','insertBefore','replaceChild']){const native=Node.prototype[method];Node.prototype[method]=function(node,...args){scan(node);return native.call(this,node,...args);};}
const mo=new MutationObserver(list=>{for(const entry of list){if(entry.type==='childList')for(const node of entry.addedNodes)scan(node);else if(entry.type==='attributes')rewriteFrame(entry.target);}});
mo.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});
// Commands are only accepted from the configured browser-toolbar origin.
// Loading config.js dynamically must be independent of the proxied site.
// The fetch event cannot upgrade a WebSocket over a GET-only PHP gateway.
// Retain the v1 durable-object WS bridge as a bounded, polling-based shim.
const OriginalWebSocket=window.WebSocket;
class ProxyWebSocket extends EventTarget {
  static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
  constructor(address,protocols=[]) {
    super();
    const original=originalUrl();
    const fallback=(original||location.href).replace(/^https:/,'wss:').replace(/^http:/,'ws:');
    const parsed=new URL(address,fallback);
    if(!['ws:','wss:'].includes(parsed.protocol))throw new DOMException('Invalid WebSocket URL','SyntaxError');
    this.url=parsed.href;this.readyState=0;this.protocol='';this.extensions='';this.binaryType='blob';this.bufferedAmount=0;
    this._id=crypto.randomUUID();this._stop=false;
    this._protocols=Array.isArray(protocols)?protocols:(protocols?[protocols]:[]);
    this._open();
  }
  async _call(action,extra={}){
    const params=new URLSearchParams({ws_action:action,ws_id:this._id,nonce:crypto.randomUUID(),...extra});
    const result=await fetch('/__bp__/ws?'+params,{cache:'no-store'});
    const payload=await result.json();
    if(!result.ok||!payload.ok)throw Error(payload.error||'WebSocket GET tunnel failed');
    return payload;
  }
  _emit(type,props={}){let e;if(type==='message')e=new MessageEvent('message',{data:props.data,origin:this.url});
    else if(type==='close')e=new CloseEvent('close',{code:props.code||1000,reason:props.reason||'',wasClean:props.wasClean===true});
    else e=new Event(type);
    this.dispatchEvent(e);const handler=this['on'+type];if(typeof handler==='function')try{handler.call(this,e);}catch(error){setTimeout(()=>{throw error;});}
  }
  async _open(){try{
    const source=originalUrl()||'https://invalid.example/';
    const result=await this._call('connect',{target:btoa(unescape(encodeURIComponent(this.url))),origin:btoa(new URL(source).origin),protocols:btoa(JSON.stringify(this._protocols))});
    if(this._stop)return;
    this.readyState=1;this.protocol=result.protocol||'';this._emit('open');this._poll();
  }catch(e){this.readyState=3;this._emit('error');this._emit('close',{code:1006,reason:'',wasClean:false});console.warn('[blobzpass ws]',e);}}
  async _poll(){while(!this._stop&&this.readyState===1){try{const result=await this._call('poll');
    for(const event of result.events||[]){if(event.type==='message'){
      let data=event.data;
      if(event.binary){const raw=atob(data);const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));data=this.binaryType==='arraybuffer'?bytes.buffer:new Blob([bytes]);}
      this._emit('message',{data});
    }else if(event.type==='error')this._emit('error');else if(event.type==='close'){this.readyState=3;this._stop=true;this._emit('close',event);}}
    if(result.closed&&!this._stop){this.readyState=3;this._stop=true;this._emit('close');}
  }catch(e){this.readyState=3;this._stop=true;this._emit('error');this._emit('close',{code:1006,wasClean:false});break;}}}
  send(data){if(this.readyState!==1)throw new DOMException('WebSocket is not open','InvalidStateError');
    const submit=async()=>{let bytes,binary=false;
      if(typeof data==='string')bytes=new TextEncoder().encode(data);
      else if(data instanceof Blob){bytes=new Uint8Array(await data.arrayBuffer());binary=true;}
      else if(data instanceof ArrayBuffer){bytes=new Uint8Array(data);binary=true;}
      else if(ArrayBuffer.isView(data)){bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);binary=true;}
      else bytes=new TextEncoder().encode(String(data));
      if(bytes.length>32768)throw Error('WebSocket message exceeds 32 KiB');
      let encoded='';for(let i=0;i<bytes.length;i+=12000)encoded+=btoa(String.fromCharCode(...bytes.subarray(i,i+12000)));
      await this._call('send',{data:encoded,binary:binary?'1':'0'});
    };
    submit().catch(e=>{console.warn('[blobzpass ws send]',e);this._emit('error');});
  }
  close(code=1000,reason=''){if(this.readyState===3)return;this.readyState=2;this._stop=true;
    this._call('close',{code:String(code),reason:btoa(unescape(encodeURIComponent(reason)))}).catch(()=>{}).finally(()=>{this.readyState=3;this._emit('close',{code,reason,wasClean:true});});
  }
}
for(const [key,value] of Object.entries({CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3}))Object.defineProperty(ProxyWebSocket.prototype,key,{value});
window.WebSocket=ProxyWebSocket;

const configScript=document.createElement('script');configScript.src=cfg;
configScript.addEventListener('load',()=>{
  const allowed=window.BLOBZPASS_VIEWER_ORIGIN;
  if(!allowed||!/^https?:\/\//.test(allowed))return;
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.origin!==allowed||event.data?.type!=='blobzpass:command')return;
    const action=event.data.action;
    if(action==='back') history.back();
    else if(action==='forward') history.forward();
    else if(action==='reload') location.reload();
    else if(action==='navigate' && typeof event.data.url==='string') location.assign(proxyUrl(event.data.url,originalUrl()));
  });
});
(document.head||document.documentElement).appendChild(configScript);
})();
