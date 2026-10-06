'use strict';
const fs = require('fs');
const path = require('path');
const { atomic } = require('./workspace-service');
function visibleBounds(saved, areas) {
  const defaults = { width: 1200, height: 800 };
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return defaults;
  const width = Math.max(900, Math.min(2500, saved.width)), height = Math.max(560, Math.min(1800, saved.height));
  if (!areas.some(a => saved.x + width > a.x + 100 && saved.x < a.x + a.width - 100 && saved.y >= a.y && saved.y < a.y + a.height - 100)) return defaults;
  return { x: saved.x, y: saved.y, width, height };
}
function read(dir, areas) { try { return visibleBounds(JSON.parse(fs.readFileSync(path.join(dir, 'window-state.json'), 'utf8')), areas); } catch { return { width: 1200, height: 800 }; } }
function write(dir, bounds) { atomic(path.join(dir, 'window-state.json'), bounds); }
module.exports = { visibleBounds, read, write };
