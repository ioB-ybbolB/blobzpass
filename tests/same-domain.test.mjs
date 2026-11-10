import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=(n)=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');

test('GitHub Pages entrypoints, scope, and browser routes stay inside /blobzpass/',()=>{
  const viewer=source('viewer.html'),content=source('content.html'),index=source('index.html');
  assert.match(viewer,/id="new-tab"/);
  assert.match(viewer,/id="more"/);
  assert.match(viewer,/const APP_BASE=new URL\('\.\/',location.href\)\.pathname/);
  assert.match(viewer,/const FRAME_BOOTSTRAP=APP_BASE\+'content\.html'/);
  assert.match(viewer,/const PROXY_PREFIX=APP_BASE\+'__bp__\/o\/'/);
  assert.match(content,/const appBase=new URL\('\.\/',location.href\)\.pathname/);
  assert.match(content,/register\(appBase\+'sw\.js',\{scope:appBase\}\)/);
  assert.match(content,/location\.replace\(appBase\+'__bp__\/o\/'/);
  assert.match(index,/url=viewer\.html/);
  assert.doesNotMatch(index,/url=\/viewer\.html/);
});

test('Service Worker and bridge derive their route prefixes from the deployment scope',()=>{
  const sw=source('sw.js'),bridge=source('bridge.js');
  assert.match(sw,/new URL\(self\.registration\.scope\)\.pathname/);
  assert.match(sw,/const PROXY_BASE = APP_BASE \+ '__bp__\/'/);
  assert.match(sw,/v2prefix:PROXY_BASE/);
  assert.match(sw,/new URL\(APP_BASE\+url\.pathname\.slice\(PROXY_BASE\.length\),self\.location\.origin\)/);
  assert.match(bridge,/document\.currentScript\?\.src/);
  assert.match(bridge,/const PREFIX=PROXY_BASE\+'o\/'/);
  assert.match(bridge,/fetch\(PROXY_BASE\+'ws\?'/);
});

test('site state/favicons and commands still use same-host framing and scoped proxy routes',()=>{
  const viewer=source('viewer.html'),bridge=source('bridge.js');
  assert.match(viewer,/event\.origin!==ORIGIN/);
  assert.match(viewer,/event\.data\?\.type!=='blobzpass:state'/);
  assert.match(viewer,/tab\.icon=.*startsWith\(PROXY_PREFIX\)/);
  assert.match(bridge,/location\.assign\(proxyUrl\(/);
  assert.match(bridge,/raw\.startsWith\(PREFIX\)\)return raw/); // avoid double-wrapping proxied favicons
  assert.match(viewer,/https:\/\/blobby-boi2\.github\.io\/BlobbypassPlus\//);
});
