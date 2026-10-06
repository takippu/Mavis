'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { visibleBounds } = require('../src/window-state');
test('window state recovers from disconnected displays and clamps minimum size', () => { const areas = [{ x: 0, y: 0, width: 1440, height: 900 }]; assert.deepEqual(visibleBounds({ x: 4000, y: 100, width: 1000, height: 700 }, areas), { width: 1200, height: 800 }); assert.deepEqual(visibleBounds({ x: 100, y: 100, width: 400, height: 300 }, areas), { x: 100, y: 100, width: 900, height: 560 }); });
