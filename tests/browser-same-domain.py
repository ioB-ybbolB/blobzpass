"""Optional local-browser integration: one origin for viewer + content + SW.
Runs a mocked Noteboard bridge; doesn't contact destination websites.
"""
from __future__ import annotations
import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PORT=18931
BASE=f'http://127.0.0.1:{PORT}'
HOME='https://blobby-boi2.github.io/BlobbypassPlus/'
ORIGIN='https://test.example'
ROUTE='/__bp__/o/'+base64.urlsafe_b64encode(ORIGIN.encode()).decode().rstrip('=')
seen=[]

def envelope(body,target,mime='text/html',status=200):
    if isinstance(body,str):body=body.encode()
    meta=base64.b64encode(json.dumps({'mime':mime,'status':status,'url':target,'headers':{'content-type':mime}}).encode()).decode()
    return ('<!DOCTYPE html><html><head><meta name="blobzpass-meta" content="'+meta+'"></head><body><pre id="output">'+base64.b64encode(body).decode()+'</pre></body></html>').encode()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        path=urlparse(self.path)
        if path.path=='/mocknoteboard':
            worker=parse_qs(path.query).get('file',[''])[0]
            search=parse_qs(urlparse(worker).query)
            raw=search.get('url',[''])[0]
            if not raw:
                self.respond(envelope('{"ok":true}','blobzpass:tunnel','application/json'));return
            target=base64.b64decode(raw).decode()
            seen.append(target)
            if target.endswith('/native.js'):
                body="document.body.dataset.native='yes';"
                mime='text/javascript'
            elif target.endswith('/favicon.ico'):
                body='';mime='image/x-icon'
            elif '/api?' in target:
                body='API='+target.split('?',1)[1];mime='text/plain'
            elif '/next?' in target:
                body='<html><head><script src="/__bp__/bridge.js"></script><title>Next Page</title></head><body><h1 id="next">NEXT</h1></body></html>'
                mime='text/html'
            else:
                body=f'''<!doctype html><html><head><script src="/__bp__/bridge.js"></script><title>Native Test</title></head><body>
                <h1 id="heading">Native Browser</h1><script src="{ROUTE}/native.js"></script>
                <a id="next-link" href="{ROUTE}/next?q=one%26two">Next page</a>
                <script>window.addEventListener('load',async()=>{{const r=await fetch('/api?url=a%26b%3Dc&plus=x%2By');document.body.dataset.api=await r.text()}});</script>
                </body></html>'''
                mime='text/html'
            self.respond(envelope(body,target,mime));return
        fp=ROOT/(path.path.lstrip('/') or 'viewer.html')
        if path.path=='/sw.js':
            source=(ROOT/'sw.js').read_text().replace('https://www.noteboardapp.com/showCodeFile.php?file=',BASE+'/mocknoteboard?file=')
            self.respond(source.encode(),'text/javascript');return
        if fp.is_file() and fp.resolve().is_relative_to(ROOT.resolve()):
            mime='text/javascript' if fp.suffix=='.js' else 'text/html' if fp.suffix=='.html' else 'text/plain'
            self.respond(fp.read_bytes(),mime);return
        self.send_response(404);self.end_headers()
    def respond(self,data,mime='text/html'):
        self.send_response(200);self.send_header('content-type',mime);self.send_header('cache-control','no-store');self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data)

if __name__=='__main__':
    server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
            context=browser.new_context(service_workers='allow',viewport={'width':1280,'height':800})
            page=context.new_page()
            errors=[]
            page.on('pageerror',lambda error: errors.append(str(error)))
            page.goto(BASE+'/viewer.html',wait_until='domcontentloaded',timeout=10000)
            assert page.locator('#address').input_value()==''
            assert page.locator('#new-tab').count()==1
            frame=page.frame_locator('iframe').first
            frame.locator('#heading').wait_for(timeout=20000)
            frame.locator('body[data-native="yes"]').wait_for(timeout=10000)
            frame.locator('body[data-api]').wait_for(timeout=10000)
            assert page.locator('.tab .tab-label').first.inner_text()=='Native Test'
            page.locator('#new-tab').click()
            assert page.locator('.tab').count()==2
            assert page.locator('#address').input_value()==''
            page.locator('#address').fill('test.example')
            page.locator('#address').press('Enter')
            page.frame_locator('iframe.active').locator('#heading').wait_for(timeout=15000)
            page.frame_locator('iframe.active').locator('#next-link').click()
            page.frame_locator('iframe.active').locator('#next').wait_for(timeout=15000)
            assert page.locator('.tab.active .tab-label').inner_text()=='Next Page'
            assert 'next?q=one%26two' in page.locator('#address').input_value()
            page.screenshot(path=str(ROOT/'tests'/'same-domain-preview.png'))
            assert not errors,errors
            print('SAME DOMAIN BROWSER TEST PASSED',len(seen),'mock Noteboard responses')
            browser.close()
    finally:
        server.shutdown()
