/**
 * Operator explorer: browse every operator, filter by type, search, sort.
 * Each operator shows only the metrics relevant to it (a table would be mostly
 * empty since each operator type reports different stats), with the key
 * attribute inline and full detail on expand.
 */
import { formatPct } from './utils.js';
import { familyOf, metricChips, primaryDetail, fullAttributes, h, htmlEl, escapeHTML } from './operatorView.js';

const SORTS = {
  time:    { label: 'Time %',      fn: (a, b) => (b.timePct || 0) - (a.timePct || 0) },
  output:  { label: 'Output rows', fn: (a, b) => (b.outputRows || 0) - (a.outputRows || 0) },
  scanned: { label: 'Bytes scanned', fn: (a, b) => (b.bytesScanned || 0) - (a.bytesScanned || 0) },
  spill:   { label: 'Spill',       fn: (a, b) => (b.spilledLocal + b.spilledRemote) - (a.spilledLocal + a.spilledRemote) },
  id:      { label: 'Operator id', fn: (a, b) => a.stepId - b.stepId || a.id - b.id },
};

// view state, reset each render
let state = { type: 'ALL', search: '', sort: 'time' };

export function renderOperators(profile, container) {
  state = { type: 'ALL', search: '', sort: 'time' };
  container.innerHTML = '';

  const toolbar = h('div', 'ops-toolbar');
  const filters = buildTypeFilters(profile);
  const controls = buildControls();
  toolbar.append(filters, controls);

  const list = h('div', 'ops-list');

  const rerender = () => renderList(profile, list);

  // wire interactions
  filters.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.type = chip.dataset.type;
    filters.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
    rerender();
  });
  controls.querySelector('#opSearch').addEventListener('input', e => {
    state.search = e.target.value.trim().toLowerCase();
    rerender();
  });
  controls.querySelector('#opSort').addEventListener('change', e => {
    state.sort = e.target.value;
    rerender();
  });

  container.append(toolbar, list);
  rerender();
}

/* ---------- toolbar ---------- */
function buildTypeFilters(profile) {
  const counts = {};
  for (const op of profile.operators) counts[op.type] = (counts[op.type] || 0) + 1;
  const types = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  const wrap = h('div', 'ops-filters');
  wrap.append(chip('ALL', `All ${profile.operators.length}`, 'other', true));
  for (const [type, n] of types) wrap.append(chip(type, `${type} ${n}`, familyOf(type), false));
  return wrap;
}

function chip(type, text, fam, active) {
  const c = h('button', `chip fam-${fam}${active ? ' active' : ''}`, [text]);
  c.dataset.type = type;
  return c;
}

function buildControls() {
  const wrap = h('div', 'ops-controls');
  const search = document.createElement('input');
  search.id = 'opSearch';
  search.className = 'ops-search';
  search.placeholder = 'Search table, condition, op id…';
  search.autocomplete = 'off';

  const sort = document.createElement('select');
  sort.id = 'opSort';
  sort.className = 'ops-sort';
  for (const [key, { label }] of Object.entries(SORTS)) {
    const o = document.createElement('option');
    o.value = key; o.textContent = `Sort: ${label}`;
    sort.append(o);
  }
  wrap.append(search, sort);
  return wrap;
}

/* ---------- list ---------- */
function renderList(profile, list) {
  let ops = profile.operators;
  if (state.type !== 'ALL') ops = ops.filter(op => op.type === state.type);
  if (state.search) {
    const q = state.search;
    ops = ops.filter(op => searchText(op).includes(q));
  }
  ops = [...ops].sort(SORTS[state.sort].fn);

  list.innerHTML = '';
  if (ops.length === 0) {
    list.append(h('div', 'ops-empty', ['No operators match.']));
    return;
  }
  const count = h('div', 'ops-count', [`${ops.length} operator${ops.length === 1 ? '' : 's'}`]);
  list.append(count);
  for (const op of ops) list.append(opCard(op));
}

function searchText(op) {
  const a = op.attributes || {};
  return [
    op.type, `op${op.id}`,
    a.table_name, a.table_alias,
    a.equality_join_condition, a.additional_join_condition, a.join_type,
    a.filter_condition,
    ...(a.functions || []), ...(a.grouping_keys || []), ...(a.columns || []),
    a.name,
  ].filter(Boolean).join(' ').toLowerCase();
}

/* ---------- one operator card ---------- */
function opCard(op) {
  const fam = familyOf(op.type);
  const card = h('div', `op-card fam-${fam}`);

  // header
  const head = h('div', 'op-card-head');
  head.append(
    h('span', `op-badge fam-${fam}`, [op.type]),
    h('span', 'op-id', [`op${op.id}`]),
  );
  if (op.timePct != null && op.timePct > 0) {
    head.append(h('span', 'op-time', [formatPct(op.timePct)]));
  }
  card.append(head);

  // metric chips
  const metrics = metricChips(op);
  if (metrics.length) {
    const m = h('div', 'op-metrics');
    for (const mc of metrics) {
      m.append(h('span', `op-metric ${mc.cls || ''}`, [
        h('span', 'op-metric-label', [mc.label]),
        h('span', 'op-metric-value', [mc.value]),
      ]));
    }
    card.append(m);
  }

  // primary detail (table / condition / functions)
  const detail = primaryDetail(op);
  if (detail) card.append(htmlEl('div', 'op-detail', detail));

  // expand toggle if there are extra attributes
  const extra = fullAttributes(op);
  if (extra.length) {
    const toggle = h('button', 'op-expand-btn', ['▸ details']);
    const body = h('div', 'op-expand');
    body.style.display = 'none';
    for (const [k, v] of extra) {
      body.append(h('div', 'op-attr', [
        h('div', 'op-attr-key', [k]),
        htmlEl('div', 'op-attr-val', escapeHTML(v)),
      ]));
    }
    toggle.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      toggle.textContent = open ? '▸ details' : '▾ details';
    });
    card.append(toggle, body);
  }

  return card;
}

/* metricChips, primaryDetail, fullAttributes, and the DOM helpers
   (h / htmlEl / escapeHTML) now live in operatorView.js — shared with the Plan tab. */
