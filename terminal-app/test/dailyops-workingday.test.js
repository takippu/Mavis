'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../src/dailyops');

const tmpBrain = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-do-'));
  fs.mkdirSync(path.join(root, 'standups'), { recursive: true });
  fs.mkdirSync(path.join(root, 'daily-memories'), { recursive: true });
  fs.mkdirSync(path.join(root, 'identity'), { recursive: true });
  fs.writeFileSync(path.join(root, 'identity', 'profile.md'), '---\nname: Ada\n---\n');
  return root;
};
const dow = (iso) => new Date(iso + 'T00:00:00').getDay();

test('parseOffDays: default Sat+Sun, custom, garbage falls back', () => {
  assert.deepStrictEqual(Array.from(d.parseOffDays(undefined)).sort((a, b) => a - b), [0, 6]);
  assert.deepStrictEqual(Array.from(d.parseOffDays('5,6')).sort((a, b) => a - b), [5, 6]);
  assert.deepStrictEqual(Array.from(d.parseOffDays('nope')).sort((a, b) => a - b), [0, 6]); // garbage → default
});

test('offDaysLabel reads as weekday names', () => {
  assert.strictEqual(d.offDaysLabel('6,0'), 'Sunday, Saturday');
  assert.strictEqual(d.offDaysLabel('5'), 'Friday');
});

test('prevWorkingDay skips off-days and lands on a working day', () => {
  // independent of the calendar: result is strictly before, is itself a working day, and every day
  // between it and the input is an off-day.
  for (const date of ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-04', '2026-07-06']) {
    const off = d.parseOffDays('6,0');
    const r = d.prevWorkingDay(date, '6,0');
    assert.ok(r < date, `${r} should be before ${date}`);
    assert.ok(!off.has(dow(r)), `${r} should be a working day`);
    // walk the gap: everything strictly between r and date is an off-day
    let cur = new Date(r + 'T00:00:00'); cur.setDate(cur.getDate() + 1);
    while (d.todayISO(cur) < date) { assert.ok(off.has(cur.getDay()), `${d.todayISO(cur)} in the gap must be an off-day`); cur.setDate(cur.getDate() + 1); }
  }
});

test('prevWorkingDay honours a custom off-day set', () => {
  // Friday off → the day before a Saturday should walk back past Friday to Thursday.
  const off = d.parseOffDays('5,6,0');
  const r = d.prevWorkingDay('2026-07-04', '5,6,0'); // 2026-07-04 is a Saturday
  assert.ok(!off.has(dow(r)));
});

test('memoriesSinceLastStandup: includes the standup day (its own work is reported next), tagged working/off', () => {
  const root = tmpBrain();
  // last standup on 2026-06-25 (Thu) — it reported 06-24's work, so 06-25's own work is still pending
  fs.writeFileSync(path.join(root, 'standups', '2026-06-25.md'), 'x');
  // memories 25(Thu) 26(Fri) 27(Sat) 28(Sun); 24 predates the standup's coverage
  for (const dt of ['2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27', '2026-06-28']) {
    fs.writeFileSync(path.join(root, 'daily-memories', dt + '.md'), 'm');
  }
  const mems = d.memoriesSinceLastStandup(root, '2026-06-29', '6,0');
  const dates = mems.map((m) => m.date);
  assert.ok(!dates.includes('2026-06-24'), 'covered by the last standup → excluded');
  assert.ok(dates.includes('2026-06-25'), 'the standup day itself → INCLUDED (its work is reported next)');
  assert.deepStrictEqual(dates, ['2026-06-28', '2026-06-27', '2026-06-26', '2026-06-25'], 'newest first');
  const byDate = Object.fromEntries(mems.map((m) => [m.date, m.off]));
  assert.strictEqual(byDate['2026-06-26'], false, 'Fri is a working day');
  assert.strictEqual(byDate['2026-06-27'], true, 'Sat is off');
  assert.strictEqual(byDate['2026-06-28'], true, 'Sun is off');
});

test('composeStandup uses previousDow in the header, falls back to literal yesterday', () => {
  const withDow = d.composeStandup({ name: 'Ada', date: '2026-06-29', previousDow: 'Friday', previous: [], issues: [], todayRows: [] });
  assert.ok(/^Previous Work Day - Friday$/m.test(withDow), 'header should carry the confirmed working day');
  const noDow = d.composeStandup({ name: 'Ada', date: '2026-06-29', previous: [], issues: [], todayRows: [] });
  assert.ok(/^Previous Work Day - \w+$/m.test(noDow), 'falls back to a weekday name when previousDow absent');
});
