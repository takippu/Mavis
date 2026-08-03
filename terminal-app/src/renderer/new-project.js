'use strict';

// MT.newProject.open(onDone) — modal to create a NEW project (brain entry + optional folder / git /
// remote) or ADD EXISTING (brain entry pointing at a folder on disk). A confirm-the-plan step runs
// before any mutation (approval-before-mutations contract). onDone(result) fires after a successful
// create so the caller can refresh + open the project.
(function () {
  const MT = (window.MT = window.MT || {});
  const TYPES = ['tool', 'web-app', 'mobile-app', 'backend', 'bot', 'prospect', 'meta', 'other'];
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const icon = (n, s) => (MT.icons ? MT.icons.svg(n, s) : '');
  const slugify = (name) => String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const joinPath = (root, slug) => { if (!root || !slug) return ''; const sep = root.includes('\\') ? '\\' : '/'; return root.replace(/[\\/]+$/, '') + sep + slug; };

  let overlay = null;
  function close() { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); overlay = null; document.removeEventListener('keydown', onKey, true); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

  MT.newProject = {
    async open(onDone) {
      close();
      const root = await window.mavis.projectsRoot().catch(() => '');

      overlay = el('div', 'mt-np-overlay');
      const card = el('div', 'mt-np-card');
      overlay.appendChild(card);
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
      document.body.appendChild(overlay);
      setTimeout(() => document.addEventListener('keydown', onKey, true), 0);

      const st = {
        mode: 'new', name: '', nameEdited: false, type: 'tool', description: '', tags: '',
        path: '', pathEdited: false, createFolder: true, gitInit: true,
        remoteOn: false, provider: 'github', baseUrl: '', token: '', private: true,
      };

      // header
      const head = el('div', 'mt-np-head');
      head.appendChild(el('div', 'mt-np-title', 'New project'));
      const x = el('button', 'mt-np-x'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.innerHTML = icon('close', 16);
      x.addEventListener('click', close); head.appendChild(x);
      card.appendChild(head);

      // mode segmented control
      const seg = el('div', 'mt-seg');
      const segNew = el('button', 'mt-seg-btn active', 'New project'); segNew.type = 'button';
      const segEx = el('button', 'mt-seg-btn', 'Add existing'); segEx.type = 'button';
      seg.append(segNew, segEx); card.appendChild(seg);

      const body = el('div', 'mt-np-body'); card.appendChild(body);
      const foot = el('div', 'mt-np-foot'); card.appendChild(foot);

      const field = (label, control) => { const f = el('div', 'mt-field'); f.append(el('label', 'mt-field-label', label), control); return f; };
      const textInput = (val, ph, type) => { const i = el('input', 'mt-field-input'); i.type = type || 'text'; i.value = val || ''; if (ph) i.placeholder = ph; return i; };

      let pathInput = null, nameInput = null, slugHint = null, gitDetect = null;

      function defaultPath() { return joinPath(root, slugify(st.name)); }
      function syncSlug() {
        const s = slugify(st.name);
        if (slugHint) slugHint.textContent = s ? ('slug: ' + s) : 'enter a name to generate a slug';
        if (st.mode === 'new' && !st.pathEdited) { st.path = defaultPath(); if (pathInput) pathInput.value = st.path; }
      }
      async function detectGit() {
        if (!gitDetect) return;
        try { const has = await window.mavis.pathExists(st.path.replace(/[\\/]+$/, '') + '/.git'); gitDetect.textContent = has ? '✓ git repository detected' : ''; }
        catch { gitDetect.textContent = ''; }
      }
      function prefillNameFromFolder() {
        if (st.nameEdited || !st.path) return;
        const leaf = String(st.path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
        if (leaf) { st.name = leaf; if (nameInput) nameInput.value = leaf; syncSlug(); }
      }

      function renderForm() {
        body.innerHTML = '';
        // Name
        nameInput = textInput(st.name, st.mode === 'existing' ? '(prefilled from the folder)' : 'My Cool Project');
        nameInput.addEventListener('input', () => { st.name = nameInput.value; st.nameEdited = true; syncSlug(); });
        body.appendChild(field('Name', nameInput));
        slugHint = el('div', 'mt-np-hint', ''); body.appendChild(slugHint);

        // Type
        const type = MT.dropdown.create({ options: TYPES.map((t) => ({ value: t, label: t })), value: st.type, className: 'mt-field-input', ariaLabel: 'Type' });
        type.addEventListener('change', () => { st.type = type.value; });
        body.appendChild(field('Type', type));

        // Description
        const desc = textInput(st.description, 'One-line description');
        desc.addEventListener('input', () => { st.description = desc.value; });
        body.appendChild(field('Description', desc));

        // Tags
        const tags = textInput(st.tags, 'comma, separated, tags');
        tags.addEventListener('input', () => { st.tags = tags.value; });
        body.appendChild(field('Tags', tags));

        // Folder + Browse
        pathInput = textInput(st.path, st.mode === 'existing' ? 'Browse to an existing folder' : '<root>\\<slug>');
        pathInput.addEventListener('input', () => { st.path = pathInput.value; st.pathEdited = true; if (st.mode === 'existing') { prefillNameFromFolder(); detectGit(); } });
        const browse = el('button', 'mt-link', 'Browse…'); browse.type = 'button';
        browse.addEventListener('click', async () => {
          const r = await window.mavis.pickFolder({ create: st.mode === 'new', defaultPath: st.path || root, title: st.mode === 'existing' ? 'Choose the project folder' : 'Choose where to create the folder' }).catch(() => null);
          if (r && !r.canceled && r.path) { st.path = r.path; st.pathEdited = true; pathInput.value = r.path; if (st.mode === 'existing') { prefillNameFromFolder(); detectGit(); } }
        });
        const pathRow = el('div', 'mt-np-pathrow'); pathRow.append(pathInput, browse);
        body.appendChild(field(st.mode === 'existing' ? 'Existing folder' : 'Folder', pathRow));
        gitDetect = el('div', 'mt-np-hint', ''); body.appendChild(gitDetect);

        // New-only options
        if (st.mode === 'new') {
          const opts = el('div', 'mt-np-opts');
          const check = (label, checked, on) => {
            const w = el('label', 'mt-np-check'); const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!checked;
            i.addEventListener('change', () => on(i.checked, i)); w.append(i, el('span', null, label)); return { w, i };
          };
          opts.appendChild(check('Create the folder on disk', st.createFolder, (v) => { st.createFolder = v; }).w);
          let remoteCheck = null, remoteBox = null;
          const gi = check('Initialize git (init · .gitignore · README · first commit)', st.gitInit, (v) => { st.gitInit = v; syncRemoteEnabled(); });
          opts.appendChild(gi.w);
          remoteCheck = check('Create a remote repo + push', st.remoteOn, (v) => { st.remoteOn = v; if (remoteBox) remoteBox.style.display = v ? 'block' : 'none'; });
          opts.appendChild(remoteCheck.w);
          body.appendChild(opts);

          // remote sub-form
          remoteBox = el('div', 'mt-np-remote'); remoteBox.style.display = st.remoteOn ? 'block' : 'none';
          const prov = MT.dropdown.create({ options: [{ value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }], value: st.provider, className: 'mt-field-input', ariaLabel: 'Provider' });
          remoteBox.appendChild(field('Provider', prov));
          // The placeholder shows both shapes the field accepts: gitlab.com, or a self-hosted
          // GitLab at your own domain (example.com stands in for that — it is a reserved
          // documentation domain, so it can never point at anyone's real server).
          const baseField = field('GitLab base URL', textInput(st.baseUrl, 'https://gitlab.com  ·  or https://gitlab.example.com'));
          baseField.querySelector('input').addEventListener('input', (e) => { st.baseUrl = e.target.value; });
          baseField.style.display = st.provider === 'gitlab' ? 'block' : 'none';
          remoteBox.appendChild(baseField);
          const tok = textInput(st.token, 'Personal access token (blank = use saved)', 'password');
          tok.addEventListener('input', () => { st.token = tok.value; });
          remoteBox.appendChild(field('Token', tok));
          const tokHint = el('div', 'mt-np-hint', ''); remoteBox.appendChild(tokHint);
          remoteBox.appendChild(check('Private repository', st.private, (v) => { st.private = v; }).w);
          body.appendChild(remoteBox);

          const refreshTokenHint = async () => { try { const s = await window.mavis.gitTokenStatus(st.provider); tokHint.textContent = s && s.present ? ('saved token …' + s.maskedTail + ' (leave blank to use it)') : 'no saved token — a token you enter is remembered'; } catch { tokHint.textContent = ''; } };
          prov.addEventListener('change', () => { st.provider = prov.value; baseField.style.display = st.provider === 'gitlab' ? 'block' : 'none'; refreshTokenHint(); });
          refreshTokenHint();

          function syncRemoteEnabled() { remoteCheck.i.disabled = !st.gitInit; if (!st.gitInit) { st.remoteOn = false; remoteCheck.i.checked = false; remoteBox.style.display = 'none'; } }
          syncRemoteEnabled();
        }

        syncSlug();
        if (st.mode === 'existing' && st.path) { prefillNameFromFolder(); detectGit(); }
      }

      function buildOpts() {
        const slug = slugify(st.name);
        const o = { mode: st.mode, name: st.name, slug, type: st.type, description: st.description, tags: st.tags, path: st.path };
        if (st.mode === 'new') {
          o.createFolder = st.createFolder; o.gitInit = st.gitInit;
          if (st.remoteOn) o.remote = { provider: st.provider, baseUrl: st.baseUrl || undefined, token: st.token || undefined, private: st.private, name: slug };
        }
        return o;
      }

      function showFormFooter() {
        foot.innerHTML = '';
        const cancel = el('button', 'mt-link', 'Cancel'); cancel.addEventListener('click', close);
        const review = el('button', 'mt-pill', 'Review & create');
        const status = el('span', 'mt-np-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        review.addEventListener('click', () => doReview(status));
        foot.append(cancel, review, status);
      }

      async function doReview(status) {
        if (!slugify(st.name)) { status.textContent = 'Enter a name.'; return; }
        if (!st.path) { status.textContent = st.mode === 'existing' ? 'Pick a folder.' : 'Set a folder path.'; return; }
        status.textContent = '';
        const r = await window.mavis.planProject(buildOpts()).catch(() => null);
        if (!r || !r.ok) { status.textContent = (r && r.reason) || 'Could not build the plan.'; return; }
        body.innerHTML = '';
        body.appendChild(el('div', 'mt-np-planhead', 'This will:'));
        const plan = el('div', 'mt-np-plan');
        r.lines.forEach((l) => { const row = el('div', 'mt-np-planline'); row.append(el('span', 'mt-np-planbul', '•'), el('span', null, l)); plan.appendChild(row); });
        body.appendChild(plan);
        body.appendChild(el('div', 'mt-np-hint', 'Nothing changes until you confirm.'));
        showPlanFooter();
      }

      function showPlanFooter() {
        foot.innerHTML = '';
        const back = el('button', 'mt-link', 'Back'); back.addEventListener('click', () => { renderForm(); showFormFooter(); });
        const confirm = el('button', 'mt-pill', 'Confirm & create');
        const status = el('span', 'mt-np-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        confirm.addEventListener('click', () => doCreate(confirm, status));
        foot.append(back, confirm, status);
      }

      async function doCreate(btn, status) {
        btn.disabled = true; const label = btn.textContent; btn.textContent = 'Creating…'; status.textContent = '';
        const o = buildOpts();
        if (o.remote && o.remote.token) { try { await window.mavis.gitTokenSet(o.remote.provider, o.remote.token); } catch { /* non-fatal */ } }
        let r = null; try { r = await window.mavis.createProject(o); } catch (e) { r = { ok: false, reason: e && e.message }; }
        if (!r || !r.ok) {
          btn.disabled = false; btn.textContent = label;
          status.textContent = ((r && r.reason) || 'Create failed.') + (r && r.partial && r.partial.length ? ' (did: ' + r.partial.join(', ') + ')' : '');
          return;
        }
        if (r.pushError) {
          // repo + brain entry were created; only the push failed (auth/keys). Keep the modal so the
          // user sees it, then dismiss → refresh.
          status.className = 'mt-np-status warn';
          status.textContent = 'Created ✓ — but the remote push failed (' + r.pushError + '). Push manually.';
          btn.disabled = false; btn.textContent = 'Done';
          const close2 = () => { close(); if (typeof onDone === 'function') onDone(r); };
          btn.onclick = close2;
          return;
        }
        close();
        if (typeof onDone === 'function') onDone(r);
      }

      function setMode(m) { st.mode = m; segNew.classList.toggle('active', m === 'new'); segEx.classList.toggle('active', m === 'existing'); renderForm(); showFormFooter(); }
      segNew.addEventListener('click', () => setMode('new'));
      segEx.addEventListener('click', () => setMode('existing'));
      setMode('new');
    },
  };
})();
