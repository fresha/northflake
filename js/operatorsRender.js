/**
 * Operator explorer: browse every operator, filter by type, search, sort.
 * Each operator shows only the metrics relevant to it (a table would be mostly
 * empty since each operator type reports different stats), with the key
 * attribute inline and full detail on expand.
 */
import { formatBytes, formatRows, formatCount, formatPct } from './utils.js';

/** Operator type → colour family (drives the badge colour). */
const FAMILY = {
  TableScan: 'scan', ExternalScan: 'scan',
  Join: 'join', CartesianJoin: 'join', JoinFilter: 'join',
  Filter: 'filter',
  Aggregate: 'agg', GroupingSets: 'agg', WindowFunction: 'agg',
  Sort: 'sort', SortWithLimit: 'sort',
  UnionAll: 'set', WithClause: 'set', WithReference: 'set',
  CreateTableAsSelect: 'dml', 'CREATE TABLE': 'dml', Insert: 'dml',
  Update: 'dml', Delete: 'dml', Merge: 'dml', Unload: 'dml',
  Result: 'result',
};
const familyOf = t => FAMILY[t] || 'other';

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

/** Type-aware metric chips — only show what the operator actually reports. */
function metricChips(op) {
  const chips = [];
  if (op.inputRows != null && op.outputRows != null) {
    chips.push({ label: 'rows', value: `${formatRows(op.inputRows)} → ${formatRows(op.outputRows)}`, cls: 'm-rows' });
  } else if (op.outputRows != null) {
    chips.push({ label: 'output', value: formatRows(op.outputRows), cls: 'm-rows' });
  } else if (op.inputRows != null) {
    chips.push({ label: 'input', value: formatRows(op.inputRows), cls: 'm-rows' });
  }
  if (op.bytesScanned > 0) chips.push({ label: 'scanned', value: formatBytes(op.bytesScanned), cls: 'm-bytes' });
  if (op.bytesWritten > 0) chips.push({ label: 'written', value: formatBytes(op.bytesWritten), cls: 'm-bytes' });
  if (op.cacheFraction != null && op.bytesScanned > 0) {
    chips.push({ label: 'cache', value: formatPct(op.cacheFraction, 0), cls: 'm-cache' });
  }
  if (op.partitionsTotal != null) {
    const scanned = op.partitionsScanned || 0;
    const frac = scanned / op.partitionsTotal;
    chips.push({
      label: 'partitions',
      value: `${formatCount(scanned)}/${formatCount(op.partitionsTotal)}`,
      cls: frac > 0.9 ? 'm-warn' : 'm-prune',
    });
  }
  const spill = op.spilledLocal + op.spilledRemote;
  if (spill > 0) chips.push({ label: 'spill', value: formatBytes(spill), cls: 'm-danger' });
  if (op.networkBytes > 0) chips.push({ label: 'network', value: formatBytes(op.networkBytes), cls: 'm-muted' });
  return chips;
}

/** The single most useful attribute, shown inline (truncated by CSS). */
function primaryDetail(op) {
  const a = op.attributes || {};
  switch (op.type) {
    case 'TableScan':
    case 'ExternalScan':
      return a.table_name ? `<b>${escapeHTML(a.table_name)}</b>${a.table_alias ? ` <span class="dim">${escapeHTML(a.table_alias)}</span>` : ''}` : null;
    case 'Join':
    case 'CartesianJoin':
      return [a.join_type ? `<span class="dim">${escapeHTML(a.join_type)}</span>` : '', a.equality_join_condition ? escapeHTML(a.equality_join_condition) : '']
        .filter(Boolean).join(' &middot; ') || null;
    case 'Filter':
      return a.filter_condition ? escapeHTML(a.filter_condition) : null;
    case 'Aggregate':
      return a.grouping_keys?.length ? `<span class="dim">group by</span> ${escapeHTML(a.grouping_keys.join(', '))}` : null;
    case 'WindowFunction':
      return a.functions?.length ? escapeHTML(a.functions[0]) : null;
    case 'WithClause':
    case 'WithReference':
      return a.name ? `<b>${escapeHTML(a.name)}</b>` : null;
    default:
      if (a.table_name) return `<b>${escapeHTML(a.table_name)}</b>`;
      if (a.filter_condition) return escapeHTML(a.filter_condition);
      return null;
  }
}

/** Full attribute list for the expand panel. */
function fullAttributes(op) {
  const a = op.attributes || {};
  const out = [];
  const add = (k, v) => { if (v != null && v !== '' && !(Array.isArray(v) && v.length === 0)) out.push([k, Array.isArray(v) ? v.join('\n') : String(v)]); };

  add('table_name', a.table_name);
  add('table_alias', a.table_alias);
  add('columns', a.columns);
  add('join_type', a.join_type);
  add('equality_join_condition', a.equality_join_condition);
  add('additional_join_condition', a.additional_join_condition);
  add('filter_condition', a.filter_condition);
  add('grouping_keys', a.grouping_keys);
  add('functions', a.functions);
  add('sort_keys', a.sort_keys);
  add('key_sets', a.key_sets);
  add('input_expressions', a.input_expressions);
  add('expressions', a.expressions);
  add('table_names', a.table_names);
  add('name', a.name);
  add('join_id', a.join_id);
  add('row_count', a.row_count);

  // any attributes we didn't explicitly map
  const known = new Set(['table_name', 'table_alias', 'columns', 'join_type', 'equality_join_condition',
    'additional_join_condition', 'filter_condition', 'grouping_keys', 'functions', 'sort_keys',
    'key_sets', 'input_expressions', 'expressions', 'table_names', 'name', 'join_id', 'row_count']);
  for (const [k, v] of Object.entries(a)) {
    if (!known.has(k)) add(k, v);
  }
  return out;
}

/* ---------- helpers ---------- */
function h(tag, cls, children) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (children) for (const c of children) el.append(c);
  return el;
}
function htmlEl(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.innerHTML = html;
  return el;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
