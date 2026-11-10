import test from 'node:test';
import assert from 'node:assert/strict';
import { routeUrl, rewriteCssMode } from '../worker.js';
const origin = Buffer.from('https://example.org').toString('base64url');
test('v2 routes preserve original host, path, and query', () => {
  const url=routeUrl('/demon/123?url=https%3A%2F%2Fexample.net%2F%3Fa%3D1%26b%3D2&x=a%2Bb','https://example.org/other');
  assert.equal(url,`/__bp__/o/${origin}/demon/123?url=https%3A%2F%2Fexample.net%2F%3Fa%3D1%26b%3D2&x=a%2Bb`);
});
test('does not rewrite JavaScript/data/mailto URLs', () => {
  assert.equal(routeUrl('javascript:void(0)','https://example.org'),'javascript:void(0)');
  assert.equal(routeUrl('data:image/png;base64,AA==','https://example.org'),'data:image/png;base64,AA==');
});
test('CSS URLs and @import become same-origin service worker routes', () => {
  const css=rewriteCssMode('@import "./more.css"; .x{background:url(/asset.png?x=1&y=2)}','https://example.org/css/main.css',routeUrl);
  assert.match(css,new RegExp('/__bp__/o/'+origin+'/css/more\\.css'));
  assert.match(css,new RegExp('/__bp__/o/'+origin+'/asset\\.png\\?x=1&y=2'));
});
