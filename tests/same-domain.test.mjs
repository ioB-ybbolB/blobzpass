import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=(n)=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');

test('same-domain package contains both HTML entrypoints and root-scoped Service Worker',()=>{
  const viewer=source('viewer.html');const content=source('content.html');
  assert.match(viewer,/id="new-tab"/);
  assert.match(viewer,/id="more"/);
  assert.match(viewer,/id="form"/);
  assert.match(viewer,/const FRAME_BOOTSTRAP='\/content\.html'/);
  assert.match(viewer,/https:\/\/blobby-boi2\.github\.io\/BlobbypassPlus\//);
  assert.match(content,/register\('\/sw\.js',\{scope:'\/'\}\)/);
});

test('configuration uses one deployment origin, and bridge accepts same-origin commands from parent',()=>{
  const config=source('config.js');const bridge=source('bridge.js');
  assert.match(config,/BLOBZPASS_CONTENT_ORIGIN\s*=\s*self\.location\.origin/);
  assert.match(config,/BLOBZPASS_VIEWER_ORIGIN\s*=\s*self\.location\.origin/);
  assert.doesNotMatch(bridge,/allowed===location\.origin/);
  assert.match(bridge,/event\.source!==parent/);
  assert.match(bridge,/event\.origin!==allowed/);
});

test('shared-origin mode routes remote navigation through proxy while maintaining title/favicon',()=>{
  const viewer=source('viewer.html');const bridge=source('bridge.js');
  assert.match(viewer,/event\.origin!==ORIGIN/);
  assert.match(viewer,/event\.data\?\.type!=='blobzpass:state'/);
  assert.match(viewer,/tab\.icon=.*startsWith\('\/__bp__\/o\/'\)/);
  assert.match(bridge,/location\.assign\(proxyUrl\(/);
});
