# brain-viz

Interactive graph visualization of the Mavis brain. Walks the brain directory, parses every `.md` file + frontmatter, builds a hierarchical compound graph (categories → projects → files), and renders with cytoscape.js. Click any leaf node to read its content in a side panel.

```
                ┌─────────────┐
                │  IDENTITY   │
                └──────┬──────┘
                       │
   ┌───────────┬───────┴────────┬───────────┬───────────┐
   │           │                │           │           │
profile  personality  communication  preferences   ...

(every category collapses to one dot until clicked)
```

---

## Quick start

**Windows:** double-click `start.bat`
**Mac/Linux:** `./start.sh` (run `chmod +x start.sh` once if needed)

The script will:

1. Check for Node.js (install from https://nodejs.org if missing)
2. Run `npm install` (first run only — takes ~30 sec)
3. Parse the brain → write `public/data.json`
4. Start the Vite dev server at http://localhost:5174 and auto-open your browser

## Manual commands

```bash
npm install              # first time only
npm run build:data       # parse brain → public/data.json
npm run dev              # start dev server (http://localhost:5174)
npm start                # both, in one shot
```

## How it works

`scripts/build-data.ts` walks the brain root (one level above `viz/`), extracts file content + frontmatter, and emits `public/data.json`. The Vite app fetches that, hands it to cytoscape.js, and renders.

Categories (`identity`, `core`, `projects`, `daily-memories`, `skills`) are compound parent nodes. Click to expand/collapse. Cross-cutting edges (e.g. a daily memory's frontmatter `projects:` array) stay visible across drill-down levels.

File contents are embedded in `data.json` so the runtime needs no backend or special Vite file-serving config.

## Interactions

- **Click a category node** → expand/collapse its children
- **Click a project node** → expand/collapse its files
- **Click a leaf (file) node** → side panel slides in with rendered markdown
- **Click empty space** → close the panel
- **Esc** → close the panel
- **Scroll wheel** → zoom
- **Drag** → pan / move nodes

## After updating the brain

Data is baked at parse time. To pick up new memories or projects, restart `start.bat` / `start.sh` — it re-parses on each run. (Future improvement: file watcher with HMR.)

## Tech

Vite · TypeScript · cytoscape.js · cytoscape-cose-bilkent (compound-aware layout) · cytoscape-expand-collapse (drill-down) · marked (markdown rendering) · tokyonight palette
