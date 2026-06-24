/**
 * Turns parsed CSV rows (from GET_QUERY_OPERATOR_STATS) into a structured
 * profile model: normalized operators, the DAG, and aggregate metrics.
 */
import { parseCSV } from './csv.js';

/** Safe JSON parse for the VARIANT columns (returns {} on empty/invalid). */
function parseJSON(s) {
  if (s == null || s === '') return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function num(v) { return typeof v === 'number' ? v : 0; }

/**
 * Parse a full CSV profile string.
 * @returns {{ queryId, operators, byId, roots, steps, totals }}
 */
export function parseProfile(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) throw new Error('CSV appears to be empty.');

  const required = ['QUERY_ID', 'OPERATOR_ID', 'OPERATOR_TYPE'];
  for (const col of required) {
    if (!(col in rows[0])) {
      throw new Error(`Missing expected column "${col}". Is this a GET_QUERY_OPERATOR_STATS export?`);
    }
  }

  const operators = rows.map(normalizeOperator);
  // OPERATOR_ID is unique per STEP, not per query — key everything by "step:id".
  const byId = new Map(operators.map(op => [op.uid, op]));
  const roots = operators.filter(op => op.parents.length === 0).map(op => op.uid);

  // Steps: group operator ids by STEP_ID
  const steps = new Map();
  for (const op of operators) {
    if (!steps.has(op.stepId)) steps.set(op.stepId, []);
    steps.get(op.stepId).push(op.id);
  }

  const queryId = operators.length ? operators[0].queryId : null;
  const totals = computeTotals(operators);

  return { queryId, operators, byId, roots, steps, totals };
}

/** Normalize one CSV row into a flat operator object. */
function normalizeOperator(r) {
  const stats = parseJSON(r.OPERATOR_STATISTICS);
  const time = parseJSON(r.EXECUTION_TIME_BREAKDOWN);
  const attrs = parseJSON(r.OPERATOR_ATTRIBUTES);
  const parents = parseJSON(r.PARENT_OPERATORS);
  const stepId = Number(r.STEP_ID);
  const id = Number(r.OPERATOR_ID);

  const io = stats.io || {};
  const pruning = stats.pruning || {};
  const spilling = stats.spilling || {};
  const network = stats.network || {};
  const dml = stats.dml || {};

  return {
    queryId: r.QUERY_ID,
    stepId,
    id,
    uid: `${stepId}:${id}`,
    // parent operator ids are step-local → store both raw id and composite uid
    parents: Array.isArray(parents) ? parents.map(Number) : [],
    parentUids: Array.isArray(parents) ? parents.map(pid => `${stepId}:${pid}`) : [],
    type: r.OPERATOR_TYPE,

    // row flow
    inputRows: stats.input_rows ?? null,
    outputRows: stats.output_rows ?? null,

    // io
    bytesScanned: num(io.bytes_scanned),
    bytesWritten: num(io.bytes_written),
    cacheFraction: io.percentage_scanned_from_cache ?? null,
    scanProgress: io.scan_progress ?? null,

    // pruning
    partitionsScanned: pruning.partitions_scanned ?? null,
    partitionsTotal: pruning.partitions_total ?? null,

    // spilling
    spilledLocal: num(spilling.bytes_spilled_local_storage),
    spilledRemote: num(spilling.bytes_spilled_remote_storage),

    // network
    networkBytes: num(network.network_bytes),

    // dml
    rowsInserted: num(dml.number_of_rows_inserted),
    rowsUpdated: num(dml.number_of_rows_updated),
    rowsDeleted: num(dml.number_of_rows_deleted),

    // time
    timePct: time.overall_percentage ?? null,
    timeBreakdown: time,

    // attributes (table names, conditions, functions…)
    attributes: attrs,

    // keep raw blobs for the (future) raw-data tab
    raw: { stats, time, attrs },
  };
}

/** Roll operator stats up into query-wide totals. */
function computeTotals(operators) {
  const t = {
    operatorCount: operators.length,
    bytesScanned: 0,
    bytesWritten: 0,
    spilledLocal: 0,
    spilledRemote: 0,
    networkBytes: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    partitionsScanned: 0,
    partitionsTotal: 0,
    // weighted cache hit: sum(cache% * bytesScanned) / sum(bytesScanned)
    _cacheWeighted: 0,
  };

  for (const op of operators) {
    t.bytesScanned += op.bytesScanned;
    t.bytesWritten += op.bytesWritten;
    t.spilledLocal += op.spilledLocal;
    t.spilledRemote += op.spilledRemote;
    t.networkBytes += op.networkBytes;
    t.rowsInserted += op.rowsInserted;
    t.rowsUpdated += op.rowsUpdated;
    t.rowsDeleted += op.rowsDeleted;
    if (op.partitionsTotal != null) {
      t.partitionsScanned += op.partitionsScanned || 0;
      t.partitionsTotal += op.partitionsTotal;
    }
    if (op.cacheFraction != null && op.bytesScanned > 0) {
      t._cacheWeighted += op.cacheFraction * op.bytesScanned;
    }
  }

  t.spilledTotal = t.spilledLocal + t.spilledRemote;
  t.rowsProduced = t.rowsInserted + t.rowsUpdated + t.rowsDeleted;
  t.cacheFraction = t.bytesScanned > 0 ? t._cacheWeighted / t.bytesScanned : null;
  t.pruneFraction = t.partitionsTotal > 0
    ? 1 - t.partitionsScanned / t.partitionsTotal
    : null;
  delete t._cacheWeighted;
  return t;
}

/**
 * Determine what the query "produced", which depends on its shape:
 *  - DML (CTAS / INSERT / UPDATE / DELETE) → rows written, from the dml stats.
 *  - SELECT → rows returned, = the Result operator's input_rows
 *    (the final operator outputs 0 rows; its INPUT is the result set).
 * @returns {{ label: string, value: number|null }}
 */
export function queryResult(profile) {
  const dmlOp = profile.operators.find(op => op.rowsInserted || op.rowsUpdated || op.rowsDeleted);
  if (dmlOp) {
    if (dmlOp.rowsInserted) return { label: 'Rows Written', value: dmlOp.rowsInserted };
    if (dmlOp.rowsUpdated) return { label: 'Rows Updated', value: dmlOp.rowsUpdated };
    if (dmlOp.rowsDeleted) return { label: 'Rows Deleted', value: dmlOp.rowsDeleted };
  }
  const result = profile.operators.find(op => op.type === 'Result');
  if (result) return { label: 'Rows Returned', value: result.inputRows ?? 0 };
  return { label: 'Rows', value: null };
}

/** Whether the query performs DML (CTAS/INSERT/UPDATE/DELETE/MERGE). */
export function isDML(profile) {
  return profile.operators.some(op => op.rowsInserted || op.rowsUpdated || op.rowsDeleted);
}

/** Top N operators by execution time %, excluding pure-DDL/root noise. */
export function topByTime(profile, n = 8) {
  return [...profile.operators]
    .filter(op => op.timePct != null && op.type !== 'CREATE TABLE')
    .sort((a, b) => (b.timePct || 0) - (a.timePct || 0))
    .slice(0, n);
}
