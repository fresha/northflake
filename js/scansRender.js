/**
 * Scans tab: a sortable table of every TableScan / ExternalScan operator with
 * the IO + pruning metrics that matter for scan performance.
 */
import { formatBytes, formatRows, formatCount, formatPct, splitTableName } from './utils.js';
import { attachTooltip } from './tooltip.js';
import { zoomToNode } from './planRender.js';

const SCAN_TYPES = new Set(['TableScan', 'ExternalScan']);

/** Column groups (shown as a color-coded top header row). */
const GROUPS = {
  id:    { label: '', cls: 'grp-id' },
  output:{ label: 'Output', cls: 'grp-output' },
  prune: { label: 'Pruning', cls: 'grp-prune' },
  io:    { label: 'IO', cls: 'grp-io' },
  proj:  { label: 'Projection', cls: 'grp-proj' },
  time:  { label: 'Execution Time', cls: 'grp-time' },
};

/** Execution-time phases, in stacking order, with their CSS class + label. */
const PHASES = [
  ['processing', 'processing', 'Processing (CPU)'],
  ['local_disk_io', 'local-io', 'Local disk IO (cache)'],
  ['remote_disk_io', 'remote-io', 'Remote disk IO (cold)'],
  ['network_communication', 'network', 'Network'],
  ['synchronization', 'sync', 'Synchronization'],
  ['initialization', 'init', 'Initialization'],
];

// render-scoped context (max time % across scans, for bar scaling)
let ctx = { maxOverall: 1 };

/** Column definitions. `val` = sort/numeric value, `cell` = DOM/text for the cell. */
const COLUMNS = [
  { key: 'op', label: 'Op', group: 'id', align: 'left', val: s => s.id,
    desc: 'Operator id (unique within its plan step). Click to reveal it in the Plan tab.',
    cell: s => opLink(s) },
  { key: 'database', label: 'Database', group: 'id', align: 'left', val: s => (parts(s).database || '').toLowerCase(),
    desc: 'Source database (first part of DATABASE.SCHEMA.TABLE).',
    cell: s => dim(parts(s).database) },
  { key: 'schema', label: 'Schema', group: 'id', align: 'left', val: s => (parts(s).schema || '').toLowerCase(),
    desc: 'Source schema (middle part of the qualified name).',
    cell: s => dim(parts(s).schema) },
  { key: 'table', label: 'Table', group: 'id', align: 'left', val: s => (parts(s).table || '').toLowerCase(),
    desc: 'Table being scanned. Hover a cell for the fully-qualified name.',
    cell: s => tableCell(s), cls: 'col-table' },
  { key: 'output', label: 'Rows', group: 'output', align: 'right', val: s => s.outputRows || 0,
    desc: 'Rows produced by this scan after pruning and predicate filtering.',
    cell: s => text(formatRows(s.outputRows)) },
  { key: 'pScanned', label: 'Scanned', group: 'prune', align: 'right', val: s => s.partitionsScanned || 0,
    desc: 'Micro-partitions actually read.',
    cell: s => text(formatCount(s.partitionsScanned)) },
  { key: 'pTotal', label: 'Total', group: 'prune', align: 'right', val: s => s.partitionsTotal || 0,
    desc: 'Total micro-partitions in the table.',
    cell: s => text(formatCount(s.partitionsTotal)) },
  { key: 'pruned', label: '% Pruned', group: 'prune', align: 'right', val: s => prunedFrac(s) ?? -1,
    desc: 'Micro-partitions skipped (1 − scanned/total). Higher is better — low values mean filters don\'t align with the table\'s clustering.',
    cell: s => prunedCell(s) },
  { key: 'bytes', label: 'Bytes', group: 'io', align: 'right', val: s => s.bytesScanned || 0,
    desc: 'Bytes read from storage by this scan.',
    cell: s => colored(formatBytes(s.bytesScanned), 'c-bytes') },
  { key: 'cache', label: 'Cache %', group: 'io', align: 'right', val: s => s.cacheFraction ?? -1,
    desc: 'Share of bytes served from the warehouse\'s local cache vs remote storage. Higher = warmer.',
    cell: s => cacheCell(s) },
  { key: 'cols', label: 'Cols', group: 'proj', align: 'right', val: s => (s.attributes.columns || []).length,
    desc: 'Number of columns projected by the scan. Hover a cell to see them.',
    cell: s => listCount(s.attributes.columns, null, 'columns') },
  { key: 'variants', label: 'Variants', group: 'proj', align: 'right', val: s => (s.attributes.extracted_variant_paths || []).length,
    desc: 'VARIANT sub-paths extracted (semi-structured access). Hover a cell to see them.',
    cell: s => listCount(s.attributes.extracted_variant_paths, 'col-variant', 'variant paths') },
  { key: 'time', label: 'Time', group: 'time', align: 'left', val: s => s.timePct || 0,
    desc: 'This operator\'s share of total query time, split by execution phase. Hover a bar for the breakdown.',
    cell: s => timeCell(s), cls: 'col-time' },
];

let sortState = { key: 'time', dir: 'desc' };
let filter = { db: '', schema: '', table: '' };
// Database/Schema are handy but wide; hiding them frees width for the metrics.
let hideQualifiers = false;

/** Keys hidden when the qualifier columns are collapsed. */
const QUALIFIER_KEYS = new Set(['database', 'schema']);

/** Columns currently shown, honoring the hide-qualifiers toggle. */
function visibleColumns() {
  return hideQualifiers ? COLUMNS.filter(c => !QUALIFIER_KEYS.has(c.key)) : COLUMNS;
}

export function renderScans(profile, container) {
  sortState = { key: 'time', dir: 'desc' };
  filter = { db: '', schema: '', table: '' };
  hideQualifiers = false;
  container.innerHTML = '';

  const scans = profile.operators.filter(op => SCAN_TYPES.has(op.type));
  if (scans.length === 0) {
    container.append(el('div', 'ops-empty', 'No scan operators in this profile.'));
    return;
  }
  ctx.maxOverall = Math.max(...scans.map(s => s.timePct || 0), 0) || 1;

  container.append(summaryStrip(scans));

  const wrap = el('div', 'scans-table-wrap');
  const table = document.createElement('table');
  table.className = 'scans-table';
  table.append(buildHead(), document.createElement('tbody'));
  wrap.append(table);

  const rerender = () => fillBody(table, scans, count);
  // Rebuild the header (column set changed) then refill the body.
  const rebuild = () => {
    table.replaceChild(buildHead(), table.tHead);
    updateHeadIndicators(table.tHead);
    rerender();
  };
  const { toolbar, count } = buildFilterBar(scans, rerender, rebuild);
  container.append(toolbar, wrap);

  // Delegated so it survives header rebuilds when columns are toggled.
  table.addEventListener('click', e => {
    const th = e.target.closest('thead th');
    if (!th || !th.dataset.key) return; // group-row headers aren't sortable
    const key = th.dataset.key;
    if (sortState.key === key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    else sortState = { key, dir: defaultDir(key) };
    updateHeadIndicators(table.tHead);
    rerender();
  });

  updateHeadIndicators(table.tHead);
  rerender();
}

/* ---------- summary strip ---------- */
function summaryStrip(scans) {
  const totalBytes = scans.reduce((a, s) => a + (s.bytesScanned || 0), 0);
  const pScanned = scans.reduce((a, s) => a + (s.partitionsScanned || 0), 0);
  const pTotal = scans.reduce((a, s) => a + (s.partitionsTotal || 0), 0);
  const cacheWeighted = scans.reduce((a, s) => a + (s.cacheFraction != null ? s.cacheFraction * (s.bytesScanned || 0) : 0), 0);
  const overallPruned = pTotal > 0 ? 1 - pScanned / pTotal : null;
  const overallCache = totalBytes > 0 ? cacheWeighted / totalBytes : null;

  const wrap = el('div', 'cards scans-summary');
  wrap.append(
    card('Scans', formatCount(scans.length), 'muted'),
    card('Bytes Scanned', formatBytes(totalBytes), 'bytes'),
    card('Partitions Pruned', overallPruned != null ? formatPct(overallPruned) : '—',
      overallPruned != null && overallPruned < 0.1 ? 'danger' : 'rows',
      `${formatCount(pScanned)} / ${formatCount(pTotal)} scanned`),
    card('Cache Hit', overallCache != null ? formatPct(overallCache) : '—', 'time', 'weighted by bytes'),
  );
  return wrap;
}

/* ---------- filter bar ----------
   Database + Schema are low-cardinality → dropdowns. Table is high-cardinality
   → free-text substring. Scoping each facet independently avoids the ambiguity
   of a single search matching a value in any of the three parts. */
function buildFilterBar(scans, onChange, onColumnsChange) {
  const toolbar = el('div', 'scans-toolbar');

  const dbSel = document.createElement('select');
  dbSel.className = 'scans-select';
  const schemaSel = document.createElement('select');
  schemaSel.className = 'scans-select';

  const search = document.createElement('input');
  search.className = 'ops-search scans-table-search';
  search.placeholder = 'Search table…';
  search.autocomplete = 'off';

  const count = el('span', 'scans-count');

  // distinct databases across all scans
  const databases = distinct(scans.map(s => parts(s).database));
  fillOptions(dbSel, databases, 'All databases');

  // schemas depend on the chosen database (only those present within it)
  const syncSchemas = () => {
    const prev = filter.schema;
    const pool = filter.db
      ? scans.filter(s => (parts(s).database || '') === filter.db)
      : scans;
    const schemas = distinct(pool.map(s => parts(s).schema));
    fillOptions(schemaSel, schemas, 'All schemas');
    // keep the selection if it still exists under the new database
    if (prev && schemas.includes(prev)) schemaSel.value = prev;
    else { schemaSel.value = ''; filter.schema = ''; }
  };
  syncSchemas();

  dbSel.addEventListener('change', () => {
    filter.db = dbSel.value;
    syncSchemas();
    onChange();
  });
  schemaSel.addEventListener('change', () => {
    filter.schema = schemaSel.value;
    onChange();
  });
  search.addEventListener('input', () => {
    filter.table = search.value.trim().toLowerCase();
    onChange();
  });

  // Toggle to collapse the wide Database/Schema columns (still filterable above).
  const toggle = el('label', 'scans-toggle');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = hideQualifiers;
  box.addEventListener('change', () => {
    hideQualifiers = box.checked;
    // If we were sorting by a now-hidden column, fall back to the default.
    if (hideQualifiers && QUALIFIER_KEYS.has(sortState.key)) {
      sortState = { key: 'time', dir: 'desc' };
    }
    onColumnsChange();
  });
  toggle.append(box, el('span', null, 'Hide db / schema'));

  toolbar.append(
    field('Database', dbSel),
    field('Schema', schemaSel),
    search,
    toggle,
    count,
  );
  return { toolbar, count };
}

/** distinct, non-empty, case-sorted values. */
function distinct(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function fillOptions(sel, values, allLabel) {
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = ''; all.textContent = allLabel;
  sel.append(all);
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.append(o);
  }
}

function field(label, control) {
  const w = el('div', 'scans-field');
  w.append(el('label', 'scans-field-label', label), control);
  return w;
}

/* ---------- table head ---------- */
function buildHead() {
  const thead = document.createElement('thead');
  const cols = visibleColumns();

  // Row 1: group headers (merge consecutive columns sharing a group).
  const grpRow = el('tr', 'grp-row');
  for (let i = 0; i < cols.length;) {
    const g = cols[i].group;
    let span = 1;
    while (i + span < cols.length && cols[i + span].group === g) span++;
    const meta = GROUPS[g] || { label: '', cls: '' };
    const th = document.createElement('th');
    th.colSpan = span;
    th.className = `grp ${meta.cls}`;
    th.textContent = meta.label;
    grpRow.append(th);
    i += span;
  }

  // Row 2: sortable column headers with description tooltips.
  const colRow = el('tr', 'col-row');
  for (const c of cols) {
    const th = document.createElement('th');
    th.dataset.key = c.key;
    th.className = `align-${c.align}${c.cls ? ' ' + c.cls : ''}`;
    th.innerHTML = `<span class="th-label">${c.label}</span><span class="th-sort"></span>`;
    if (c.desc) attachTooltip(th, `<div class="tt-title">${c.label}</div><div class="tt-desc">${c.desc}</div>`);
    colRow.append(th);
  }

  thead.append(grpRow, colRow);
  return thead;
}

function updateHeadIndicators(thead) {
  thead.querySelectorAll('th[data-key]').forEach(th => {
    const active = th.dataset.key === sortState.key;
    th.classList.toggle('sorted', active);
    th.querySelector('.th-sort').textContent = active ? (sortState.dir === 'asc' ? '▲' : '▼') : '';
  });
}

function defaultDir(key) {
  // text columns default A→Z; numeric columns default high→low
  return (key === 'op' || key === 'table') ? 'asc' : 'desc';
}

/* ---------- table body ---------- */
function fillBody(table, scans, count) {
  const active = filter.db || filter.schema || filter.table;
  const filtered = scans.filter(s => {
    const p = parts(s);
    if (filter.db && (p.database || '') !== filter.db) return false;
    if (filter.schema && (p.schema || '') !== filter.schema) return false;
    if (filter.table && !(p.table || '').toLowerCase().includes(filter.table)) return false;
    return true;
  });

  const cols = visibleColumns();
  const col = cols.find(c => c.key === sortState.key) || cols[0];
  const sorted = [...filtered].sort((a, b) => {
    const av = col.val(a), bv = col.val(b);
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortState.dir === 'asc' ? cmp : -cmp;
  });

  if (count) {
    count.textContent = active
      ? `${filtered.length} of ${scans.length} scans`
      : `${scans.length} scan${scans.length === 1 ? '' : 's'}`;
  }

  const tbody = table.tBodies[0];
  tbody.innerHTML = '';
  if (sorted.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = cols.length;
    td.className = 'scans-empty';
    td.textContent = 'No scans match this filter.';
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const s of sorted) {
    const tr = document.createElement('tr');
    for (const c of cols) {
      const td = document.createElement('td');
      td.className = `align-${c.align}${c.cls ? ' ' + c.cls : ''}`;
      const content = c.cell(s);
      if (content instanceof Node) td.append(content);
      else td.textContent = content;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

/* ---------- cell renderers ---------- */
function prunedFrac(s) {
  return s.partitionsTotal > 0 ? 1 - (s.partitionsScanned || 0) / s.partitionsTotal : null;
}
function prunedCell(s) {
  const f = prunedFrac(s);
  if (f == null) return text('—');
  const cls = f < 0.1 ? 'c-danger' : f < 0.5 ? 'c-warn' : 'c-good';
  return colored(formatPct(f), cls);
}
function cacheCell(s) {
  if (s.cacheFraction == null) return text('—');
  const cls = s.cacheFraction >= 0.7 ? 'c-good' : s.cacheFraction >= 0.3 ? 'c-warn' : 'c-danger';
  return colored(formatPct(s.cacheFraction, 0), cls);
}
/** A count cell; hovering reveals the underlying list in a rich tooltip. */
function listCount(list, cls, label) {
  const arr = list || [];
  if (arr.length === 0) return text('—');
  const node = el('span', cls || null, `${arr.length}`);
  attachTooltip(node, `<div class="tt-title">${arr.length} ${label}</div>` +
    `<div class="tt-desc tt-list">${arr.map(escapeHtml).join(', ')}</div>`);
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** Stacked time-breakdown bar: length = % of query time, segments = phase mix. */
function timeCell(s) {
  const ov = s.timePct || 0;
  const wrap = el('div', 'time-cell');

  const track = el('div', 'tb-track');
  const bar = el('div', 'tb-bar');
  bar.style.width = `${(ov / ctx.maxOverall) * 100}%`;
  for (const [key, cssName] of PHASES) {
    const v = s.timeBreakdown?.[key] || 0;
    if (v <= 0) continue;
    const seg = el('span', `tb-seg ph-${cssName}`);
    seg.style.width = `${(v / ov) * 100}%`;
    bar.append(seg);
  }
  track.append(bar);

  // Rich tooltip on the whole track, so even tiny bars are hoverable.
  attachTooltip(track, () => timeTooltip(s));

  wrap.append(track, el('span', 'tb-pct', ov > 0 ? formatPct(ov) : '—'));
  return wrap;
}

/** HTML for the time-breakdown hover panel. */
function timeTooltip(s) {
  const ov = s.timePct || 0;
  let rows = '';
  for (const [key, cssName, label] of PHASES) {
    const v = s.timeBreakdown?.[key] || 0;
    if (v <= 0) continue;
    rows += `<div class="tt-row">
      <span class="tt-key"><span class="tt-swatch ph-${cssName}"></span>${label}</span>
      <span class="tt-val">${formatPct(v / ov, 0)}</span>
    </div>`;
  }
  if (!rows) rows = '<div class="tt-row tt-muted">No timing recorded</div>';
  return `<div class="tt-title">${s.type} <span class="tt-dim">op${s.id}</span></div>
    <div class="tt-sub">${ov > 0 ? formatPct(ov) : '0%'} of total query time</div>
    ${rows}`;
}

/** Memoized DATABASE.SCHEMA.TABLE split for a scan operator. */
function parts(s) {
  if (!s._nameParts) s._nameParts = splitTableName(s.attributes.table_name);
  return s._nameParts;
}

function tableCell(s) {
  const name = parts(s).table || '(unknown)';
  const b = el('span', 'tbl-name', name);
  b.title = s.attributes.table_name || name;
  return b;
}

function dim(value) {
  return value ? el('span', 'tbl-qualifier', value) : text('—');
}

/** Clickable op id → jumps to the Plan tab and centers on this operator. */
function opLink(s) {
  const a = el('span', 'op-link', `op${s.id}`);
  a.setAttribute('role', 'button');
  a.tabIndex = 0;
  const go = () => gotoPlanNode(s.uid);
  a.addEventListener('click', go);
  a.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  return a;
}

/** Activate the Plan tab, then center + flash the node once its layout is live. */
function gotoPlanNode(uid) {
  document.querySelector('.tab-btn[data-tab="plan"]')?.click();
  // The plan panel refits its camera on tab activation (refreshPlanView);
  // wait a beat for that layout pass before centering on the node.
  setTimeout(() => zoomToNode(uid), 120);
}

/* ---------- helpers ---------- */
function text(t) { return document.createTextNode(t == null ? '—' : String(t)); }
function colored(t, cls) { return el('span', cls, t); }
function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function card(label, value, valueCls, sub) {
  const c = el('div', 'card');
  c.append(el('div', 'card-label', label), el('div', `card-value ${valueCls || ''}`, value));
  if (sub) c.append(el('div', 'card-sub', sub));
  return c;
}
