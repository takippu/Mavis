import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) {
    throw new Error("Usage: node render-slides.mjs --deck <slides.html> --manifest <manifest.json> --out <directory> [--chrome <path>]");
  }
  args.set(key.slice(2), value);
}

const deckPath = resolve(args.get("deck") || "slides.html");
const manifestPath = resolve(args.get("manifest") || "manifest.json");
const outputRoot = resolve(args.get("out") || dirname(deckPath));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const chromeCandidates = [
  args.get("chrome"),
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));

if (!existsSync(deckPath)) throw new Error(`Deck not found: ${deckPath}`);
if (!chrome) throw new Error("Chrome not found. Set CHROME_PATH or pass --chrome <path>.");
if (!manifest.campaigns || !manifest.platforms) {
  throw new Error("Manifest requires campaigns and platforms objects.");
}

const deckUrl = pathToFileURL(deckPath).href;
const rendered = [];

for (const [platform, dimensions] of Object.entries(manifest.platforms)) {
  const width = Number(dimensions.width);
  const height = Number(dimensions.height);
  for (const [campaign, campaignConfig] of Object.entries(manifest.campaigns)) {
    const count = Number(campaignConfig.slides ?? campaignConfig);
    const campaignDir = join(outputRoot, platform, campaign);
    mkdirSync(campaignDir, { recursive: true });
    for (let slide = 1; slide <= count; slide += 1) {
      const filename = `slide-${String(slide).padStart(2, "0")}.png`;
      const output = join(campaignDir, filename);
      const url = `${deckUrl}?platform=${encodeURIComponent(platform)}&campaign=${encodeURIComponent(campaign)}&s=${slide}`;
      const result = spawnSync(chrome, [
        "--headless=new",
        "--hide-scrollbars",
        "--disable-gpu",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=2500",
        `--window-size=${width},${height}`,
        `--screenshot=${output}`,
        url,
      ], { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `Render failed: ${output}`);
      }
      rendered.push({ platform, campaign, slide, filename });
      process.stdout.write(`rendered ${platform}/${campaign}/${filename}\n`);
    }
  }
}

const sections = Object.keys(manifest.platforms).map((platform) => {
  const campaigns = Object.entries(manifest.campaigns).map(([campaign, config]) => {
    const label = config.label || campaign;
    const cards = rendered
      .filter((item) => item.platform === platform && item.campaign === campaign)
      .map((item) => `<a href="${platform}/${campaign}/${item.filename}"><img src="${platform}/${campaign}/${item.filename}" alt="${label} slide ${item.slide}"><span>${String(item.slide).padStart(2, "0")}</span></a>`)
      .join("");
    return `<section><h2>${label}</h2><div class="grid">${cards}</div></section>`;
  }).join("");
  return `<main><h1>${platform}</h1>${campaigns}</main>`;
}).join("");

const gallery = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${manifest.title || "Slideshow campaign"}</title><style>body{margin:0;padding:40px;background:#181414;color:#fff;font-family:Arial,sans-serif}main{margin-bottom:64px}h1{text-transform:capitalize}h2{margin-top:32px;color:#d9b7b7}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:18px}a{position:relative;color:#fff}img{display:block;width:100%;border-radius:14px}span{position:absolute;right:8px;bottom:8px;padding:6px 8px;background:#181414;border-radius:7px}</style></head><body>${sections}</body></html>`;
writeFileSync(join(outputRoot, "gallery.html"), gallery);
process.stdout.write(`gallery ${join(outputRoot, "gallery.html")}\n`);

