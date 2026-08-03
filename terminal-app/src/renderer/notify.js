'use strict';

// MT.notify — request notifications. session-view calls complete({id,label,body,watching,kind})
// at the two moments worth a ping: a Mavis pane FINISHED a turn (kind 'done') or it's WAITING on
// you (kind 'await' — a permission / plan / menu prompt). If configured to fire (off / only when
// you're not watching that session / always) it plays a synthesized chime (Web Audio, zero asset
// files), then: while the window is focused it stays subtle (just the chime + the tab's activity
// dot, no popup over your screen); while it's backgrounded it fires a silent native Windows toast
// + taskbar flash so the ping reaches you in another window.
(function () {
  const MT = (window.MT = window.MT || {});
  const cfg = { mode: 'unwatched', sound: 'chime', volume: 60 };
  let actx = null;

  function ac() {
    try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch { actx = null; }
    return actx;
  }
  function tone(ctx, freq, start, dur, vol, type) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine'; o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
    const t0 = ctx.currentTime + start;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }
  function playChime() {
    if (cfg.sound === 'none') return;
    const ctx = ac(); if (!ctx) return;
    const v = Math.max(0, Math.min(1, (Number(cfg.volume) || 0) / 100)) * 0.4;
    if (v <= 0) return;
    try {
      if (cfg.sound === 'ping') tone(ctx, 1040, 0, 0.16, v);
      else if (cfg.sound === 'marimba') { tone(ctx, 659.25, 0, 0.5, v, 'triangle'); tone(ctx, 987.77, 0.006, 0.55, v * 0.5); }
      else { tone(ctx, 880, 0, 0.22, v); tone(ctx, 1318.5, 0.11, 0.3, v * 0.8); } // chime
    } catch { /* audio unavailable */ }
  }

  // Resolve the ACTIVE theme's colours from the live CSS vars so the toast — a separate window that
  // can't read steep.css — matches whatever theme is on. Sent with each toast payload; the toast
  // applies them, falling back to its built-in dark defaults if absent.
  function themePalette() {
    try {
      const s = getComputedStyle(document.documentElement);
      const g = (n) => (s.getPropertyValue(n) || '').trim();
      const surface = g('--color-pure-white');
      if (!surface) return null;
      return { surface, ink: g('--color-ink'), ash: g('--color-ash'), graphite: g('--color-graphite'), rust: g('--color-rust') };
    } catch { return null; }
  }

  MT.notify = {
    configure(o) {
      if (!o) return;
      if (o.mode === 'off' || o.mode === 'always' || o.mode === 'unwatched') cfg.mode = o.mode;
      if (o.sound) cfg.sound = o.sound;
      if (o.volume != null && !Number.isNaN(Number(o.volume))) cfg.volume = Number(o.volume);
    },
    test() { playChime(); },                 // preview a sound (Settings)
    complete({ id, label, body, kind, watching }) {
      if (cfg.mode === 'off') return;
      // Sound + floating toast fire TOGETHER, on exactly the same gate — only when you're NOT looking at
      // this session (alerts exist for when you're away; when you're watching the tab you already see it
      // happen). The caller (session-view) only invokes this at a real turn-end (kind 'done') or when
      // Claude pauses for you (kind 'await') — never mid-turn. `watching` folds window focus + on-the-
      // session-view + this tab being active, so switching to another in-app view still alerts you.
      if (watching) return;
      playChime();
      const title = 'Mavis' + (label ? ' · ' + label : '');
      const text = kind === 'await' ? (body || 'Waiting for your input.') : (body || 'Request complete.');
      try { window.mavis.notifyComplete({ id, title, body: text, theme: themePalette() }); } catch { /* noop */ }
    },
  };

  // Belt-and-suspenders alongside the Electron `autoplayPolicy` switch: a freshly-created
  // AudioContext is born 'suspended', and the chime fires from a setTimeout (not a gesture
  // call-stack) so resume() there can be a no-op. Unlock it on the first real user gesture —
  // xterm keystrokes bubble to window, so typing into a session unlocks audio for the session.
  if (typeof window !== 'undefined') {
    const unlock = () => {
      ac();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }
})();
