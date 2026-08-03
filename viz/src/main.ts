import cytoscape from 'cytoscape';
import { marked } from 'marked';

// HMR safety — force a full page reload on hot updates so we don't
// stack zombie cytoscape instances + duplicate wheel listeners.
const _hot = (import.meta as any).hot;
if (_hot) _hot.accept(() => location.reload());

interface BrainNode {
  data: {
    id: string;
    label: string;
    type: 'category' | 'project' | 'file';
    category: string;
    parentId?: string;
    filePath?: string;
    content?: string;
    color: string;
  };
  position?: { x: number; y: number };
}

interface BrainEdge {
  data: { id: string; source: string; target: string; kind: string };
}

interface BrainData {
  nodes: BrainNode[];
  edges: BrainEdge[];
}

(async function init() {
  const res = await fetch('/data.json');
  if (!res.ok) {
    document.body.innerHTML = `<div style="padding:2rem;color:#f7768e;font-family:monospace">
      Failed to load /data.json. Run <code>npm run build:data</code> first, or use <code>start.bat</code> / <code>start.sh</code>.
    </div>`;
    return;
  }
  const data: BrainData = await res.json();

  // Relative-date labels for daily memories — "Today", "Yesterday",
  // anything older falls back to the absolute date. Computed against
  // the user's local midnight so timezone matches naturally.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  function relativeDateLabel(dateStr: string): string {
    const fileDate = new Date(dateStr + 'T00:00:00');
    if (isNaN(fileDate.getTime())) return dateStr;
    const diffDays = Math.round((today.getTime() - fileDate.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return dateStr;
  }
  for (const n of data.nodes) {
    if (n.data.category === 'daily-memories' && n.data.type === 'file') {
      n.data.label = relativeDateLabel(n.data.label);
    }
  }

  // Build adjacency: parentId -> [childIds]
  const childrenOf = new Map<string, string[]>();
  for (const n of data.nodes) {
    if (n.data.parentId) {
      if (!childrenOf.has(n.data.parentId)) childrenOf.set(n.data.parentId, []);
      childrenOf.get(n.data.parentId)!.push(n.data.id);
    }
  }

  // Add per-edge bow offsets for cross-cutting (mentions) edges so
  // parallels don't overlap into one thick line. Cycle through values
  // so adjacent edges fan out.
  const BOW_VALUES = [-60, -30, 30, 60, -45, 45, -15, 15];
  let mentionsCount = 0;
  for (const e of data.edges) {
    if (e.data.kind === 'mentions') {
      (e.data as any).bow = BOW_VALUES[mentionsCount % BOW_VALUES.length];
      mentionsCount++;
    }
  }

  // Position categories in a circle around screen center
  const categories = data.nodes.filter((n) => n.data.type === 'category');
  const W = window.innerWidth;
  const H = window.innerHeight;
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(W, H) * 0.32;
  categories.forEach((cat, i) => {
    const angle = (i / categories.length) * Math.PI * 2 - Math.PI / 2;
    cat.position = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });

  // Strip parentId from cytoscape data (we don't want compound nesting)
  // Keep it on the original `data.nodes` array for our own logic
  const cyNodes = data.nodes.map((n) => ({
    data: { ...n.data },
    position: n.position,
    classes: n.data.type === 'category' ? '' : 'hidden',
  }));
  const cyEdges = data.edges.map((e) => ({
    data: { ...e.data },
    classes: 'hidden',
  }));

  const cyInst = cytoscape({
    container: document.getElementById('cy')!,
    elements: [...cyNodes, ...cyEdges],
    layout: { name: 'preset', fit: true, padding: 80 } as any,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          color: '#c0caf5',
          'font-family': 'JetBrains Mono, Cascadia Code, Consolas, monospace',
          'text-valign': 'bottom',
          'text-margin-y': 8,
          'background-color': 'data(color)',
          'border-width': 0,
          'transition-property': 'background-color, border-color, opacity, width, height',
          'transition-duration': 200,
        } as any,
      },
      {
        selector: 'node[type="category"]',
        style: {
          width: 44,
          height: 44,
          'font-size': '15px',
          'font-weight': 'bold',
          'text-margin-y': 12,
          'border-width': 3,
          'border-color': 'data(color)',
          'border-opacity': 0.4,
          'background-opacity': 0.95,
        } as any,
      },
      {
        selector: 'node[type="category"].expanded',
        style: {
          'border-opacity': 1,
          'border-color': '#f7768e',
          'border-width': 4,
        } as any,
      },
      {
        selector: 'node[type="project"]',
        style: {
          width: 26,
          height: 26,
          'font-size': '12px',
          'font-weight': 'bold',
          'text-margin-y': 8,
          'border-width': 2,
          'border-color': 'data(color)',
          'border-opacity': 0.4,
          'background-opacity': 0.9,
        } as any,
      },
      {
        selector: 'node[type="project"].expanded',
        style: {
          'border-opacity': 1,
          'border-color': '#f7768e',
        } as any,
      },
      {
        selector: 'node[type="file"]',
        style: {
          width: 14,
          height: 14,
          'font-size': '10px',
          'text-margin-y': 6,
        } as any,
      },
      {
        selector: 'edge',
        style: {
          width: 1.4,
          'line-color': '#7aa2f7',
          opacity: 0.45,
          'curve-style': 'bezier',
          'target-arrow-shape': 'none',
        } as any,
      },
      {
        // Structural edges (parent -> child, drawn during expand)
        selector: 'edge[kind="structural"]',
        style: {
          'line-color': 'data(color)',
          opacity: 0.5,
          width: 1,
          'line-style': 'solid',
        } as any,
      },
      {
        // Cross-cutting edges (daily -> project, frontmatter mentions)
        selector: 'edge[kind="mentions"]',
        style: {
          'line-color': '#bb9af7',
          opacity: 0.28,
          width: 1.3,
          'line-style': 'dashed',
          'curve-style': 'unbundled-bezier',
          'control-point-distances': 'data(bow)',
          'control-point-weights': '0.5',
        } as any,
      },
      {
        selector: '.hidden',
        style: { display: 'none' } as any,
      },
      {
        // Faded state — applied to non-focused elements on hover
        selector: '.faded',
        style: { opacity: 0.07 } as any,
      },
      {
        // Default-hidden mentions edges (revealed on hover)
        selector: '.edge-default-hidden',
        style: { display: 'none' } as any,
      },
      {
        // Search pulse — flashed briefly on a node when selected from search
        selector: '.search-pulse',
        style: {
          'border-width': 6,
          'border-color': '#f7768e',
          'border-opacity': 1,
        } as any,
      },
      {
        // Highlighted state — applied to focused node + its neighborhood
        selector: '.focus',
        style: { 'opacity': 1, 'z-index': 99 } as any,
      },
      {
        selector: 'node:active',
        style: { 'overlay-opacity': 0.15, 'overlay-color': '#f7768e' } as any,
      },
    ],
    wheelSensitivity: 0.35,
    minZoom: 0.05,
    maxZoom: 3,
  });

  // Expose for the save handler (which lives outside this closure)
  (window as any).__cy = cyInst;

  // Stop wheel events on panel + legend from reaching cytoscape (they
  // were causing zoom to fire while user was just scrolling content
  // inside the panel, and making panel scroll feel janky).
  const panelEl = document.getElementById('panel')!;
  const legendEl = document.getElementById('legend')!;
  for (const el of [panelEl, legendEl]) {
    el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  // Categories are NOT locked at init — they start unlocked so you can
  // drag them anytime. The cose layout briefly locks them during a
  // run (to anchor it) and unlocks immediately after.

  // Add structural edges programmatically (parent -> child)
  // Hidden by default; revealed when both endpoints visible
  const structuralEdges: { data: any; classes?: string }[] = [];
  for (const n of data.nodes) {
    if (n.data.parentId) {
      structuralEdges.push({
        data: {
          id: `struct:${n.data.parentId}->${n.data.id}`,
          source: n.data.parentId,
          target: n.data.id,
          kind: 'structural',
          color: n.data.color,
        },
        classes: 'hidden',
      });
    }
  }
  cyInst.add(structuralEdges);

  // ---- Visibility state ----
  const visibleSet = new Set<string>(categories.map((c) => c.data.id));
  const expandedSet = new Set<string>();

  function applyVisibility() {
    cyInst.batch(() => {
      cyInst.nodes().forEach((node: any) => {
        node.toggleClass('hidden', !visibleSet.has(node.id()));
      });
      cyInst.edges().forEach((edge: any) => {
        const sv = visibleSet.has(edge.source().id());
        const tv = visibleSet.has(edge.target().id());
        edge.toggleClass('hidden', !(sv && tv));
      });
      cyInst.nodes().forEach((node: any) => {
        node.toggleClass('expanded', expandedSet.has(node.id()));
      });
      // Default-hide cross-cutting mentions edges. They reveal on
      // node hover via the mouseover handler below.
      cyInst.edges('[kind="mentions"]').addClass('edge-default-hidden');
    });
  }

  // Place a parent's visible children in a perfect circle around it.
  // No force layout — pure radial geometry, deterministic.
  function placeChildrenRadially(parentId: string) {
    const parent = cyInst.getElementById(parentId);
    const ppos = parent.position();
    const childIds = (childrenOf.get(parentId) ?? []).filter((id) => visibleSet.has(id));
    if (childIds.length === 0) return;

    const ringRadius = parent.data('type') === 'category' ? 240 : 150;

    childIds.forEach((cid, i) => {
      const node = cyInst.getElementById(cid);
      // If child is unpositioned (first appearance), snap to parent so
      // it visually "bursts out" from the parent during animation.
      const cur = node.position();
      if (!cur || (cur.x === 0 && cur.y === 0)) {
        node.position({ x: ppos.x, y: ppos.y });
      }
      const angle = (i / childIds.length) * Math.PI * 2 - Math.PI / 2;
      node.animate({
        position: {
          x: ppos.x + ringRadius * Math.cos(angle),
          y: ppos.y + ringRadius * Math.sin(angle),
        },
        duration: 500,
        easing: 'ease-out-quart',
      });
    });
  }

  // Re-place all expanded parents' children radially. Iterate
  // shallow-to-deep so deeper layers see the freshly-positioned
  // parents above them.
  function runLayout() {
    const order: Record<string, number> = { category: 0, project: 1, file: 2 };
    const sorted = Array.from(expandedSet).sort((a, b) => {
      const at = cyInst.getElementById(a).data('type');
      const bt = cyInst.getElementById(b).data('type');
      return (order[at] ?? 99) - (order[bt] ?? 99);
    });
    for (const id of sorted) placeChildrenRadially(id);

    // After the position animation completes, fit camera to visible
    setTimeout(() => {
      cyInst.animate({
        fit: { eles: cyInst.elements().not('.hidden'), padding: 70 },
        duration: 450,
        easing: 'ease-out-quart',
      } as any);
    }, 520);
  }

  function expandNode(id: string) {
    if (expandedSet.has(id)) return;
    const childIds = childrenOf.get(id) ?? [];
    if (childIds.length === 0) return;

    expandedSet.add(id);
    childIds.forEach((cid) => visibleSet.add(cid));
    applyVisibility();
    runLayout();
  }

  function collapseNode(id: string) {
    if (!expandedSet.has(id)) return;
    expandedSet.delete(id);

    function recurseHide(nodeId: string) {
      const kids = childrenOf.get(nodeId) ?? [];
      for (const kid of kids) {
        if (visibleSet.has(kid)) {
          visibleSet.delete(kid);
          expandedSet.delete(kid);
          recurseHide(kid);
        }
      }
    }
    recurseHide(id);

    applyVisibility();
    runLayout();
  }

  applyVisibility();

  cyInst.on('tap', 'node', (evt: any) => {
    const node = evt.target;
    const id = node.id();
    const type = node.data('type');
    const hasChildren = (childrenOf.get(id)?.length ?? 0) > 0;

    if (hasChildren) {
      if (expandedSet.has(id)) collapseNode(id);
      else expandNode(id);
    } else if (type === 'file') {
      showDetail(node.data(), node);
    }
  });

  cyInst.on('tap', (evt: any) => {
    if (evt.target === cyInst) closePanel();
  });

  // Hover focus — dim everything except the hovered node + its
  // immediate neighborhood. Also reveal this node's mentions edges
  // (which are default-hidden to keep the graph clean at rest).
  cyInst.on('mouseover', 'node', (evt: any) => {
    const node = evt.target;
    if (node.hasClass('hidden')) return;
    const visible = cyInst.elements().not('.hidden');
    const neighborhood = node.closedNeighborhood().not('.hidden');
    visible.not(neighborhood).addClass('faded');
    neighborhood.addClass('focus');
    // Reveal this node's cross-cutting mentions edges
    node.connectedEdges('[kind="mentions"]').removeClass('edge-default-hidden');
  });
  cyInst.on('mouseout', 'node', () => {
    cyInst.elements().removeClass('faded').removeClass('focus');
    // Re-hide all cross-cutting mentions edges
    cyInst.edges('[kind="mentions"]').addClass('edge-default-hidden');
  });

  // Reset button — collapse everything back to the 5 categories
  document.getElementById('reset-btn')?.addEventListener('click', () => {
    expandedSet.clear();
    visibleSet.clear();
    for (const c of categories) visibleSet.add(c.data.id);
    applyVisibility();
    cyInst.fit(undefined, 80);
  });

  // Re-run layout button — useful after manual drag, or if cose
  // settled into a poor local minimum
  document.getElementById('relayout-btn')?.addEventListener('click', () => {
    runLayout();
  });

  // Re-fit on window resize (categories stay in their absolute positions, but viewport adapts)
  let resizeTimer: any;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => cyInst.fit(undefined, 80), 200);
  });

  // ===== Search =====
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const searchResults = document.getElementById('search-results') as HTMLElement;
  let activeIdx = -1;

  function fuzzyScore(needle: string, hay: string): number {
    const n = needle.toLowerCase();
    const h = hay.toLowerCase();
    if (h === n) return 1000;
    if (h.startsWith(n)) return 600;
    if (h.includes(n)) return 400 - h.indexOf(n);
    let ni = 0;
    for (let hi = 0; hi < h.length && ni < n.length; hi++) {
      if (h[hi] === n[ni]) ni++;
    }
    return ni === n.length ? Math.max(50, 200 - h.length) : 0;
  }

  function performSearch(query: string) {
    if (!query.trim()) {
      searchResults.classList.add('empty');
      searchResults.innerHTML = '';
      activeIdx = -1;
      return;
    }
    const matches = data.nodes
      .map((n) => {
        const lblScore = fuzzyScore(query, n.data.label);
        const pathScore = n.data.filePath ? fuzzyScore(query, n.data.filePath) : 0;
        return { node: n, score: Math.max(lblScore, pathScore) };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (matches.length === 0) {
      searchResults.innerHTML = '<div class="search-result-empty">no matches</div>';
      searchResults.classList.remove('empty');
      activeIdx = -1;
      return;
    }
    searchResults.innerHTML = matches
      .map(
        (m, i) => `
      <div class="search-result ${i === 0 ? 'active' : ''}" data-id="${m.node.data.id}">
        <span class="search-result-dot" style="background:${m.node.data.color}"></span>
        <span class="search-result-label">${m.node.data.label}</span>
        <span class="search-result-type">${m.node.data.type}</span>
      </div>`
      )
      .join('');
    searchResults.classList.remove('empty');
    activeIdx = 0;
  }

  // Walk up parentId chain to find all ancestors
  function ancestorsOf(id: string): string[] {
    const out: string[] = [];
    let current = id;
    while (true) {
      const n = data.nodes.find((nn) => nn.data.id === current);
      if (!n?.data.parentId) break;
      out.unshift(n.data.parentId);
      current = n.data.parentId;
    }
    return out;
  }

  function selectResult(id: string) {
    const node = data.nodes.find((n) => n.data.id === id);
    if (!node) return;

    // Expand all ancestors so the target node is visible
    for (const aid of ancestorsOf(id)) {
      if (!expandedSet.has(aid)) expandNode(aid);
    }

    // Wait for the radial-placement animation to settle before
    // centering on the target
    setTimeout(() => {
      const cyNode = cyInst.getElementById(id);
      if (cyNode.length === 0) return;
      cyInst.animate(
        {
          center: { eles: cyNode },
          zoom: 1,
          duration: 450,
          easing: 'ease-out-quart',
        } as any
      );
      (cyNode as any).flashClass('search-pulse', 1500);
      if (node.data.type === 'file') showDetail(node.data, cyNode);
    }, 580);

    searchInput.value = '';
    searchResults.innerHTML = '';
    searchResults.classList.add('empty');
    searchInput.blur();
  }

  searchInput.addEventListener('input', () => performSearch(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    const items = searchResults.querySelectorAll('.search-result') as NodeListOf<HTMLElement>;
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchResults.innerHTML = '';
      searchResults.classList.add('empty');
      searchInput.blur();
    } else if (e.key === 'Enter') {
      const active = items[activeIdx];
      if (active?.dataset.id) selectResult(active.dataset.id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (items.length === 0) return;
      e.preventDefault();
      items[activeIdx]?.classList.remove('active');
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[activeIdx]?.classList.add('active');
      items[activeIdx]?.scrollIntoView({ block: 'nearest' });
    }
  });

  searchResults.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('.search-result') as HTMLElement | null;
    if (t?.dataset.id) selectResult(t.dataset.id);
  });

  // Cmd/Ctrl + K → focus search
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Stop wheel propagation on search so cytoscape doesn't zoom while
  // user scrolls the results list
  document.getElementById('search')!.addEventListener('wheel', (e) => e.stopPropagation(), {
    passive: true,
  });
})();

// Currently-open node reference (so save can update its in-memory content)
let activeNode: any = null;

function showDetail(d: any, node?: any) {
  activeNode = node ?? null;
  const panel = document.getElementById('panel')!;
  (panel.querySelector('.panel-title') as HTMLElement).textContent = d.label ?? '';
  (panel.querySelector('.panel-path') as HTMLElement).textContent = d.filePath ?? '';
  renderView(d.content ?? '');
  setEditMode(false);
  hideStatus();
  panel.classList.add('open');
  panel.scrollTop = 0;
}

function renderView(content: string) {
  const body = document.querySelector('#panel .panel-body') as HTMLElement;
  body.innerHTML = marked.parse(content || '_(empty)_') as string;
}

function setEditMode(editing: boolean) {
  const body = document.querySelector('#panel .panel-body') as HTMLElement;
  const editor = document.querySelector('#panel .panel-editor') as HTMLTextAreaElement;
  const editBtn = document.getElementById('panel-edit')!;
  const saveBtn = document.getElementById('panel-save')!;
  const cancelBtn = document.getElementById('panel-cancel')!;

  if (editing) {
    body.hidden = true;
    editor.hidden = false;
    editBtn.hidden = true;
    saveBtn.hidden = false;
    cancelBtn.hidden = false;
    editor.focus();
  } else {
    body.hidden = false;
    editor.hidden = true;
    editBtn.hidden = false;
    saveBtn.hidden = true;
    cancelBtn.hidden = true;
  }
}

function showStatus(msg: string, kind: 'success' | 'error' = 'success') {
  const el = document.querySelector('#panel .panel-status') as HTMLElement;
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

function hideStatus() {
  const el = document.querySelector('#panel .panel-status') as HTMLElement;
  el.hidden = true;
}

function closePanel() {
  document.getElementById('panel')!.classList.remove('open');
  setEditMode(false);
  activeNode = null;
}

document.getElementById('panel-close')?.addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanel();
});

document.getElementById('panel-edit')?.addEventListener('click', () => {
  if (!activeNode) return;
  const editor = document.querySelector('#panel .panel-editor') as HTMLTextAreaElement;
  editor.value = activeNode.data('content') ?? '';
  setEditMode(true);
});

document.getElementById('panel-cancel')?.addEventListener('click', () => {
  setEditMode(false);
});

// Client-side frontmatter parser (mirrors the server one) — used after
// save to refresh outgoing mentions edges from a daily-memory node
// without a full re-parse round-trip.
function parseFrontmatterClient(content: string): Record<string, any> | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const result: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^(\w+):\s*(.*)$/);
    if (!k) continue;
    let v: any = k[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v
        .slice(1, -1)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
    result[k[1]] = v;
  }
  return result;
}

const SAVE_BOW_VALUES = [-60, -30, 30, 60, -45, 45, -15, 15];

document.getElementById('panel-save')?.addEventListener('click', async () => {
  if (!activeNode) return;
  const editor = document.querySelector('#panel .panel-editor') as HTMLTextAreaElement;
  const filePath = activeNode.data('filePath');
  const content = editor.value;
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, content }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error ?? 'unknown');
    // Update in-memory content so subsequent views show the new content
    activeNode.data('content', content);
    renderView(content);
    setEditMode(false);

    // Live-refresh outgoing mentions edges from this node, if it's a
    // daily memory whose frontmatter projects: array might have changed.
    const sourceId = activeNode.id();
    if (sourceId.startsWith('file:daily-memories/')) {
      const cy = (window as any).__cy;
      if (cy) {
        const fm = parseFrontmatterClient(content);
        const newProjects: string[] = Array.isArray(fm?.projects) ? fm!.projects : [];
        // Remove existing outgoing mentions edges from this source
        cy.edges('[kind="mentions"]')
          .filter((e: any) => e.source().id() === sourceId)
          .remove();
        // Add edges for each project in the new frontmatter (only if
        // the project node actually exists)
        let added = 0;
        newProjects.forEach((projectName, i) => {
          const targetId = `project:${projectName}`;
          if (cy.getElementById(targetId).length === 0) return;
          cy.add({
            group: 'edges',
            data: {
              id: `${sourceId}->${targetId}:mentions`,
              source: sourceId,
              target: targetId,
              kind: 'mentions',
              bow: SAVE_BOW_VALUES[i % SAVE_BOW_VALUES.length],
            },
            classes: 'edge-default-hidden',
          });
          added++;
        });
        showStatus(`saved · ${filePath} · ${added} project edge${added === 1 ? '' : 's'}`);
        return;
      }
    }
    showStatus(`saved · ${filePath}`);
  } catch (err: any) {
    showStatus(`save failed: ${err.message}`, 'error');
  }
});
