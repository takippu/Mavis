// app-promo-shots :: headless capture of a real app screen (Node 22+, no puppeteer).
//
// Usage:
//   1. Start a debug Chrome (leave it running):
//      "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
//        --hide-scrollbars --remote-debugging-port=9224 --user-data-dir=/tmp/cdp about:blank &
//   2. Public page:   node capture.mjs out.png "http://localhost:3000/<handle>"
//      Auth page:     node capture.mjs out.png "http://localhost:3000/app/analytics" --auth
//
// Edit CONFIG per app. Captures at a real-phone aspect so the promo phone frame
// fits 1:1 (match the frame's aspect-ratio to WIDTH/HEIGHT below).

const CONFIG = {
  base: "http://localhost:3000",
  envPath: "./.env",                 // where SEED_OWNER_PASSWORD / login secret lives
  email: "owner@example.com",        // an account that can see the auth page
  passwordEnvKey: "SEED_OWNER_PASSWORD",
  loginPath: "/api/auth/login",      // POST {email,password} -> Set-Cookie
  cookieName: "app_session",         // the app's session cookie name
  port: 9224,
  width: 460, height: 1000, dpr: 2,  // real-phone aspect (0.46)
  waitMs: 5000,
  // Display-only host swap: in dev, URL pills fall back to the internal dev host,
  // so a promo shot would advertise a hostname nobody can reach. Set these to the
  // dev fallback and the real production host for THIS app. Leave devHost empty
  // to skip the patch entirely.
  devHost: "dev.internal",
  publicHost: "example.com",
};

// JS run in the page before the shot: strip dev artifacts + fix display-only
// values. Only ever patch things the user cannot act on (a hostname label, a dev
// badge) - never prices, counts, or availability, which would be faking the
// product. split/join rather than a RegExp so a host with dots needs no escaping.
CONFIG.prepExpression = `(function(){
  document.querySelectorAll('nextjs-portal').forEach(e=>e.remove());   // Next dev badge
  const dev=${JSON.stringify(CONFIG.devHost)}, pub=${JSON.stringify(CONFIG.publicHost)};
  if(!dev) return;
  const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode())){ if(n.textContent.includes(dev)) n.textContent=n.textContent.split(dev).join(pub); }
})();`;

import fs from "node:fs";

const OUT = process.argv[2];
const URL = process.argv[3];                    // pass a FULL url; never a leading-slash arg (git-bash mangles it)
const AUTH = process.argv.includes("--auth");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = null;
if (AUTH) {
  const env = fs.readFileSync(CONFIG.envPath, "utf8");
  const pw = (env.match(new RegExp(`^${CONFIG.passwordEnvKey}=(.*)$`, "m")) || [])[1]?.trim();
  const r = await fetch(CONFIG.base + CONFIG.loginPath, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: CONFIG.email, password: pw }),
  });
  const sc = r.headers.getSetCookie();
  token = sc.map((c) => (c.match(new RegExp(`${CONFIG.cookieName}=([^;]+)`)) || [])[1]).find(Boolean);
  if (!token) { console.error("login failed", r.status, await r.text()); process.exit(1); }
}

const targets = await (await fetch(`http://localhost:${CONFIG.port}/json`)).json();
const target = targets.find((t) => t.type === "page") || targets[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const cmd = (m, p = {}) => new Promise((res, rej) => { const _id = ++id; pending.set(_id, { res, rej }); ws.send(JSON.stringify({ id: _id, method: m, params: p })); });
await new Promise((r) => ws.addEventListener("open", r));
ws.addEventListener("message", (ev) => { const d = JSON.parse(ev.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } });

await cmd("Page.enable");
await cmd("Network.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: CONFIG.width, height: CONFIG.height, deviceScaleFactor: CONFIG.dpr, mobile: true });
if (token) await cmd("Network.setCookie", { name: CONFIG.cookieName, value: token, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" });
await cmd("Page.navigate", { url: URL });
await sleep(CONFIG.waitMs);
await cmd("Runtime.evaluate", { expression: CONFIG.prepExpression });
await sleep(300);
const shot = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("saved", OUT);
ws.close();
process.exit(0);
