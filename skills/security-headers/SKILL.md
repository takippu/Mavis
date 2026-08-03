---
name: security-headers
description: >
  Scan, harden, and verify HTTP security headers for any web project, then apply a
  standard hardened header set framework-appropriately (Next.js, Astro, Cloudflare
  Pages/Workers, nginx, Laravel, Hono). Use whenever the user asks to "harden my
  headers", "check security headers", "improve my securityheaders.com grade", "fix
  my Mozilla Observatory score", "add a CSP", "set X-Frame-Options / HSTS / CSP",
  "why is my site not A+", or gives a URL + a header/CSP/security-grade question.
  Knows the securityheaders.com (A+) vs Mozilla Observatory (100/CSP) gap and the
  nonce-CSP-forces-dynamic-rendering tradeoff.
---

# Security Headers Skill

Harden a project's HTTP response headers to the standard best-practice set, verify against the two public scanners, and know exactly when to stop.

**The core principle you must internalize:** the two scanners measure different things, and chasing the last points has a real cost.

- **securityheaders.com** (by Snyk) grades on **header presence**. Having the six headers below = **A+**. Easy, no tradeoff.
- **Mozilla HTTP Observatory** grades on **strength**, and its scoring is dominated by the CSP. A CSP with no `script-src` (or one with `'unsafe-inline'`/`data:`) is penalized **-20** → caps you at **B+/80**. Getting to **100/A+** requires a real `script-src` without `'unsafe-inline'`, which for most JS frameworks means **per-request nonces** — and **nonce-based CSP forces dynamic rendering**, killing static/edge HTML caching. That is a perf regression, not a free win.

So: **the baseline set (Step 3) is always worth it. The nonce-CSP upgrade (Step 4) is a deliberate tradeoff — recommend it ONLY when the app has real auth/cookies/XSS surface.**

---

## Step 1 — Scan the current state

Get the "before" grade from BOTH scanners so you know the gap and can prove the "after".

**Primary (manual, always works) — give the user these + read the result yourself where possible:**
- `https://securityheaders.com/?q=<full-url>&followRedirects=on` → look for the letter grade.
- `https://developer.mozilla.org/en-US/observatory/analyze?host=<host>` → score /100 + the per-test table (the CSP row is the one that matters).

**Programmatic (if you want to read it directly):**
- securityheaders.com returns the grade in the **`X-Grade` response header**:
  `curl -sI "https://securityheaders.com/?q=https://<host>&followRedirects=on&hide=on" | grep -i x-grade`
- MDN Observatory API v2: `POST https://observatory-api.mdn.mozilla.net/api/v2/scan?host=<host>` then read the JSON (`grade`, `score`, `tests`).
- To see what's ACTUALLY served (ground truth, bypasses scanner caching):
  `curl -sI https://<host>/` and inspect the header block.

Record the before-grades. Note which of the six baseline headers are missing and what the CSP row says.

---

## Step 2 — Find where headers are configured

Locate the single place response headers are (or should be) set for this stack. Don't add a second, conflicting layer.

| Stack | Where headers live |
|-------|--------------------|
| **Next.js (App Router)** | `next.config.{ts,js}` → `async headers()` returning `[{ source: "/(.*)", headers: [...] }]`. (Nonce-CSP instead needs `middleware.ts` — Step 4.) |
| **Astro** | `_headers` file (CF Pages / Netlify) OR a middleware in `src/middleware.ts` OR the adapter/host config. Static builds → `_headers`. |
| **Cloudflare Pages** | `public/_headers` (plain-text `path:` then `Header: value` lines). |
| **Cloudflare Workers** | Set on the `Response` in the worker (`headers.set(...)`), or a `Response`-rewriting middleware. |
| **nginx / VPS** | `add_header <Name> "<value>" always;` in the `server{}` block. `always` is REQUIRED or error responses skip them. |
| **Laravel** | A middleware (`app/Http/Middleware/SecurityHeaders.php`) registered in the HTTP kernel, OR `Response` macro. |
| **Hono** | `app.use(secureHeaders(...))` (built-in) or a manual `c.header(...)` middleware. |

If a proxy (Cloudflare/nginx) sits in front, decide ONE owner for the headers — app-level is usually cleaner and travels with the code.

---

## Step 3 — Apply the baseline hardened set (always do this)

The six headers. This gets **A+** on securityheaders and **B+/80** on Observatory with **zero rendering tradeoff** — the CSP here is the "safe default" that blocks clickjacking / object / base-tag abuse WITHOUT a `script-src` that would break inline hydration scripts.

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY                     # or SAMEORIGIN if the app is legitimately iframed
Referrer-Policy: no-referrer              # or strict-origin-when-cross-origin if you need referrers
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'
```

Tune before applying:
- **Permissions-Policy**: OPEN only what the app uses. A camera app needs `camera=(self)`; most sites lock all of them down. `browsing-topics=()` opts out of the Topics API.
- **X-Frame-Options**: `frame-ancestors 'none'` in the CSP already covers modern browsers; keep `X-Frame-Options: DENY` for old ones.
- **HSTS `preload`**: only if the user intends to submit to the HSTS preload list AND all subdomains are HTTPS. Otherwise drop `preload` but keep `includeSubDomains`.
- **CSP note**: do NOT add `script-src`/`default-src` here unless you're doing Step 4 — a bare `script-src 'self'` will break every framework's inline hydration + inline JSON-LD.

Reference implementation (Next.js App Router — the exact shape that produced the
A+/B+ pair described above on a live site):
```ts
// next.config.ts
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
];
// in nextConfig: async headers() { return [{ source: "/(.*)", headers: securityHeaders }]; }
```

Get explicit approval before writing (the approval-before-mutations rule), then apply, build, and verify.

---

## Step 4 — (OPTIONAL, tradeoff) Nonce-CSP for Observatory 100 / A+

**Only reach for this when the app has real risk to close: cookies, auth tokens in JS, user-generated content, admin surfaces.** For a public marketing/landing page with no cookies, the +20 closes almost nothing and is NOT worth the cost below.

**State the tradeoff to the user before building it:**
- **Cost — SLOWER:** nonces must be unique per request, so the framework is forced into **dynamic (per-request SSR)** for pages carrying them. A CDN (Cloudflare) can **no longer cache the HTML** → every view hits the origin. This undoes static/edge-cached rendering.
- **Cost — fragility:** a new `middleware` must thread the nonce through EVERY inline script (framework hydration bootstrap, inline JSON-LD, any analytics beacon). One missed inline script = broken page or a console CSP error. Any future inline snippet must be nonce-aware.
- **Why hashes don't work instead:** framework hydration inline scripts change every build → their SHA hashes are unstable → nonce is the only robust path.

Next.js recipe (if approved):
1. `middleware.ts` mints a per-request nonce, sets `Content-Security-Policy: script-src 'nonce-<n>' 'strict-dynamic'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`, and forwards the nonce on a request header.
2. Next auto-applies the nonce to its own scripts when it detects it in the CSP.
3. Manually add `nonce={nonce}` to your inline `<script type="application/ld+json">` and any `next/script` beacon.
4. Move the CSP OUT of `next.config.ts` headers() (static) and into the middleware (dynamic).
5. **Test hard in a production build** — especially in modified/forked framework versions where middleware/nonce behavior may differ from stock.

Verify hydration still works (no CSP console errors, page interactive) BEFORE claiming done.

---

## Step 5 — Verify + report

Re-scan both scanners (or curl the headers) and confirm the grade moved. Report the before → after for each. State plainly if you stopped at baseline and why.

---

## Decision guide (memorize)

- **Public site, no login, no cookies** (marketing, landing, docs) → **baseline only**. A+/B+ is the correct stopping point. Do NOT trade static rendering for the Observatory +20.
- **App with auth / cookies / user content / admin** → baseline + **consider** nonce-CSP; the stronger `script-src` is genuine defense-in-depth and the dynamic-rendering cost is usually already paid (authed pages aren't cached anyway).
- Always separate "presence" (free, do it) from "strictness" (has a cost, justify it).

## Gotchas learned
- **A+ on securityheaders ≠ 100 on Observatory.** The delta is almost always the CSP `script-src`. Don't promise one grade when the user is looking at the other.
- **nonce-CSP → dynamic rendering → lost edge caching.** This is the hidden cost that makes "just get 100" a bad default for cacheable pages.
- **`add_header` in nginx needs `always`** or headers vanish on non-200 responses.
- **Modified/forked frameworks** (e.g. a customized Next): never assume stock middleware/nonce behavior — build + curl the real output.
- A CSP with `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` but **no `script-src`** still leaves scripts unrestricted — it's the safe baseline, not full XSS protection. Be honest about what it does and doesn't cover.
