# blobzpass v2.1 — same-domain browser edition

This edition restores the **v1.7-style dark browser UI** while retaining the **v2 Service Worker architecture**. You can host **`viewer.html` and `content.html` on the same HTTPS hostname**. The site must serve the files from its web root (not a subdirectory) for the supplied Service Worker paths to work.

## Deploy

1. Deploy the Cloudflare Worker using `npm install && npm run deploy` from this folder. If the existing `CookieSession` namespace was created with **legacy KV** rather than SQLite, use `npm run deploy:legacy-kv`. Keep your existing Durable Object namespaces/migration history. The v2.1 Worker is the v2 preview Worker; no new migration is introduced here.
2. Copy these files **together to the root of ONE HTTPS website**:

   ```text
   https://YOUR-HOST.example/
       index.html        (redirects to viewer.html)
       viewer.html       (tabbed browser UI)
       content.html      (registers Service Worker and opens virtual routes)
       config.js         (detects the shared origin automatically)
       sw.js             (root-scoped Service Worker)
       bridge.js         (frame state/navigation/WebSocket compatibility)
   ```

3. Open `https://YOUR-HOST.example/viewer.html` (or the site root). New tabs load `https://blobby-boi2.github.io/BlobbypassPlus/` *through the proxy*, and the address bar initially stays blank. Typing `example.com` automatically uses HTTPS.
4. Make sure the host serves `sw.js` and `bridge.js` with a JavaScript MIME type; `sw.js` needs to be served at exactly `/sw.js`, with Service Worker scope `/`. Normal static files must not be rewritten to the proxied route. **Do not open with `file://`**; use a real HTTPS origin (localhost is suitable for local development).
5. The browser must be permitted to `fetch()` Noteboard cross-origin and read its HTML response. If Noteboard blocks CORS, the tunnel cannot function even though the local UI loads. It is not fixed by same-origin hosting.

**No separate content hostname and no config file edits are required.** The `config.js` automatically uses `location.origin` for both the viewer and content bridge. The browser toolbar accepts state only from its own frames, and navigation commands still go through the Service Worker proxy route, but this is *not a security boundary* when sharing an origin.

## What is preserved

- Original-style dark tab strip and toolbar with SVG back / forward / refresh / home buttons and the `…` menu.
- Independent tabs, page title/favicon reporting, Ctrl+T/W/L/R shortcuts, automatic HTTPS, blank address bar on new default-home tabs.
- V2 real-document Service Worker proxy routing, ordinary script loading, native `document.write`, native IndexedDB/canvas and XMLHttpRequest within the shared-origin limitations.
- Noteboard GET-only requests to the Cloudflare Worker, POST staging, 45-image batching, Durable Object WebSocket polling bridge, query strings and redirects.

## Important security warning

**Hosting the toolbar and untrusted proxied pages on the same origin is unsafe, even on a private or unlisted website.** When the iframe has both `allow-scripts` and `allow-same-origin`, its sandbox does **not** protect the toolbar from code running in the proxied site. Third-party scripts can potentially inspect or modify the toolbar, other tabs, shared-origin storage, and Service Worker state. A nonpublic site does not prevent hostile JavaScript from arriving in a page you choose to visit. This edition is suitable only for disposable testing environments, not for personal accounts, passwords, or any real user data.

For isolation in a real deployment, keep the **separate-origin v2 architecture**: one dedicated disposable origin for proxied documents and a different origin for the toolbar. The separate-origin v2 preview is still available as the preceding package.

The viewer has an on-screen shared-origin notice; `?hideSharedOriginWarning=1` hides that reminder only, not the risk.

## Remaining limitations

- A Service Worker cannot make the content origin become the destination site's true security origin. CAPTCHA site-key checks, origin-dependent authentication, and cross-site cookies can still fail.
- Noteboard must allow CORS reads from the host; no live verification is included.
- WebSockets remain GET-polling bridged, and true streaming is unavailable with this Base64 envelope.
- Base64 payloads and sensitive request data may be visible in GET logs at Noteboard and intermediaries. Avoid logins.
- Both `viewer.html` and `content.html` are static, but **they are not independent single-file applications**: the separate `/sw.js` and `/bridge.js` files are required.

## Tests

```bash
npm test
npm run test:legacy-worker
```

There is also `tests/browser-same-domain.py`, a mocked local Chromium browser test. It requires a browser environment that permits localhost navigation. In the authoring environment, Chromium returned `ERR_BLOCKED_BY_ADMINISTRATOR` for local HTTP navigation, so full Service Worker browser integration **has not been verified**. A separate UI-only Chromium test passed for restored controls, new tabs, blank home address, and the options menu. The Node suites test Worker routing, the GET transport, POST staging, redirects, and image batching without contacting websites.
