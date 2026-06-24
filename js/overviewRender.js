/** Renders the Overview tab: query summary, key stat cards, insights, time distribution. */
import { formatBytes, formatRows, formatCount, formatPct } from './utils.js';
import { topByTime, queryResult } from './profileParser.js';

export function renderOverview(profile, container) {
  const { totals } = profile;
  container.innerHTML = '';
  container.append(
    querySummary(profile),
    sectionTitle('Key Metrics'),
    keyCards(totals),
    sectionTitle('Insights'),
    insights(profile),
    sectionTitle('Where time goes'),
    timeDistribution(profile),
  );
}

/* ---------- query summary strip ---------- */
function querySummary(profile) {
  const { totals } = profile;
  const queryType = inferQueryType(profile);
  const result = queryResult(profile);

  const el = h('section', 'query-info');
  el.append(
    h('div', 'query-info-header', [
      h('h2', null, ['Query Summary']),
      h('div', 'query-id', [`${profile.queryId}`]),
    ]),
    meta([
      ['Query Type', queryType, 'badge'],
      ['Operators', formatCount(totals.operatorCount)],
      [result.label, result.value != null ? formatCount(result.value) : '—'],
    ]),
  );
  return el;
}

function inferQueryType(profile) {
  // Prefer the most "write-like" operator; otherwise it's a read query.
  const order = ['CreateTableAsSelect', 'CREATE TABLE', 'Insert', 'Update', 'Delete', 'Merge', 'Unload'];
  for (const t of order) {
    if (profile.operators.some(op => op.type === t)) return t;
  }
  return 'SELECT';
}

/* ---------- key cards ---------- */
function keyCards(t) {
  const cards = [
    card('Bytes Scanned', formatBytes(t.bytesScanned), 'bytes'),
    card('Bytes Written', formatBytes(t.bytesWritten), 'bytes'),
    card('Bytes Spilled', formatBytes(t.spilledTotal), t.spilledTotal > 0 ? 'danger' : 'muted',
      t.spilledTotal > 0 ? `${formatBytes(t.spilledLocal)} local · ${formatBytes(t.spilledRemote)} remote` : 'no spill'),
    card('Cache Hit', t.cacheFraction != null ? formatPct(t.cacheFraction) : '—', 'time', 'of bytes scanned'),
    card('Partition Pruning', t.pruneFraction != null ? formatPct(t.pruneFraction) : '—',
      t.pruneFraction != null && t.pruneFraction < 0.1 ? 'danger' : 'rows',
      t.partitionsTotal ? `${formatCount(t.partitionsScanned)} / ${formatCount(t.partitionsTotal)} scanned` : 'n/a'),
    card('Network', formatBytes(t.networkBytes), 'muted'),
  ];
  const wrap = h('div', 'cards');
  cards.forEach(c => wrap.append(c));
  return wrap;
}

/* ---------- insights ---------- */
function insights(profile) {
  const { totals: t } = profile;
  const items = [];

  // Spilling
  if (t.spilledTotal > 0) {
    const worst = [...profile.operators].sort((a, b) =>
      (b.spilledLocal + b.spilledRemote) - (a.spilledLocal + a.spilledRemote))[0];
    items.push({
      sev: 'high', icon: '💧', title: `${formatBytes(t.spilledTotal)} spilled to disk`,
      detail: `Operators ran out of memory and spilled. Worst: <code>${worst.type} (op${worst.id})</code> at ${formatBytes(worst.spilledLocal + worst.spilledRemote)}. Consider a larger warehouse.`,
    });
  }

  // Pruning
  if (t.pruneFraction != null && t.pruneFraction < 0.1 && t.partitionsTotal > 100) {
    items.push({
      sev: 'high', icon: '🗂️', title: `Almost no partition pruning (${formatPct(t.pruneFraction)} pruned)`,
      detail: `${formatCount(t.partitionsScanned)} of ${formatCount(t.partitionsTotal)} micro-partitions were scanned. Filters may not align with clustering keys.`,
    });
  }

  // Slow operators
  const top = topByTime(profile, 3);
  if (top.length && top[0].timePct != null) {
    const list = top.map(op => `<code>${op.type} (op${op.id})</code> ${formatPct(op.timePct)}`).join(', ');
    items.push({
      sev: 'medium', icon: '⏱️', title: `Time concentrated in a few operators`,
      detail: `Top by execution time: ${list}.`,
    });
  }

  // Low cache hit
  if (t.cacheFraction != null && t.cacheFraction < 0.5 && t.bytesScanned > 0) {
    items.push({
      sev: 'low', icon: '📦', title: `Low cache hit (${formatPct(t.cacheFraction)})`,
      detail: `Most data was read from remote storage rather than warehouse cache.`,
    });
  }

  if (items.length === 0) {
    items.push({ sev: 'ok', icon: '✅', title: 'No major red flags', detail: 'No spilling, decent pruning and cache usage.' });
  }

  const wrap = h('div', 'insights');
  for (const it of items) {
    wrap.append(h('div', `insight sev-${it.sev}`, [
      h('div', 'insight-icon', [it.icon]),
      h('div', 'insight-body', [
        h('div', 'insight-title', [it.title]),
        htmlEl('div', 'insight-detail', it.detail),
      ]),
    ]));
  }
  return wrap;
}

/* ---------- time distribution ---------- */
function timeDistribution(profile) {
  const top = topByTime(profile, 8);
  const wrap = h('div', 'timedist');
  if (top.length === 0 || top[0].timePct == null) {
    wrap.append(h('div', 'insight-detail', ['No execution time breakdown available.']));
    return wrap;
  }
  const max = top[0].timePct || 1;
  for (const op of top) {
    const pct = op.timePct || 0;
    const row = h('div', 'timebar-row');
    const label = h('div', 'timebar-label');
    label.innerHTML = `<b>${op.type}</b> op${op.id}`;
    const track = h('div', 'timebar-track');
    const fill = h('div', 'timebar-fill');
    fill.style.width = `${(pct / max) * 100}%`;
    track.append(fill);
    row.append(label, track, h('div', 'timebar-pct', [formatPct(pct)]));
    wrap.append(row);
  }
  return wrap;
}

/* ---------- tiny DOM helpers ---------- */
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
function sectionTitle(text) { return h('div', 'section-title', [text]); }
function meta(items) {
  const wrap = h('div', 'query-meta');
  for (const [label, value, extraCls] of items) {
    const span = extraCls
      ? h('span', null, [h('span', extraCls, [value])])
      : h('span', null, [value]);
    wrap.append(h('div', 'meta-item', [h('label', null, [label]), span]));
  }
  return wrap;
}
function card(label, value, valueCls, sub) {
  const c = h('div', 'card', [
    h('div', 'card-label', [label]),
    h('div', `card-value ${valueCls || ''}`, [value]),
  ]);
  if (sub) c.append(h('div', 'card-sub', [sub]));
  return c;
}
