'use strict';
(() => {
  const MT = window.MT;
  const assetRoot = new URL('assets/lead-hunter/', document.currentScript.src);
  function create(container, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 224; canvas.className = 'lh-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Pixel Office by 2dPig. Five people and two pets roam and rest. Click Discover, Validate or Enrich to open their menus.');
    const anchor = document.createElement('div'); anchor.className = 'lh-agent-anchor';
    const agent = document.createElement('button'); agent.type = 'button'; agent.className = 'lh-agent'; agent.id = 'lh-discover-agent';
    agent.setAttribute('aria-label', 'Discover agent: open goals and filters'); agent.setAttribute('aria-haspopup', 'dialog'); agent.setAttribute('aria-controls', 'lh-agent-menu');
    const label = document.createElement('span'); label.className = 'lh-agent-label';
    const dot = document.createElement('i'); dot.className = 'lh-agent-dot'; dot.setAttribute('aria-hidden', 'true');
    label.append(dot, document.createTextNode('Discover')); agent.append(label); anchor.append(agent); container.append(canvas, anchor);
    const validateAnchor = document.createElement('div'); validateAnchor.className = 'lh-agent-anchor';
    const validator = document.createElement('button'); validator.type = 'button'; validator.className = 'lh-agent lh-validator'; validator.id = 'lh-validate-agent';
    validator.setAttribute('aria-label', 'Validate agent: open goals and filters'); validator.setAttribute('aria-haspopup', 'dialog'); validator.setAttribute('aria-controls', 'lh-agent-menu');
    validator.innerHTML = '<span class="lh-agent-label"><i class="lh-agent-dot" aria-hidden="true"></i>Validate</span>';
    validateAnchor.append(validator); container.append(validateAnchor);
    let validateRunning = false, validateMenuOpen = false, validateHovering = false;
    validator.onclick = () => options.onValidate?.();
    validator.onpointerenter = () => { validateHovering = true; }; validator.onpointerleave = () => { validateHovering = false; };

    const enrichAnchor = document.createElement('div'); enrichAnchor.className = 'lh-agent-anchor';
    const enricher = document.createElement('button'); enricher.type = 'button'; enricher.className = 'lh-agent lh-enricher'; enricher.id = 'lh-enrich-agent';
    enricher.setAttribute('aria-label', 'Enrich agent: open goals and field groups'); enricher.setAttribute('aria-haspopup', 'dialog'); enricher.setAttribute('aria-controls', 'lh-agent-menu');
    enricher.innerHTML = '<span class="lh-agent-label"><i class="lh-agent-dot" aria-hidden="true"></i>Enrich</span>';
    enrichAnchor.append(enricher); container.append(enrichAnchor);
    let enrichRunning = false, enrichMenuOpen = false, enrichHovering = false;
    enricher.onclick = () => options.onEnrich?.();
    enricher.onpointerenter = () => { enrichHovering = true; }; enricher.onpointerleave = () => { enrichHovering = false; };

    const ctx = canvas.getContext('2d'), cleanOffice = document.createElement('canvas'); cleanOffice.width = 256; cleanOffice.height = 224;
    const cleanCtx = cleanOffice.getContext('2d'), officeImage = new Image(), atlasImage = new Image(), floorImage = new Image();
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let ready = false, destroyed = false, visible = true, motionPaused = false, menuOpen = false, hovering = false;
    let clock = 0, previous = 0, frameId = null, running = false, state = 'ready';
    const home = { x: 48.5, y: 188 }, actor = { ...home, state: 'resting', route: [], wait: 4 + Math.random() * 3, facing: 1 };
    const pets = [
      { sx: 65, sy: 129, w: 13, h: 13, x: 143.5, y: 212, minX: 124, maxX: 143.5, minY: 212, maxY: 215, wait: 3 + Math.random() * 4 },
      { sx: 59, sy: 146, w: 24, h: 11, x: 104, y: 219, minX: 104, maxX: 130, minY: 219, maxY: 222, wait: 5 + Math.random() * 6 }
    ].map(p => ({ ...p, homeX: p.x, homeY: p.y, route: [], state: 'resting', facing: 1 }));
    const coworkers = [
      { sx: 2, sy: 105, w: 15, h: 23, ox: 70, oy: 101, x: 77.5, y: 124, facing: -1, wait: .6, path: [{ x: 77.5, y: 129 }, { x: 110, y: 129 }] },
      { sx: 19, sy: 104, w: 19, h: 24, ox: 222, oy: 135, x: 231.5, y: 159, facing: 1, wait: 1.2, path: [{ x: 246, y: 159 }, { x: 246, y: 185 }] },
      { sx: 3, sy: 132, w: 17, h: 23, ox: 108, oy: 169, x: 116.5, y: 192, facing: 1, wait: 1.8, path: [{ x: 116.5, y: 158 }, { x: 125, y: 158 }] },
      { sx: 22, sy: 132, w: 17, h: 23, ox: 129, oy: 169, x: 137.5, y: 192, facing: -1, wait: 2.4, path: [{ x: 137.5, y: 158 }, { x: 137.5, y: 128 }, { x: 165, y: 128 }] }
    ].map(c => ({ ...c, homeX: c.x, homeY: c.y, route: [], state: 'resting', away: false }));
    const isHome = () => Math.abs(actor.x - home.x) < .1 && Math.abs(actor.y - home.y) < .1;
    const canMove = () => ready && !destroyed && !motionPaused && visible && !document.hidden && !motion.matches;
    function floorPatch(x, y, w, h) { cleanCtx.drawImage(floorImage, x, y - 112, w, h, x, y, w, h); }
    function prepareScenery() {
      if (destroyed || ![officeImage, atlasImage, floorImage].every(i => i.complete && i.naturalWidth)) return;
      cleanCtx.imageSmoothingEnabled = false; cleanCtx.drawImage(officeImage, 0, 0);
      // Original material restores sprite positions; preserve the artist's furniture and monitor alignment.
      cleanCtx.drawImage(officeImage, 42, 197, 13, 21, 42, 167, 13, 21);
      floorPatch(92, 208, 24, 11); floorPatch(137, 199, 13, 13);
      cleanCtx.drawImage(officeImage, 160, 199, 5, 11, 145, 199, 5, 11);
      floorPatch(70, 112, 15, 12); cleanCtx.drawImage(officeImage, 86, 101, 1, 11, 70, 101, 15, 11);
      floorPatch(222, 135, 19, 24); cleanCtx.drawImage(officeImage, 108, 135, 4, 15, 222, 135, 4, 15);
      floorPatch(108, 169, 17, 23); cleanCtx.drawImage(officeImage, 108, 139, 4, 11, 108, 169, 4, 11);
      floorPatch(129, 169, 17, 23); cleanCtx.drawImage(officeImage, 145, 139, 1, 11, 145, 169, 1, 11);
      ready = true; syncMotion();
    }
    function overlaps(a, b, padding = 1) {
      const aw = a.w || 13, ah = a.h || 21, bw = b.w || 13, bh = b.h || 21;
      return a.x - aw / 2 < b.x + bw / 2 + padding && a.x + aw / 2 > b.x - bw / 2 - padding && a.y - ah < b.y + padding && a.y > b.y - bh - padding;
    }
    function advance(entity, dt, speed) {
      if (!entity.route.length) return;
      const p = entity.route[0], dx = p.x - entity.x, dy = p.y - entity.y, distance = Math.hypot(dx, dy), step = speed * dt;
      if (Math.abs(dx) > .1) entity.facing = dx < 0 ? -1 : 1;
      if (distance <= step) { entity.x = p.x; entity.y = p.y; entity.route.shift(); }
      else { entity.x += dx / distance * step; entity.y += dy / distance * step; }
    }
    function returnToDesk() {
      actor.route = [];
      if (!canMove()) { actor.x = home.x; actor.y = home.y; actor.state = 'working'; return; }
      if (actor.x < 32) { if (Math.abs(actor.y - 188) > .1) actor.route.push({ x: 20, y: 188 }); actor.route.push({ ...home }); }
      else if (!isHome()) actor.route.push({ x: 20, y: actor.y }, { x: 20, y: 188 }, { ...home });
      actor.state = actor.route.length ? 'returning' : 'working'; actor.wait = 0;
    }
    function updateMotion(dt) {
      clock += dt;
      if (running) { if (actor.route.length) advance(actor, dt, 58); actor.state = actor.route.length ? 'returning' : 'working'; }
      else if (!menuOpen && !hovering && !agent.matches(':focus-visible')) {
        if (actor.route.length) { advance(actor, dt, 19); if (!actor.route.length) { actor.state = 'resting'; actor.wait = 4 + Math.random() * 7; } }
        else { actor.state = 'resting'; actor.wait -= dt; if (actor.wait <= 0) { actor.route = isHome() ? (Math.random() > .3 ? [{ x: 20, y: 188 }, { x: 20, y: 129 }, { x: 48.5, y: 129 }] : [{ x: 20, y: 188 }, { x: 20, y: 217 }]) : [{ x: 20, y: actor.y }, { x: 20, y: 188 }, { ...home }]; actor.state = 'roaming'; } }
      }
      for (const c of coworkers) {
        if (c === coworkers[0] && validateRunning) { if (c.route.length) advance(c, dt, 40); c.state = c.route.length ? 'returning' : 'working'; continue; }
        if (c === coworkers[0] && (validateMenuOpen || validateHovering || validator.matches(':focus-visible'))) continue;
        if (c === coworkers[1] && enrichRunning) { if (c.route.length) advance(c, dt, 40); c.state = c.route.length ? 'returning' : 'working'; continue; }
        if (c === coworkers[1] && (enrichMenuOpen || enrichHovering || enricher.matches(':focus-visible'))) continue;
        if (c.route.length) {
          c.state = 'roaming'; const before = { x: c.x, y: c.y, route: c.route.map(p => ({ ...p })) }; advance(c, dt, 15);
          if ([actor, ...coworkers, ...pets].some(other => other !== c && overlaps(c, other))) Object.assign(c, before);
          if (!c.route.length) { c.state = 'resting'; c.wait = 3 + Math.random() * 5; }
        } else { c.state = 'resting'; c.wait -= dt; if (c.wait <= 0) { c.route = c.away ? [...c.path.slice(0, -1).reverse().map(p => ({ ...p })), { x: c.homeX, y: c.homeY }] : c.path.map(p => ({ ...p })); c.away = !c.away; c.state = 'roaming'; } }
      }
      for (const pet of pets) {
        const other = pets.find(p => p !== pet);
        if (pet.route.length) {
          const before = { x: pet.x, y: pet.y }; advance(pet, dt, 7);
          if (Math.hypot(pet.x - other.x, pet.y - other.y) < 22 || [actor, ...coworkers].some(person => overlaps(pet, person))) { Object.assign(pet, before); pet.route = []; pet.wait = 2; pet.state = 'resting'; continue; }
          pet.state = 'wandering'; if (!pet.route.length) { pet.state = 'resting'; pet.wait = 4 + Math.random() * 9; }
        } else { pet.wait -= dt; if (pet.wait <= 0) { const x = pet.minX + Math.random() * (pet.maxX - pet.minX), y = pet.minY + Math.random() * (pet.maxY - pet.minY); if (Math.hypot(x - other.x, y - other.y) > 22) pet.route = [{ x, y }]; else pet.wait = 3; } }
      }
    }
    function sprite(sx, sy, w, h, x, y, facing, walking) {
      const bob = walking ? Math.floor(clock * 6) % 2 : 0;
      ctx.save(); ctx.translate(Math.round(x), Math.round(y)); if (facing < 0) ctx.scale(-1, 1);
      ctx.drawImage(atlasImage, sx, sy, w, h, -Math.floor(w / 2), -h - bob, w, h); ctx.restore();
    }
    function draw(t = performance.now()) {
      if (!ready || destroyed) return;
      const reduced = motion.matches;
      ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, 256, 224); ctx.drawImage(cleanOffice, 0, 0);
      for (const c of coworkers) {
        if (reduced || (Math.abs(c.x - c.homeX) < .1 && Math.abs(c.y - c.homeY) < .1)) ctx.drawImage(officeImage, c.ox, c.oy, c.w, c.h, c.ox, c.oy, c.w, c.h);
        else sprite(c.sx, c.sy, c.w, c.h, c.x, c.y, c.facing, c.route.length > 0 && canMove());
      }
      for (const pet of pets) sprite(pet.sx, pet.sy, pet.w, pet.h, reduced ? pet.homeX : pet.x, reduced ? pet.homeY : pet.y, pet.facing, pet.route.length > 0 && canMove());
      if (isHome() || reduced) ctx.drawImage(officeImage, 42, 167, 13, 21, 42, 167, 13, 21);
      else sprite(40, 107, 13, 21, actor.x, actor.y, actor.facing, actor.route.length > 0 && canMove());
      if (running && canMove() && isHome()) {
        const step = Math.floor(t / 180) % 4;
        ctx.fillStyle = '#173b5a'; ctx.fillRect(55, 166, 7, 8); ctx.fillStyle = '#76e2cc'; ctx.fillRect(56, 168, 4, 1); ctx.fillRect(56, 170, 2 + step, 1); ctx.fillStyle = step < 2 ? '#a9efff' : '#277ba3'; ctx.fillRect(60, 172, 1, 1);
      }
      anchor.style.transform = reduced ? 'translate(0,0)' : 'translate(' + ((actor.x - home.x) / 256 * 100) + '%,' + ((actor.y - home.y) / 224 * 100) + '%)';
      agent.dataset.motion = reduced ? 'resting' : actor.state;
      const v = coworkers[0];
      validateAnchor.style.transform = reduced ? 'translate(0,0)' : 'translate(' + ((v.x - v.homeX) / 256 * 100) + '%,' + ((v.y - v.homeY) / 224 * 100) + '%)';
      validator.dataset.motion = reduced ? 'resting' : v.state;
      const e = coworkers[1];
      enrichAnchor.style.transform = reduced ? 'translate(0,0)' : 'translate(' + ((e.x - e.homeX) / 256 * 100) + '%,' + ((e.y - e.homeY) / 224 * 100) + '%)';
      enricher.dataset.motion = reduced ? 'resting' : e.state;

    }
    function frame(t) {
      frameId = null;
      if (!canMove()) { previous = 0; return; }
      if (!previous || t - previous >= 80) { const dt = previous ? Math.min((t - previous) / 1000, .15) : 0; previous = t; updateMotion(dt); draw(t); }
      frameId = requestAnimationFrame(frame);
    }
    function syncMotion() {
      if (destroyed) return;
      if (frameId !== null) { cancelAnimationFrame(frameId); frameId = null; }
      previous = 0;
      if (running && !canMove()) { actor.x = home.x; actor.y = home.y; actor.route = []; actor.state = 'working'; }
      if (validateRunning && !canMove()) { const v = coworkers[0]; v.x = v.homeX; v.y = v.homeY; v.route = []; v.state = 'working'; }
      if (enrichRunning && !canMove()) { const e = coworkers[1]; e.x = e.homeX; e.y = e.homeY; e.route = []; e.state = 'working'; }
      draw(); if (canMove()) frameId = requestAnimationFrame(frame);
    }
    function update(snapshot) {
      const allJobs = snapshot?.jobs || [], jobs = allJobs.filter(j => !j.kind || j.kind === 'discover'), job = jobs.find(j => j.status === 'running');
      const validationJobs = allJobs.filter(j => j.kind === 'validate'), validationJob = validationJobs.find(j => j.status === 'running');
      updateValidate(!!validationJob && !snapshot.paused && !snapshot.error);
      const validationState = snapshot.error ? 'stopped' : snapshot.paused ? 'paused' : validationJob ? 'running' : validationJobs.find(j => ['waiting', 'paused', 'failed'].includes(j.status))?.status || 'ready';
      validator.dataset.state = validationState; validator.setAttribute('aria-label', 'Validate agent: ' + validationState + '. Open goals and filters');
      const enrichJobs = allJobs.filter(j => j.kind === 'enrich'), enrichJob = enrichJobs.find(j => j.status === 'running');
      updateEnrich(!!enrichJob && !snapshot.paused && !snapshot.error);
      const enrichState = snapshot.error ? 'stopped' : snapshot.paused ? 'paused' : enrichJob ? 'running' : enrichJobs.find(j => ['waiting', 'paused', 'failed'].includes(j.status))?.status || 'ready';
      enricher.dataset.state = enrichState; enricher.setAttribute('aria-label', 'Enrich agent: ' + enrichState + '. Open goals and field groups');
      const next = !!job && !snapshot.paused && !snapshot.error;
      state = snapshot.error ? 'stopped' : snapshot.paused ? 'paused' : job ? 'running' : jobs.find(j => ['waiting', 'paused', 'failed'].includes(j.status))?.status || 'ready';
      container.classList.toggle('lh-working', next); agent.dataset.state = state;
      agent.setAttribute('aria-label', 'Discover agent: ' + state + '. Open goals and filters');
      if (next && !running) { running = next; returnToDesk(); } else running = next;
      syncMotion();
    }
    agent.onclick = () => options.onDiscover?.();
    agent.onpointerenter = () => { hovering = true; }; agent.onpointerleave = () => { hovering = false; };
    document.addEventListener('visibilitychange', syncMotion); motion.addEventListener('change', syncMotion);
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; syncMotion(); }, { threshold: .08 }); observer.observe(canvas);
    for (const image of [officeImage, atlasImage, floorImage]) { image.onload = prepareScenery; image.onerror = () => { if (!destroyed) { canvas.setAttribute('aria-label', 'Office artwork could not load. Use Discover to open goals and filters.'); options.onError?.('The office artwork could not load. Discover controls are still available.'); } }; }
    officeImage.src = new URL('PixelOffice.png', assetRoot).href; atlasImage.src = new URL('PixelOfficeAssets.png', assetRoot).href; floorImage.src = new URL('floor-layer.png', assetRoot).href;
    function updateValidate(value) {
        const next = !!value;
        if (next && !validateRunning) { const v = coworkers[0]; v.route = [];
          if (Math.abs(v.x-v.homeX) > .1 || Math.abs(v.y-v.homeY) > .1) v.route = [{ x: v.x, y: 129 }, { x: v.homeX, y: 129 }, { x: v.homeX, y: v.homeY }];
          v.away = false; v.wait = 4; v.state = v.route.length ? 'returning' : 'working';
        }
        validateRunning = next; validator.dataset.state = next ? 'running' : 'ready'; validator.setAttribute('aria-label', 'Validate agent: ' + (next ? 'working' : 'ready') + '. Open goals and filters'); syncMotion();
    }
    function updateEnrich(value) {
        const next = !!value;
        if (next && !enrichRunning) { const e = coworkers[1]; e.route = [];
          if (Math.abs(e.x-e.homeX) > .1 || Math.abs(e.y-e.homeY) > .1) e.route = [{ x: 246, y: e.y }, { x: 246, y: e.homeY }, { x: e.homeX, y: e.homeY }];
          e.away = false; e.wait = 4; e.state = e.route.length ? 'returning' : 'working';
        }
        enrichRunning = next; enricher.dataset.state = next ? 'running' : 'ready'; enricher.setAttribute('aria-label', 'Enrich agent: ' + (next ? 'working' : 'ready') + '. Open goals and field groups'); syncMotion();
      }
    return {
      update, agent, validator, enricher,
      setEnrichMenuOpen(value) { enrichMenuOpen = !!value; },
      setValidateMenuOpen(value) { validateMenuOpen = !!value; },
      setMenuOpen(value) { menuOpen = !!value; },
      setMotionPaused(value) { motionPaused = !!value; syncMotion(); },
      destroy() { destroyed = true; if (frameId !== null) cancelAnimationFrame(frameId); observer.disconnect(); document.removeEventListener('visibilitychange', syncMotion); motion.removeEventListener('change', syncMotion); for (const image of [officeImage, atlasImage, floorImage]) image.onload = image.onerror = null; }
    };
  }
  MT.leadHunterOffice = { create };
})();
