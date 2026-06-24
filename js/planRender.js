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
import { formatRows, formatPct } from './utils.js';
import { familyOf, metricChips, primaryDetail, fullAttributes, h, htmlEl, escapeHTML } from './operatorView.js';

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

// Module state (reset on each render)
let canvasEl = null;
let zoomEl = null;
let detailEl = null;
let camera = { x: 0, y: 0, zoom: 1 };
let contentSize = { width: 0, height: 0 };
let dragMoved = false;

/* ============================================================
   Public API
   ============================================================ */

export function renderPlan(profile, container) {
  container.innerHTML = '';
  camera = { x: 0, y: 0, zoom: 1 };

  const children = buildChildrenMap(profile);
  const { positions, width, height } = layout(profile, children);
  contentSize = { width, height };

  // Time-heat is normalized per step: overall_percentage in the CSV is per-step,
  // so a single-operator step (e.g. step-1 CREATE TABLE = 100%) must NOT read as hot.
  const heat = buildHeatContext(profile);

  // DOM scaffold: canvas → zoom-container → (svg edges + node divs)
  canvasEl = h('div', 'plan-canvas');
  zoomEl = h('div', 'zoom-container');
  const svg = buildEdges(profile, positions);
  zoomEl.append(svg);
  for (const op of profile.operators) {
    const pos = positions.get(op.uid);
    if (pos) zoomEl.append(buildNode(op, pos, heat));
  }
  canvasEl.append(zoomEl);

  const toolbar = buildToolbar();
  detailEl = h('aside', 'plan-detail');
  detailEl.style.display = 'none';

  canvasEl.append(toolbar, buildHeatLegend(), detailEl);
  container.append(canvasEl);

  setupViewport();
  // Tab panel may be hidden at first render (0×0) — fitToView no-ops then and
  // refreshPlanView() re-fits once the tab is shown.
  requestAnimationFrame(() => requestAnimationFrame(() => fitToView(false)));
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

/**
 * Top-down layout. Each root tree is laid out independently and offset to the
 * right of the previous one. Shared CTE nodes (≤2 parents) are placed under the
 * first parent that reaches them; the other parent just draws an edge.
 */
function layout(profile, children) {
  const sizes = new Map();   // uid → subtree perpendicular (x) size
  const positions = new Map();

  const visited = new Set(); // for size pass (place-once)
  const placed = new Set();  // for position pass (place-once)

  // Largest trees first so the main step is leftmost.
  const roots = [...profile.roots].sort(
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

function buildEdges(profile, positions) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('plan-edges');
  svg.setAttribute('width', contentSize.width);
  svg.setAttribute('height', contentSize.height);

  // Two passes so labels always sit above every edge.
  const labels = [];

  for (const op of profile.operators) {
    const from = positions.get(op.uid);
    if (!from) continue;
    // Data flows from this node UP to its parent(s); the edge carries this
    // node's output rows. Width scales with that volume (log10).
    const rows = op.outputRows;
    const width = edgeWidth(rows);

    for (const puid of op.parentUids) {
      const to = positions.get(puid);
      if (!to) continue;
      const sx = to.x + NODE_W / 2, sy = to.y + NODE_H;
      const ex = from.x + NODE_W / 2, ey = from.y;
      const dy = (ey - sy) * 0.45;
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M ${sx} ${sy} C ${sx} ${sy + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`);
      path.setAttribute('stroke-width', width.toFixed(1));
      path.classList.add('plan-edge');
      path.dataset.from = puid;          // forward-compat for the filter slice
      path.dataset.to = op.uid;
      svg.append(path);

      // Label every edge with a known volume, including 0 — an explicit "0"
      // (e.g. a Filter dropping every row → an empty branch) is more
      // informative than a blank edge.
      if (rows != null) {
        labels.push({ x: (sx + ex) / 2, y: (sy + ey) / 2, text: formatRows(rows), from: puid, to: op.uid });
      }
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
    rect.dataset.edgeLabel = `${lb.from}-${lb.to}`;

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', lb.x);
    text.setAttribute('y', lb.y + 4);
    text.setAttribute('text-anchor', 'middle');
    text.classList.add('plan-edge-label');
    text.dataset.edgeLabel = `${lb.from}-${lb.to}`;
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
  head.append(h('span', 'plan-node-id', [`op${op.id}`]));
  node.append(head);

  const metric = nodeMetric(op);
  if (metric) node.append(h('div', 'plan-node-metric', [metric]));

  if (op.timePct != null && op.timePct > 0) {
    node.append(h('span', 'plan-node-time', [formatPct(op.timePct)]));
  }

  node.addEventListener('click', e => {
    e.stopPropagation();
    openDetail(op, node);
  });
  return node;
}

/**
 * In-node rows are shown ONLY when the operator changes cardinality — i.e. the
 * formatted input and output differ. Pass-throughs (e.g. "17 → 17") and
 * single-value / zero cases are redundant with the edge labels (which already
 * show what flows in below and out above), so we omit them to keep nodes clean.
 */
function nodeMetric(op) {
  if (op.inputRows == null || op.outputRows == null) return null;
  const inRows = formatRows(op.inputRows);
  const outRows = formatRows(op.outputRows);
  return inRows === outRows ? null : `${inRows} → ${outRows}`;
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
   Toolbar + viewport
   ============================================================ */

function buildToolbar() {
  const bar = h('div', 'plan-toolbar');
  const mk = (label, title, fn) => {
    const b = h('button', 'plan-tool-btn', [label]);
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(
    mk('+', 'Zoom in', () => zoomToCenter(ZOOM_STEP)),
    mk('−', 'Zoom out', () => zoomToCenter(1 / ZOOM_STEP)),
    mk('⤢', 'Fit to view', () => fitToView(true)),
  );
  return bar;
}

/** Static cool→hot legend explaining the node time-heat shading. */
function buildHeatLegend() {
  const legend = h('div', 'plan-heat-legend');
  legend.append(
    h('span', 'plan-heat-label', ['cool']),
    h('span', 'plan-heat-bar'),
    h('span', 'plan-heat-label', ['hot']),
    h('span', 'plan-heat-caption', ['time / step']),
  );
  legend.title = 'Node shading: share of its plan step’s execution time';
  return legend;
}

function updateTransform(smooth = false) {
  if (!zoomEl) return;
  zoomEl.classList.toggle('smooth', smooth);
  if (smooth) setTimeout(() => zoomEl.classList.remove('smooth'), 280);
  zoomEl.style.transform =
    `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})`;
  zoomEl.style.transformOrigin = '0 0';
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
  updateTransform(smooth);
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
    updateTransform();
  }, { passive: false });

  let panning = false, startX = 0, startY = 0, camX = 0, camY = 0, pid = null;

  canvasEl.addEventListener('pointerdown', e => {
    if (e.target.closest('.plan-toolbar') || e.target.closest('.plan-detail')) return;
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
    if (e.target.closest('.plan-node') || e.target.closest('.plan-toolbar') || e.target.closest('.plan-detail')) return;
    closeDetail();
  });

  canvasEl.addEventListener('dblclick', () => fitToView(true));
}
