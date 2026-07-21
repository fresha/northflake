/**
 * Query Plan tab: an interactive top-down tree of the operator DAG.
 *
 * The DAG is already reconstructed by profileParser.js — every operator carries
 * `parentUids` (Snowflake edges run child → parent) and the profile exposes
 * `roots` (operators with no parents, e.g. Result / CreateTableAsSelect). Here we
 * invert that into a children map, lay it out, and render it on a pan/zoom canvas.
 *
 * v1 is deliberately lean (layout + viewport + click-for-detail). Seams are left
 * for minimap / search / pruning / slowest-panel, mirroring NorthStar's visualizer.
 */
import { formatRows, formatPct, formatBytes } from './utils.js';
import { familyOf, metricChips, primaryDetail, fullAttributes, h, htmlEl, escapeHTML } from './operatorView.js';

// Insight thresholds — when an operator's stats cross these, it gets a badge.
// Tuned against the sample profiles; see docs/internal/PLAN-roadmap.md.
const SPILL_MIN_BYTES = 10e6;   // ≥10 MB spilled to disk
const PRUNE_FRAC = 0.9;         // scanned ≥90% of partitions (and >1 partition)
const CACHE_MAX_FRAC = 0.25;    // <25% served from cache …
const CACHE_MIN_BYTES = 1e9;    // … on a scan reading >1 GB

const ISSUE_LABELS = { spill: 'spill', prune: 'poor pruning', cache: 'low cache' };

/** Performance issues flagged on an operator, as {kind, title} for badges/tooltips. */
function nodeIssues(op) {
  const issues = [];
  const spill = op.spilledLocal + op.spilledRemote;
  if (spill >= SPILL_MIN_BYTES) {
    issues.push({ kind: 'spill', title: `Spilled ${formatBytes(spill)} to disk` });
  }
  if (op.partitionsTotal > 1 && (op.partitionsScanned || 0) / op.partitionsTotal >= PRUNE_FRAC) {
    issues.push({ kind: 'prune', title: `Scanned ${op.partitionsScanned}/${op.partitionsTotal} partitions — little pruning` });
  }
  if (op.cacheFraction != null && op.bytesScanned > CACHE_MIN_BYTES && op.cacheFraction < CACHE_MAX_FRAC) {
    issues.push({ kind: 'cache', title: `${formatPct(op.cacheFraction, 0)} cache hit on ${formatBytes(op.bytesScanned)} scanned` });
  }
  return issues;
}

// Layout geometry
const NODE_W = 150;
const NODE_H = 54;
const H_GAP = 28;    // perpendicular gap between siblings
const V_GAP = 46;    // flow gap between levels
const ROOT_GAP = 80; // gap between independent root trees (separate steps)

// Viewport limits
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

// Minimap geometry (must match the CSS box size)
const MINIMAP_W = 180;
const MINIMAP_H = 120;
const MINIMAP_PAD = 6;

// Module state (reset on each render)
let canvasEl = null;
let zoomEl = null;
let detailEl = null;
let slowestPanelEl = null;
let slowestBtnEl = null;
let nodePositions = null;   // uid → {x, y}, for fly-to navigation
let camera = { x: 0, y: 0, zoom: 1 };
let contentSize = { width: 0, height: 0 };
let dragMoved = false;

// Navigation chrome
let minimapEl = null;
let minimapViewportEl = null;
let minimapScale = 0;
let zoomIndicatorEl = null;
let zoomIndicatorTimeout = null;

// Filter state
let planProfile = null;     // current profile (for selector lookups)
let childrenMap = null;     // uid → [childUid] (for descendant lineage)
let searchInputEl = null;
let summaryEl = null;
let filterHideMode = false; // dim (default) vs hide non-matches
let searchKeyBound = false;  // bind the "/" hotkey only once
let helpDismissBound = false; // bind the help-card outside-click only once

// Pruning / collapse state
let rootSet = null;          // Set of root uids (protected from pruning)
let sourceUids = null;       // Set of leaf/source uids (protected from pruning)
let currentHeat = null;      // cached heat context (re-used across re-renders)
let rankedOps = [];          // slowest ranking (for re-applying highlights)
let minRowThreshold = 0;     // hide operators below this output-row count
let hiddenTypes = new Set(); // operator families hidden via checkboxes
let pruningPanelEl = null;
let pruningBtnEl = null;

/* ============================================================
   Public API
   ============================================================ */

export function renderPlan(profile, container) {
  container.innerHTML = '';
  camera = { x: 0, y: 0, zoom: 1 };

  planProfile = profile;
  childrenMap = buildChildrenMap(profile);
  filterHideMode = false;
  minRowThreshold = 0;
  hiddenTypes = new Set();
  rootSet = new Set(profile.roots);
  // Sources = operators nothing feeds into (leaves of our top-down tree, e.g.
  // TableScans). Protected from pruning so the plan keeps its skeleton.
  sourceUids = new Set(profile.operators.filter(op => !childrenMap.get(op.uid)?.length).map(op => op.uid));

  // Time-heat is normalized per step: overall_percentage in the CSV is per-step,
  // so a single-operator step (e.g. step-1 CREATE TABLE = 100%) must NOT read as hot.
  currentHeat = buildHeatContext(profile);
  rankedOps = rankOperators(profile, currentHeat);

  // DOM scaffold: canvas → zoom-container (populated by renderTree)
  canvasEl = h('div', 'plan-canvas');
  zoomEl = h('div', 'zoom-container');
  canvasEl.append(zoomEl);

  const toolbar = buildToolbar(rankedOps.length > 0);
  detailEl = h('aside', 'plan-detail');
  detailEl.style.display = 'none';
  slowestPanelEl = buildSlowestPanel(rankedOps);
  pruningPanelEl = buildPruningPanel(profile);

  // Which insight kinds actually occur in this profile (drives the legend key).
  const presentIssues = new Set();
  for (const op of profile.operators) for (const { kind } of nodeIssues(op)) presentIssues.add(kind);

  canvasEl.append(
    buildSearchBar(), pruningPanelEl, toolbar, buildLegend(presentIssues), slowestPanelEl,
    buildZoomIndicator(), buildMinimap(), detailEl,
  );
  container.append(canvasEl);

  renderTree();

  setupViewport();
  bindSearchHotkey();
  // Tab panel may be hidden at first render (0×0) — fitToView no-ops then and
  // refreshPlanView() re-fits once the tab is shown.
  requestAnimationFrame(() => requestAnimationFrame(() => fitToView(false)));
}

/**
 * (Re)build the tree view — edges, nodes, minimap — from the current pruning
 * state. Called on first render and whenever the pruning controls change.
 */
function renderTree() {
  const pruned = computePruned();
  const { childMap, edges } = contract(pruned);

  const { positions, width, height } = layout(planProfile.roots, childMap);
  contentSize = { width, height };
  nodePositions = positions;

  // Rebuild edges + nodes inside the zoom container.
  zoomEl.innerHTML = '';
  zoomEl.append(buildEdges(edges, positions));
  for (const op of planProfile.operators) {
    const pos = positions.get(op.uid);
    if (pos) zoomEl.append(buildNode(op, pos, currentHeat));
  }

  // Re-apply slowest highlights to whichever of the top-5 are still visible.
  rankedOps.slice(0, 5).forEach((op, i) => {
    document.getElementById(`plan-node-${op.uid}`)
      ?.classList.add(i === 0 ? 'slowest-top1' : 'slowest-top5');
  });

  rebuildMinimap();

  // Keep an active filter applied across re-renders (nodes were recreated).
  if (searchInputEl?.value.trim()) applyFilter(filterHideMode ? `${searchInputEl.value.trim()} --hide` : searchInputEl.value.trim());
}

/** Re-fit when the Plan tab becomes visible (its panel was display:none at render). */
export function refreshPlanView() {
  if (!canvasEl) return;
  requestAnimationFrame(() => fitToView(false));
}

/* ============================================================
   Graph → layout
   ============================================================ */

/** Invert parentUids into a children map: parentUid → [childUid, …] (in op order). */
function buildChildrenMap(profile) {
  const children = new Map();
  for (const op of profile.operators) {
    for (const puid of op.parentUids) {
      if (!children.has(puid)) children.set(puid, []);
      children.get(puid).push(op.uid);
    }
  }
  return children;
}

/* ---- pruning: which operators to hide, and how to reconnect around them ---- */

/** The set of operator uids hidden by the current pruning controls. */
function computePruned() {
  const pruned = new Set();
  if (minRowThreshold <= 0 && hiddenTypes.size === 0) return pruned;
  for (const op of planProfile.operators) {
    if (rootSet.has(op.uid) || sourceUids.has(op.uid)) continue; // protect skeleton
    const typeHidden = hiddenTypes.has(familyOf(op.type));
    const volumePruned = minRowThreshold > 0 && op.outputRows != null && op.outputRows < minRowThreshold;
    if (typeHidden || volumePruned) pruned.add(op.uid);
  }
  return pruned;
}

/** Nearest visible descendants reachable through a chain of pruned nodes. */
function nearestVisible(uid, pruned) {
  const out = [];
  const seen = new Set();
  const stack = [...(childrenMap.get(uid) || [])];
  while (stack.length) {
    const x = stack.pop();
    if (seen.has(x)) continue;
    seen.add(x);
    if (!pruned.has(x)) out.push(x);
    else stack.push(...(childrenMap.get(x) || []));
  }
  return out;
}

/**
 * Contract the graph over visible nodes: a visible parent connects directly to
 * its visible children, or — across any pruned nodes — to their nearest visible
 * descendants (those edges are marked dashed). Returns a plain child map for the
 * layout plus the edge list (with dashed + row volume) for rendering.
 */
function contract(pruned) {
  const childMap = new Map();
  const edges = [];
  for (const op of planProfile.operators) {
    if (pruned.has(op.uid)) continue;
    const seen = new Set();
    for (const c of childrenMap.get(op.uid) || []) {
      const targets = pruned.has(c) ? nearestVisible(c, pruned).map(d => [d, true]) : [[c, false]];
      for (const [d, dashed] of targets) {
        if (seen.has(d)) continue;
        seen.add(d);
        edges.push({ from: op.uid, to: d, dashed, rows: planProfile.byId.get(d)?.outputRows });
      }
    }
    childMap.set(op.uid, [...seen]);
  }
  return { childMap, edges };
}

/**
 * Top-down layout. Each root tree is laid out independently and offset to the
 * right of the previous one. Shared CTE nodes (≤2 parents) are placed under the
 * first parent that reaches them; the other parent just draws an edge.
 */
function layout(rootUids, children) {
  const sizes = new Map();   // uid → subtree perpendicular (x) size
  const positions = new Map();

  const visited = new Set(); // for size pass (place-once)
  const placed = new Set();  // for position pass (place-once)

  // Largest trees first so the main step is leftmost.
  const roots = [...rootUids].sort(
    (a, b) => subtreeSize(b, children, sizes, new Set()) - subtreeSize(a, children, sizes, new Set())
  );
  sizes.clear();

  let xOffset = 0;
  let maxY = 0;
  for (const root of roots) {
    const w = subtreeSize(root, children, sizes, visited);
    maxY = Math.max(maxY, assignPositions(root, 0, xOffset, children, sizes, positions, placed));
    xOffset += w + ROOT_GAP;
  }

  return { positions, width: Math.max(0, xOffset - ROOT_GAP), height: maxY };
}

/** Perpendicular (x) size of a subtree; counts each node once via `visited`. */
function subtreeSize(uid, children, sizes, visited) {
  if (visited.has(uid)) return 0; // placed under another parent
  visited.add(uid);

  const kids = children.get(uid) || [];
  let total = 0, count = 0;
  for (const c of kids) {
    const s = subtreeSize(c, children, sizes, visited);
    if (s > 0) { total += s; count++; }
  }
  if (count > 1) total += (count - 1) * H_GAP;

  const size = Math.max(NODE_W, total);
  sizes.set(uid, size);
  return size;
}

/** Assign (x, y) to each node; returns the deepest y reached (for content height). */
function assignPositions(uid, y, x, children, sizes, positions, placed) {
  if (placed.has(uid)) return y;
  placed.add(uid);

  const size = sizes.get(uid) ?? NODE_W;
  positions.set(uid, { x: x + (size - NODE_W) / 2, y });
  let maxY = y + NODE_H;

  let childX = x;
  for (const c of children.get(uid) || []) {
    if (placed.has(c)) continue;        // shared node already placed elsewhere
    const cs = sizes.get(c) ?? 0;
    if (cs <= 0) continue;
    const reached = assignPositions(c, y + NODE_H + V_GAP, childX, children, sizes, positions, placed);
    maxY = Math.max(maxY, reached);
    childX += cs + H_GAP;
  }
  return maxY;
}

/* ============================================================
   Rendering: edges + nodes
   ============================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build the edge SVG from the contracted edge list. Each edge is parent → child
 * (data flows UP the tree); width scales with the child's output rows. Edges
 * that bridge pruned nodes are drawn dashed.
 */
function buildEdges(edges, positions) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('plan-edges');
  svg.setAttribute('width', contentSize.width);
  svg.setAttribute('height', contentSize.height);

  // Two passes so labels always sit above every edge.
  const labels = [];

  for (const edge of edges) {
    const from = positions.get(edge.to);    // child (lower)
    const to = positions.get(edge.from);     // parent (upper)
    if (!from || !to) continue;
    const rows = edge.rows;
    const sx = to.x + NODE_W / 2, sy = to.y + NODE_H;
    const ex = from.x + NODE_W / 2, ey = from.y;
    const dy = (ey - sy) * 0.45;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${sx} ${sy} C ${sx} ${sy + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`);
    path.setAttribute('stroke-width', edgeWidth(rows).toFixed(1));
    path.classList.add('plan-edge');
    if (edge.dashed) path.classList.add('plan-edge-dashed');
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;
    svg.append(path);

    // Label every edge with a known volume, including 0 — an explicit "0"
    // (e.g. a Filter dropping every row → an empty branch) is more
    // informative than a blank edge.
    if (rows != null) {
      labels.push({ x: (sx + ex) / 2, y: (sy + ey) / 2, text: formatRows(rows), from: edge.from, to: edge.to });
    }
  }

  for (const lb of labels) {
    const w = lb.text.length * 7 + 12;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', lb.x - w / 2);
    rect.setAttribute('y', lb.y - 9);
    rect.setAttribute('width', w);
    rect.setAttribute('height', 18);
    rect.setAttribute('rx', 4);
    rect.classList.add('plan-edge-label-bg');
    rect.dataset.from = lb.from;
    rect.dataset.to = lb.to;

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', lb.x);
    text.setAttribute('y', lb.y + 4);
    text.setAttribute('text-anchor', 'middle');
    text.classList.add('plan-edge-label');
    text.dataset.from = lb.from;
    text.dataset.to = lb.to;
    text.textContent = lb.text;

    svg.append(rect, text);
  }

  return svg;
}

/** Edge stroke width from row volume — log10 scale (ported from NorthStar). */
function edgeWidth(rows) {
  const MIN = 1.5, MAX = 8;
  if (!rows || rows <= 0) return MIN;
  const normalized = Math.min(Math.log10(Math.max(1, rows)) / 7, 1); // 1 row→0 … 10M→1
  return MIN + (MAX - MIN) * normalized;
}

/**
 * Per-step time-heat context: the max timePct within each step, and how many
 * operators that step has. Heat is meaningful only when a step has ≥2 timed ops.
 */
function buildHeatContext(profile) {
  const maxByStep = new Map();
  const countByStep = new Map();
  for (const op of profile.operators) {
    if (op.timePct == null) continue;
    countByStep.set(op.stepId, (countByStep.get(op.stepId) || 0) + 1);
    maxByStep.set(op.stepId, Math.max(maxByStep.get(op.stepId) || 0, op.timePct));
  }
  return { maxByStep, countByStep };
}

/** 0..1 heat for a node, or 0 when its step isn't meaningfully heat-able. */
function heatOf(op, heat) {
  if (op.timePct == null || (heat.countByStep.get(op.stepId) || 0) < 2) return 0;
  const max = heat.maxByStep.get(op.stepId) || 0;
  return max > 0 ? op.timePct / max : 0;
}

function buildNode(op, pos, heat) {
  const fam = familyOf(op.type);
  const node = h('div', `plan-node fam-${fam}`);
  node.id = `plan-node-${op.uid}`;
  node.style.left = `${pos.x}px`;
  node.style.top = `${pos.y}px`;
  node.style.width = `${NODE_W}px`;
  node.style.height = `${NODE_H}px`;

  // Time-heat tint: warmer = larger share of its step's time.
  const heatVal = heatOf(op, heat);
  if (heatVal > 0) {
    node.style.background = `color-mix(in srgb, var(--danger) ${Math.round(heatVal * 45)}%, var(--bg-primary))`;
  }

  const head = h('div', 'plan-node-head');
  head.append(h('span', 'plan-node-type', [op.type]));
  const issues = nodeIssues(op);
  if (issues.length) {
    const badges = h('div', 'plan-node-badges');
    for (const { kind, title } of issues) {
      const dot = h('span', `plan-badge badge-${kind}`);
      dot.title = title;
      badges.append(dot);
    }
    head.append(badges);
  }
  head.append(h('span', 'plan-node-id', [`op${op.id}`]));
  node.append(head);

  // No in-node row counts: the edge labels already carry every operator's
  // input (incoming edge) and output (outgoing edge), so "X → Y" in the node is
  // redundant — and for multi-input ops (joins) a summed input is misleading.
  if (op.timePct != null && op.timePct > 0) {
    node.append(h('span', 'plan-node-time', [formatPct(op.timePct)]));
  }

  node.addEventListener('click', e => {
    e.stopPropagation();
    openDetail(op, node);
  });
  return node;
}

/* ============================================================
   Detail panel
   ============================================================ */

function openDetail(op, node) {
  document.querySelectorAll('.plan-node.selected').forEach(n => n.classList.remove('selected'));
  node.classList.add('selected');

  const fam = familyOf(op.type);
  detailEl.innerHTML = '';

  const head = h('div', 'plan-detail-head');
  head.append(
    h('span', `op-badge fam-${fam}`, [op.type]),
    h('span', 'op-id', [`op${op.id}`]),
  );
  if (op.timePct != null && op.timePct > 0) head.append(h('span', 'op-time', [formatPct(op.timePct)]));
  const close = h('button', 'plan-detail-close', ['×']);
  close.addEventListener('click', closeDetail);
  head.append(close);
  detailEl.append(head);

  const primary = primaryDetail(op);
  if (primary) detailEl.append(htmlEl('div', 'op-detail', primary));

  const chips = metricChips(op);
  if (chips.length) {
    const m = h('div', 'op-metrics');
    for (const mc of chips) {
      m.append(h('span', `op-metric ${mc.cls || ''}`, [
        h('span', 'op-metric-label', [mc.label]),
        h('span', 'op-metric-value', [mc.value]),
      ]));
    }
    detailEl.append(m);
  }

  const attrs = fullAttributes(op);
  if (attrs.length) {
    const body = h('div', 'plan-detail-attrs');
    for (const [k, v] of attrs) {
      body.append(h('div', 'op-attr', [
        h('div', 'op-attr-key', [k]),
        htmlEl('div', 'op-attr-val', escapeHTML(v)),
      ]));
    }
    detailEl.append(body);
  }

  detailEl.style.display = 'block';
}

function closeDetail() {
  if (detailEl) detailEl.style.display = 'none';
  document.querySelectorAll('.plan-node.selected').forEach(n => n.classList.remove('selected'));
}

/* ============================================================
   Search / filter
   ============================================================ */

function buildSearchBar() {
  const bar = h('div', 'plan-search');
  searchInputEl = document.createElement('input');
  searchInputEl.type = 'text';
  searchInputEl.className = 'plan-search-input';
  searchInputEl.placeholder = 'filter nodes…';
  searchInputEl.autocomplete = 'off';
  searchInputEl.spellcheck = false;

  const modeBtn = h('button', 'plan-search-mode', ['dim']);
  modeBtn.title = 'Toggle dim / hide for non-matching nodes';
  const clearBtn = h('button', 'plan-search-clear', ['×']);
  clearBtn.title = 'Clear (Esc)';
  summaryEl = h('span', 'plan-search-summary');
  summaryEl.style.display = 'none';

  const apply = () => {
    const q = searchInputEl.value.trim();
    if (!q) { clearFilter(); return; }
    const matched = applyFilter(filterHideMode ? `${q} --hide` : q);
    if (matched && matched.size) fitToNodes(matched);
  };

  searchInputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); searchInputEl.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); clearFilter(); searchInputEl.blur(); }
  });
  modeBtn.addEventListener('click', () => {
    filterHideMode = !filterHideMode;
    modeBtn.textContent = filterHideMode ? 'hide' : 'dim';
    modeBtn.classList.toggle('active', filterHideMode);
    if (searchInputEl.value.trim()) apply();
  });
  clearBtn.addEventListener('click', () => clearFilter());

  bar.append(buildSearchHelp(), searchInputEl, clearBtn, modeBtn, summaryEl);
  bindHelpDismiss();
  return bar;
}

/** The "?" help affordance + a syntax card. Content matches our actual DSL. */
function buildSearchHelp() {
  const wrap = h('div', 'plan-search-help-wrap');
  const btn = h('button', 'plan-search-help', ['?']);
  btn.title = 'Filter syntax';

  const card = h('div', 'plan-search-card');
  const section = t => h('div', 'plan-card-section', [t]);
  const row = (code, desc) => h('div', 'plan-card-row', [
    h('code', 'plan-card-code', [code]),
    h('span', 'plan-card-desc', [desc]),
  ]);

  card.append(
    section('Selectors'),
    row('node=5', 'a single operator (by op id)'),
    row('+node=5', 'that node + its ancestors (toward the root)'),
    row('node=5+', 'that node + its descendants (toward the scans)'),
    row('+node=5+', 'that node + its full lineage'),
    row('type=scan', 'by family: scan · join · filter · aggregate · sort · set · dml — or any operator-type substring'),
    row('table=orders', 'scans whose table name contains the text'),
    section('Operators'),
    row('&', 'AND — intersection (binds tighter)'),
    row(',', 'OR — union'),
    section('Examples'),
    row('node=5+ & type=scan', 'scans downstream of operator 5'),
    row('type=scan, type=join', 'every scan or join'),
    row('+node=2 & type=filter', 'filters between op 2 and the root'),
  );

  const keys = h('div', 'plan-card-keys');
  keys.append(
    h('kbd', null, ['Enter']), h('span', 'plan-card-desc', ['apply']),
    h('kbd', null, ['Esc']), h('span', 'plan-card-desc', ['clear']),
    h('kbd', null, ['/']), h('span', 'plan-card-desc', ['focus']),
  );
  card.append(keys);
  card.append(h('div', 'plan-card-note', [
    'Matches get an accent ring and the camera fits to them; an edge shows only when both ends match. ',
    'The dim / hide button fades vs removes the non-matching nodes.',
  ]));

  btn.addEventListener('click', e => { e.stopPropagation(); card.classList.toggle('open'); });
  wrap.append(btn, card);
  return wrap;
}

/** Close any open help card when clicking outside it (bound once). */
function bindHelpDismiss() {
  if (helpDismissBound) return;
  helpDismissBound = true;
  document.addEventListener('click', e => {
    if (e.target.closest('.plan-search-help-wrap')) return;
    document.querySelectorAll('.plan-search-card.open').forEach(c => c.classList.remove('open'));
  });
}

/** Focus the filter input with "/" while the Plan tab is visible. */
function bindSearchHotkey() {
  if (searchKeyBound) return;
  searchKeyBound = true;
  window.addEventListener('keydown', e => {
    if (e.key !== '/' || !searchInputEl) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (!canvasEl || !canvasEl.offsetParent) return; // tab hidden
    e.preventDefault();
    searchInputEl.focus();
    searchInputEl.select();
  });
}

/* ---- query parsing (syntax mirrors NorthStar) ---- */

function parseSelector(part) {
  let m;
  if ((m = part.match(/^type=(.+)$/i))) return { selectorType: 'type', value: m[1].trim().toLowerCase() };
  if ((m = part.match(/^table=(.+)$/i))) return { selectorType: 'table', value: m[1].trim().toLowerCase() };
  if ((m = part.match(/^(\+)?node=(\d+)(\+)?$/i))) {
    return { selectorType: 'node', nodeId: parseInt(m[2], 10), upstream: !!m[1], downstream: !!m[3] };
  }
  return null;
}

function parseFilterQuery(query) {
  if (!query || !query.trim()) return { orGroups: [], hideMode: false };
  let hideMode = false;
  if (query.includes('--hide')) { hideMode = true; query = query.replace(/--hide/g, '').trim(); }

  const orGroups = [];
  for (const orPart of query.split(/\s*(?:,|\bor\b)\s*/i).filter(Boolean)) {
    const group = { nodeSelectors: [], typeFilters: [], tableFilters: [] };
    for (const part of orPart.split(/\s*(?:&|\band\b)\s*/i).filter(Boolean)) {
      const sel = parseSelector(part.trim());
      if (!sel) continue;
      if (sel.selectorType === 'node') group.nodeSelectors.push(sel);
      else if (sel.selectorType === 'type') group.typeFilters.push(sel.value);
      else group.tableFilters.push(sel.value);
    }
    if (group.nodeSelectors.length || group.typeFilters.length || group.tableFilters.length) orGroups.push(group);
  }
  return { orGroups, hideMode };
}

/* ---- lineage + selector resolution ---- */

function ancestors(uid, acc = new Set()) {
  const op = planProfile.byId.get(uid);
  if (op) for (const p of op.parentUids) if (!acc.has(p)) { acc.add(p); ancestors(p, acc); }
  return acc;
}
function descendants(uid, acc = new Set()) {
  for (const c of childrenMap.get(uid) || []) if (!acc.has(c)) { acc.add(c); descendants(c, acc); }
  return acc;
}

function nodesForSelector(sel) {
  const set = new Set();
  for (const op of planProfile.operators) {
    if (op.id !== sel.nodeId) continue;
    set.add(op.uid);
    if (sel.upstream) for (const a of ancestors(op.uid)) set.add(a);
    if (sel.downstream) for (const d of descendants(op.uid)) set.add(d);
  }
  return set;
}
function nodesForType(value) {
  const set = new Set();
  for (const op of planProfile.operators) {
    if (familyOf(op.type) === value || op.type.toLowerCase().includes(value)) set.add(op.uid);
  }
  return set;
}
function nodesForTable(value) {
  const set = new Set();
  for (const op of planProfile.operators) {
    const t = op.attributes?.table_name;
    if (t && String(t).toLowerCase().includes(value)) set.add(op.uid);
  }
  return set;
}
function intersect(a, b) {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

/* ---- apply / clear ---- */

function applyFilter(query) {
  if (!planProfile || !canvasEl) return null;
  const spec = parseFilterQuery(query);
  if (spec.orGroups.length === 0) { resetFilterVisuals(); updateFilterSummary(null); return null; }

  const matched = new Set();
  for (const g of spec.orGroups) {
    let groupSet = null;
    const consider = s => { groupSet = groupSet === null ? s : intersect(groupSet, s); };
    for (const sel of g.nodeSelectors) consider(nodesForSelector(sel));
    for (const t of g.typeFilters) consider(nodesForType(t));
    for (const tb of g.tableFilters) consider(nodesForTable(tb));
    if (groupSet) for (const u of groupSet) matched.add(u);
  }

  const dimCls = spec.hideMode ? 'filter-hidden' : 'filter-dimmed';
  for (const op of planProfile.operators) {
    const el = document.getElementById(`plan-node-${op.uid}`);
    if (!el) continue;
    el.classList.remove('filter-dimmed', 'filter-hidden', 'filter-match');
    el.classList.add(matched.has(op.uid) ? 'filter-match' : dimCls);
  }
  // An edge/label is kept only when BOTH endpoints match.
  canvasEl.querySelectorAll('.plan-edge, .plan-edge-label, .plan-edge-label-bg').forEach(el => {
    el.classList.remove('filter-dimmed', 'filter-hidden');
    if (!(matched.has(el.dataset.from) && matched.has(el.dataset.to))) el.classList.add(dimCls);
  });

  updateFilterSummary(matched);
  return matched;
}

function resetFilterVisuals() {
  canvasEl?.querySelectorAll('.plan-node').forEach(n => n.classList.remove('filter-dimmed', 'filter-hidden', 'filter-match'));
  canvasEl?.querySelectorAll('.plan-edge, .plan-edge-label, .plan-edge-label-bg')
    .forEach(el => el.classList.remove('filter-dimmed', 'filter-hidden'));
}

function clearFilter() {
  resetFilterVisuals();
  updateFilterSummary(null);
  if (searchInputEl) searchInputEl.value = '';
}

function updateFilterSummary(matched) {
  if (!summaryEl) return;
  if (!matched || matched.size === 0) { summaryEl.style.display = 'none'; return; }
  summaryEl.textContent = `${matched.size} node${matched.size !== 1 ? 's' : ''}`;
  summaryEl.style.display = '';
}

/** Fit the camera to a set of nodes (used to zoom to filter matches). */
function fitToNodes(uids) {
  if (!canvasEl || !uids || !uids.size) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const u of uids) {
    const p = nodePositions.get(u);
    if (!p) continue;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
  }
  if (minX === Infinity) return;
  const rect = canvasEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const cw = maxX - minX, ch = maxY - minY, pad = 60;
  const scale = Math.min((rect.width - pad * 2) / cw, (rect.height - pad * 2) / ch, 2);
  camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
  camera.x = (minX + cw / 2) - (rect.width / camera.zoom) / 2;
  camera.y = (minY + ch / 2) - (rect.height / camera.zoom) / 2;
  clampCameraToBounds();
  updateTransform(true);
}

/* ============================================================
   Toolbar + viewport
   ============================================================ */

// Toolbar icons — same set as NorthStar's plan visualizer.
const ICONS = {
  zoomIn: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/></svg>',
  zoomOut: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 8a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 8z"/></svg>',
  fit: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4A1.5 1.5 0 0 1 1.5 0h4a.5.5 0 0 1 0 1h-4zM10 .5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 16 1.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zM.5 10a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 0 14.5v-4a.5.5 0 0 1 .5-.5zm15 0a.5.5 0 0 1 .5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5z"/></svg>',
  slowest: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 11a1 1 0 1 1 2 0v4a1 1 0 1 1-2 0v-4zm6-6a1 1 0 1 1 2 0v10a1 1 0 1 1-2 0V5zM7 7a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V7zm-6 4a1 1 0 1 1 2 0v4a1 1 0 1 1-2 0v-4z"/></svg>',
  prune: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5A.5.5 0 0 1 2 1h12a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.128.334L10 8.692V13.5a.5.5 0 0 1-.342.474l-3 1A.5.5 0 0 1 6 14.5V8.692L1.628 3.834A.5.5 0 0 1 1.5 3.5v-2z"/></svg>',
};

function buildToolbar(hasSlowest) {
  const bar = h('div', 'plan-toolbar');
  const mk = (icon, title, fn) => {
    const b = htmlEl('button', 'plan-tool-btn', icon);
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(
    mk(ICONS.zoomIn, 'Zoom in', () => zoomToCenter(ZOOM_STEP)),
    mk(ICONS.zoomOut, 'Zoom out', () => zoomToCenter(1 / ZOOM_STEP)),
    mk(ICONS.fit, 'Fit to view', () => fitToView(true)),
  );
  pruningBtnEl = mk(ICONS.prune, 'Prune & collapse', togglePruning);
  bar.append(pruningBtnEl);
  if (hasSlowest) {
    slowestBtnEl = mk(ICONS.slowest, 'Toggle slowest operators panel', toggleSlowest);
    slowestBtnEl.classList.add('active'); // panel open by default
    bar.append(slowestBtnEl);
  }
  return bar;
}

/**
 * Bottom-left legend: an issues key (only the insight kinds present in this
 * profile) plus the cool→hot time-heat scale.
 */
function buildLegend(presentIssues) {
  const legend = h('div', 'plan-legend');

  if (presentIssues.size) {
    const issues = h('div', 'plan-legend-issues');
    for (const kind of ['spill', 'prune', 'cache']) {
      if (!presentIssues.has(kind)) continue;
      issues.append(h('span', 'plan-legend-item', [
        h('span', `plan-badge badge-${kind}`),
        h('span', 'plan-legend-text', [ISSUE_LABELS[kind]]),
      ]));
    }
    legend.append(issues);
  }

  const heat = h('div', 'plan-legend-heat');
  heat.append(
    h('span', 'plan-heat-label', ['cool']),
    h('span', 'plan-heat-bar'),
    h('span', 'plan-heat-label', ['hot']),
    h('span', 'plan-heat-caption', ['time / step']),
  );
  heat.title = 'Node shading: share of its plan step’s execution time';
  legend.append(heat);
  return legend;
}

/* ============================================================
   Slowest operators
   ============================================================ */

/**
 * Rank operators by execution-time share, descending. timePct is per-step, so
 * we only rank operators whose step has ≥2 timed operators (reusing the heat
 * context) — this drops trivial single-operator steps like step-1 CREATE TABLE
 * that would otherwise sit at a misleading 100%.
 */
function rankOperators(profile, heat, limit = 10) {
  return profile.operators
    .filter(op => op.timePct != null && (heat.countByStep.get(op.stepId) || 0) >= 2)
    .sort((a, b) => b.timePct - a.timePct)
    .slice(0, limit);
}

function buildSlowestPanel(ranked) {
  const panel = h('div', 'plan-slowest');
  const head = h('div', 'plan-slowest-head');
  head.append(h('span', 'plan-slowest-title', ['Slowest operators']));
  const close = h('button', 'plan-slowest-close', ['×']);
  close.title = 'Hide panel';
  close.addEventListener('click', toggleSlowest);
  head.append(close);
  panel.append(head);

  if (ranked.length === 0) {
    panel.append(h('div', 'plan-slowest-empty', ['No timing data.']));
    return panel;
  }

  const max = ranked[0].timePct || 1;
  const list = h('div', 'plan-slowest-list');
  ranked.forEach((op, i) => {
    const row = h('div', 'plan-slowest-row');
    const rankCls = i === 0 ? 'top1' : i < 5 ? 'top5' : '';
    const fill = h('div', 'plan-slowest-bar-fill');
    fill.style.width = `${Math.round((op.timePct / max) * 100)}%`;
    const bar = h('div', 'plan-slowest-bar', [fill]);
    const name = h('span', 'plan-slowest-name', [op.type]);
    name.title = op.type;
    row.append(
      h('span', `plan-slowest-rank ${rankCls}`, [`#${i + 1}`]),
      name,
      h('span', 'plan-slowest-id', [`op${op.id}`]),
      bar,
      h('span', 'plan-slowest-pct', [formatPct(op.timePct)]),
    );
    row.addEventListener('click', () => zoomToNode(op.uid));
    list.append(row);
  });
  panel.append(list);
  panel.append(h('div', 'plan-slowest-note', ['% of step exec time']));
  return panel;
}

function toggleSlowest() {
  if (!slowestPanelEl) return;
  const collapsed = slowestPanelEl.classList.toggle('collapsed');
  slowestBtnEl?.classList.toggle('active', !collapsed);
}

/** Center the camera on a node and flash it briefly. */
export function zoomToNode(uid) {
  const pos = nodePositions?.get(uid);
  if (!pos || !canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, 1.2));
  camera.x = pos.x + NODE_W / 2 - rect.width / (2 * camera.zoom);
  camera.y = pos.y + NODE_H / 2 - rect.height / (2 * camera.zoom);
  clampCameraToBounds();
  updateTransform(true);

  const el = document.getElementById(`plan-node-${uid}`);
  if (el) {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }
}

function updateTransform(smooth = false) {
  if (!zoomEl) return;
  zoomEl.classList.toggle('smooth', smooth);
  if (smooth) setTimeout(() => zoomEl.classList.remove('smooth'), 280);
  zoomEl.style.transform =
    `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})`;
  zoomEl.style.transformOrigin = '0 0';
  updateZoomIndicator();
  updateMinimap();
}

/** Keep the camera near the content (allows half a screen of overscroll). */
function clampCameraToBounds() {
  if (!canvasEl || !contentSize.width || !contentSize.height) return;
  const rect = canvasEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const viewW = rect.width / camera.zoom, viewH = rect.height / camera.zoom;
  const cW = contentSize.width, cH = contentSize.height;
  const marginX = Math.max(0, (viewW - cW) / 2), marginY = Math.max(0, (viewH - cH) / 2);
  const over = 0.5;
  const minX = -cW * over - marginX, maxX = cW * (1 + over) - viewW + marginX;
  const minY = -cH * over - marginY, maxY = cH * (1 + over) - viewH + marginY;
  if (maxX > minX) camera.x = Math.max(minX, Math.min(maxX, camera.x));
  if (maxY > minY) camera.y = Math.max(minY, Math.min(maxY, camera.y));
}

function fitToView(smooth = true) {
  if (!canvasEl || contentSize.width === 0 || contentSize.height === 0) return;
  const rect = canvasEl.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return; // panel still hidden

  const pad = 48;
  const scale = Math.min(
    (rect.width - pad * 2) / contentSize.width,
    (rect.height - pad * 2) / contentSize.height,
    1,
  );
  camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
  camera.x = -(rect.width / camera.zoom - contentSize.width) / 2;
  camera.y = -(rect.height / camera.zoom - contentSize.height) / 2;
  updateTransform(smooth);
}

function zoomToCenter(delta, smooth = true) {
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const worldX = camera.x + cx / camera.zoom;
  const worldY = camera.y + cy / camera.zoom;
  camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * delta));
  camera.x = worldX - cx / camera.zoom;
  camera.y = worldY - cy / camera.zoom;
  clampCameraToBounds();
  updateTransform(smooth);
}

/* ---- zoom indicator + minimap ---- */

function buildZoomIndicator() {
  zoomIndicatorEl = h('div', 'plan-zoom-indicator', ['100%']);
  return zoomIndicatorEl;
}

function updateZoomIndicator() {
  if (!zoomIndicatorEl) return;
  zoomIndicatorEl.textContent = `${Math.round(camera.zoom * 100)}%`;
  zoomIndicatorEl.classList.add('visible');
  clearTimeout(zoomIndicatorTimeout);
  zoomIndicatorTimeout = setTimeout(() => zoomIndicatorEl.classList.remove('visible'), 1200);
}

function buildMinimap() {
  minimapEl = h('div', 'plan-minimap');
  const nodesLayer = h('div', 'plan-minimap-nodes');
  minimapViewportEl = h('div', 'plan-minimap-viewport');

  minimapScale = (contentSize.width && contentSize.height)
    ? Math.min((MINIMAP_W - MINIMAP_PAD * 2) / contentSize.width, (MINIMAP_H - MINIMAP_PAD * 2) / contentSize.height)
    : 0;

  if (minimapScale > 0) {
    for (const op of planProfile.operators) {
      const p = nodePositions.get(op.uid);
      if (!p) continue;
      const dot = h('span', `plan-minimap-dot fam-${familyOf(op.type)}`);
      dot.style.left = `${MINIMAP_PAD + p.x * minimapScale}px`;
      dot.style.top = `${MINIMAP_PAD + p.y * minimapScale}px`;
      nodesLayer.append(dot);
    }
  }

  minimapEl.append(nodesLayer, minimapViewportEl);
  minimapEl.addEventListener('click', onMinimapClick);
  return minimapEl;
}

function updateMinimap() {
  if (!minimapViewportEl || !canvasEl || !minimapScale) return;
  const rect = canvasEl.getBoundingClientRect();
  minimapViewportEl.style.left = `${MINIMAP_PAD + camera.x * minimapScale}px`;
  minimapViewportEl.style.top = `${MINIMAP_PAD + camera.y * minimapScale}px`;
  minimapViewportEl.style.width = `${(rect.width / camera.zoom) * minimapScale}px`;
  minimapViewportEl.style.height = `${(rect.height / camera.zoom) * minimapScale}px`;
}

function onMinimapClick(e) {
  if (!minimapScale || !canvasEl) return;
  const r = minimapEl.getBoundingClientRect();
  const worldX = (e.clientX - r.left - MINIMAP_PAD) / minimapScale;
  const worldY = (e.clientY - r.top - MINIMAP_PAD) / minimapScale;
  const rect = canvasEl.getBoundingClientRect();
  camera.x = worldX - (rect.width / camera.zoom) / 2;
  camera.y = worldY - (rect.height / camera.zoom) / 2;
  clampCameraToBounds();
  updateTransform(true);
}

/** Replace the minimap in place (dots depend on positions, which pruning changes). */
function rebuildMinimap() {
  const old = minimapEl;
  const fresh = buildMinimap();          // reassigns minimapEl + minimapViewportEl
  if (old?.parentNode) old.replaceWith(fresh);
  updateMinimap();
}

/* ============================================================
   Pruning panel
   ============================================================ */

const PRUNE_FAMILY_LABELS = {
  scan: 'Scan', join: 'Join', filter: 'Filter', agg: 'Aggregate',
  sort: 'Sort', set: 'CTE / set', dml: 'DML', result: 'Result', other: 'Other',
};

function buildPruningPanel(profile) {
  const panel = h('div', 'plan-pruning collapsed');

  const head = h('div', 'plan-pruning-head');
  head.append(h('span', 'plan-pruning-title', ['Prune & collapse']));
  const close = h('button', 'plan-pruning-close', ['×']);
  close.title = 'Hide panel';
  close.addEventListener('click', togglePruning);
  head.append(close);
  panel.append(head);

  // Minimum-rows slider (log scale: All, 10, 100 … 10M).
  const rowsSec = h('div', 'plan-pruning-section');
  const rowsHead = h('div', 'plan-pruning-label', [
    h('span', null, ['Min rows']),
    h('span', 'plan-pruning-value', ['All']),
  ]);
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '7'; slider.step = '1'; slider.value = '0';
  slider.className = 'plan-pruning-slider';
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    minRowThreshold = v === 0 ? 0 : Math.pow(10, v);
    rowsHead.querySelector('.plan-pruning-value').textContent = v === 0 ? 'All' : `≥ ${formatRows(minRowThreshold)}`;
    applyPruning();
  });
  rowsSec.append(rowsHead, slider);
  panel.append(rowsSec);

  // Per-family type checkboxes (only the families present in this profile).
  const present = [...new Set(profile.operators.map(op => familyOf(op.type)))]
    .sort((a, b) => (PRUNE_FAMILY_LABELS[a] || a).localeCompare(PRUNE_FAMILY_LABELS[b] || b));
  const typesSec = h('div', 'plan-pruning-section');
  typesSec.append(h('div', 'plan-pruning-label', [h('span', null, ['Operator types'])]));
  const grid = h('div', 'plan-pruning-types');
  for (const fam of present) {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true; cb.dataset.fam = fam;
    cb.addEventListener('change', () => {
      if (cb.checked) hiddenTypes.delete(fam); else hiddenTypes.add(fam);
      applyPruning();
    });
    const label = h('label', `plan-pruning-type fam-${fam}`, [cb, h('span', null, [PRUNE_FAMILY_LABELS[fam] || fam])]);
    grid.append(label);
  }
  typesSec.append(grid);
  panel.append(typesSec);

  const reset = h('button', 'plan-pruning-reset', ['Reset']);
  reset.addEventListener('click', () => {
    minRowThreshold = 0;
    hiddenTypes.clear();
    slider.value = '0';
    rowsHead.querySelector('.plan-pruning-value').textContent = 'All';
    grid.querySelectorAll('input').forEach(c => { c.checked = true; });
    applyPruning();
  });
  panel.append(reset);

  return panel;
}

function togglePruning() {
  if (!pruningPanelEl) return;
  const collapsed = pruningPanelEl.classList.toggle('collapsed');
  pruningBtnEl?.classList.toggle('active', !collapsed);
}

/** Re-render the tree for the current pruning state, keeping the camera put. */
function applyPruning() {
  renderTree();
  clampCameraToBounds();
  updateTransform();
}

function setupViewport() {
  if (!canvasEl) return;

  canvasEl.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const worldX = camera.x + mx / camera.zoom;
    const worldY = camera.y + my / camera.zoom;
    const delta = e.deltaY > 0 ? 0.92 : 1.08;
    camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * delta));
    camera.x = worldX - mx / camera.zoom;
    camera.y = worldY - my / camera.zoom;
    clampCameraToBounds();
    updateTransform();
  }, { passive: false });

  let panning = false, startX = 0, startY = 0, camX = 0, camY = 0, pid = null;

  canvasEl.addEventListener('pointerdown', e => {
    if (e.target.closest('.plan-toolbar') || e.target.closest('.plan-detail') || e.target.closest('.plan-slowest') || e.target.closest('.plan-search') || e.target.closest('.plan-minimap') || e.target.closest('.plan-pruning')) return;
    panning = true;
    dragMoved = false;
    pid = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    camX = camera.x; camY = camera.y;
    canvasEl.classList.add('panning');
    canvasEl.setPointerCapture(pid);
  });

  canvasEl.addEventListener('pointermove', e => {
    if (!panning || e.pointerId !== pid) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    camera.x = camX - dx / camera.zoom;
    camera.y = camY - dy / camera.zoom;
    clampCameraToBounds();
    updateTransform();
  });

  const endPan = e => {
    if (!panning || e.pointerId !== pid) return;
    panning = false;
    canvasEl.classList.remove('panning');
    canvasEl.releasePointerCapture(pid);
    pid = null;
  };
  canvasEl.addEventListener('pointerup', endPan);
  canvasEl.addEventListener('pointercancel', endPan);

  // Click on empty canvas (not a drag, not a node) closes the detail panel.
  canvasEl.addEventListener('click', e => {
    if (dragMoved) return;
    if (e.target.closest('.plan-node') || e.target.closest('.plan-toolbar') || e.target.closest('.plan-detail') || e.target.closest('.plan-slowest') || e.target.closest('.plan-search') || e.target.closest('.plan-minimap') || e.target.closest('.plan-pruning')) return;
    closeDetail();
  });

  canvasEl.addEventListener('dblclick', () => fitToView(true));
}
