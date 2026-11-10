# blobzpass v2.2 — GitHub Pages `/blobzpass/` edition

This is the **v2.1 dark-tab UI** with the Service Worker/Noteboard proxy adapted to the GitHub Pages project URL:

**https://iob-ybbolb.github.io/blobzpass/**

The GitHub Pages project path is retained for **all app endpoints and rewritten v2 HTML/CSS resources**. The entrypoint is `https://iob-ybbolb.github.io/blobzpass/viewer.html`, and `index.html` redirects to it.

## Publish to GitHub Pages

Put these six files **directly at the root of the `blobzpass` repository's published directory** (the repository root if Pages publishes from `main / (root)`, or inside `docs/` if publishing from `main /docs`):

```text
https://iob-ybbolb.github.io/blobzpass/
  index.html          -> viewer.html
  viewer.html         dark multi-tab browser UI
  content.html        registers /blobzpass/sw.js, starts proxied navigation
  sw.js               Service Worker, scope /blobzpass/
  bridge.js           native page state, navigation and WebSocket bridge
  config.js           detects the shared hosting origin
```

**Do not add another `blobzpass/` folder inside the published directory.** The GitHub Pages repository URL already supplies that segment. You can keep the Worker source, tests, Wrangler configs, and other project files in the repository too; they are not loaded by the browser.

You must also deploy the **included updated `worker.js`** to `https://blobzpass.iob-ybbolb.workers.dev` (or update `WORKER_ORIGIN` in `sw.js` for a different Worker). Unlike v2.1, the Worker now reads the v2 `v2prefix=/blobzpass/__bp__/` query parameter so it writes scoped URLs into proxied HTML, CSS and meta refresh redirects, and injects the bridge script under the project path. **Both the GitHub Pages files and Cloudflare Worker need updating.**

Deploy Cloudflare Worker from the project folder:

```sh
npm install
npm run deploy
# alternatively, if the existing CookieSession namespace uses legacy KV:
# npm run deploy:legacy-kv
```

Preserve your existing Durable Object namespace and migration history. The `CookieSession` compatibility stub remains; this update does not recover the original class behavior.

## Path behavior

| Resource | URL path |
|---|---|
| Browser UI | `/blobzpass/viewer.html` |
| Content bootstrap | `/blobzpass/content.html` |
| Service Worker script and scope | `/blobzpass/sw.js` and `/blobzpass/` |
| Proxied page | `/blobzpass/__bp__/o/ENCODED_ORIGIN/page?x=1` |
| Injected bridge | `/blobzpass/__bp__/bridge.js` |
| WebSocket GET tunnel | `/blobzpass/__bp__/ws?...` |
| Dynamic links, forms, and embedded frames | Rewritten into `/blobzpass/__bp__/o/…` when the bridge can intercept them |

The UI and content bootstrap derive their base from their actual directory. The Service Worker uses its *registered scope* to derive the base; no special GitHub Pages hostname needs to be hardcoded. `index.html` uses a relative redirect, not `/viewer.html`. Query strings containing nested `url=`, `&`, plus signs, and encoded characters are preserved by the tested code paths.

New tabs continue loading `https://blobby-boi2.github.io/BlobbypassPlus/` via the proxy, while keeping the address bar blank by default. The v1-style dark tabs, back/forward buttons, favicons and titles remain unchanged.

### First-load behavior

`content.html` registers the Worker under the `/blobzpass/` scope and waits for it to control the page before navigating to the proxy route. Refresh the tab after uploading all six files. If an older Service Worker remains active, close existing blobzpass tabs and reload; in browser DevTools → Application → Service Workers, you can also unregister the old `/blobzpass/` registration before refreshing.

**GitHub Pages and Service Worker limitations:** A page navigation that escapes `/blobzpass/` entirely (for example, a website's direct `location.href = '/login'`) is outside the Service Worker's navigation scope and may reach a GitHub Pages 404. Static links and commonly created dynamic anchors/forms/iframes are rewritten, but arbitrary scripts can still produce root navigations that cannot be intercepted by a project-scoped Service Worker. This is a browser-enforced scope rule, not solved by a virtual origin string.

## Known limits and security

- **Same-origin exposure:** The toolbar and untrusted proxied pages are hosted on the same real origin. This remains unsafe for sensitive browsing even if your repository is unlisted. Third-party scripts can potentially access the toolbar and shared browser storage. Use a disposable browser profile and do not sign into sensitive accounts. A separate-origin deployment is safer.
- **CAPTCHA:** A Service Worker cannot impersonate the real website origin. Domain-bound challenges may still fail.
- **Noteboard:** The browser must be allowed to make CORS requests to Noteboard and read the Base64 HTML envelope; the Worker can't change Noteboard's CORS policy.
- **GET-only transport:** Requests use Noteboard GET to reach the Cloudflare Worker. POST bodies are staged where necessary. WebSockets use a polling bridge, not a native upgrade.
- **Logs:** Encoded headers, cookies and request bodies in GET URLs are not encrypted beyond HTTPS and may be logged by intermediaries.
- **Native origin-root navigation:** Project-scoped Service Workers cannot control navigations outside their allowed scope. Hardcoded JS redirects may escape.
- **Live test:** No live GitHub Pages/Noteboard end-to-end test is claimed. The authoring environment blocks Chromium from navigating to localhost.

## Tests

```sh
npm test
npm run test:legacy-worker
```

The tests cover first-load `/blobzpass/` scope registration, Worker path-aware HTML/CSS rewriting, query strings, POST staging, WebSocket routing, image batching, redirects, and existing Worker regressions. The optional `tests/browser-same-domain.py` uses mocked Noteboard requests under a simulated `/blobzpass/` path, but was blocked by this environment's Chromium network policy.
