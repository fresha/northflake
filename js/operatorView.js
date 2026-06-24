/**
 * Shared per-operator presentation: family colours, metric chips, the inline
 * primary detail, and the full attribute list. Used by both the Operators tab
 * and the Query Plan tab so node colours and detail panels stay consistent.
 */
import { formatBytes, formatRows, formatCount, formatPct } from './utils.js';

/** Operator type → colour family (drives badge / node colour). */
export const FAMILY = {
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
export const familyOf = t => FAMILY[t] || 'other';

/** Type-aware metric chips — only show what the operator actually reports. */
export function metricChips(op) {
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

/** The single most useful attribute, shown inline (truncated by CSS). Returns HTML. */
export function primaryDetail(op) {
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

/** Full attribute list as [key, value] pairs for an expand / detail panel. */
export function fullAttributes(op) {
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

/* ---------- DOM helpers ---------- */
export function h(tag, cls, children) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (children) for (const c of children) el.append(c);
  return el;
}
export function htmlEl(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.innerHTML = html;
  return el;
}
export function escapeHTML(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
