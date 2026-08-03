'use strict';

// MT.async — shared async plumbing for views/flows. Two levels:
//
//   MT.async.seq()                       → a sequence guard (begin / isCurrent / invalidate)
//   MT.async.controller(state, {busyWhen}) → module-level state + a seq-guarded run() + isBusy()
//
// WHY: the router rebuilds #view-host on every nav, so any view holding async work or
// in-progress state in render() closures loses it. The fix pattern (see notes
// [[embedding-claude-code]] "Router rebuilds #view-host …"): keep state at MODULE level,
// drive async from module controllers, and guard every async result with a per-trigger
// sequence so an overlapping or abandoned call can't paint stale data over fresh.
//
// `seq` is the atomic guard (PM board task-fetch, Ask-Mavis chat turn — both formerly
// hand-rolled the same `++loadSeq`/`gen` counter). `controller` bundles it with a state
// object + isBusy() for a stateful flow (DailyOps generate). Views keep their own paint /
// rehydrate — that's too view-specific to share. Pure logic, no DOM → unit-testable.
(function () {
  const root = (typeof window !== 'undefined' ? window : globalThis);
  const MT = root.MT || (root.MT = {});

  // Monotonic guard: begin() a run → token; isCurrent(token) is true only while no newer
  // run (or invalidate) has happened; invalidate() drops any in-flight run without starting
  // a new one (an explicit reset/end). After an `await`, check isCurrent before mutating UI.
  function makeSeq() {
    let n = 0;
    return {
      begin() { return ++n; },
      isCurrent(token) { return token === n; },
      invalidate() { return ++n; },
      value() { return n; },
    };
  }

  // Stateful async controller: a module-level `state` object (survives the router
  // destroying the DOM on nav), a seq-guarded `run`, an `invalidate` to drop an in-flight
  // result, and isBusy() for app.js's brain-changed skip-list. run(work) resolves to
  // { ok:true, result } | { ok:false, error } | { superseded:true } (a newer run/invalidate
  // happened during the await — the caller drops it).
  function makeController(initialState, opts) {
    opts = opts || {};
    const state = Object.assign({}, initialState || {});
    const seq = makeSeq();
    const busyWhen = typeof opts.busyWhen === 'function' ? opts.busyWhen : null;
    async function run(work) {
      const token = seq.begin();
      let result, error = null;
      try { result = await (typeof work === 'function' ? work() : work); }
      catch (e) { error = e; }
      if (!seq.isCurrent(token)) return { superseded: true };
      return error ? { ok: false, error } : { ok: true, result };
    }
    return {
      state,
      run,
      invalidate() { seq.invalidate(); },
      isBusy() { return busyWhen ? !!busyWhen(state) : false; },
    };
  }

  MT.async = { seq: makeSeq, controller: makeController };
  if (typeof module !== 'undefined' && module.exports) module.exports = { makeSeq, makeController };
})();
