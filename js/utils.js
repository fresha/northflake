/** Shared formatting helpers. */

/** Bytes → human readable (1.23 GB). */
export function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`;
}

/** Row counts → 1.2K / 3.4M / 5.6B. */
export function formatRows(n) {
  if (n == null) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}

/** Full count with thousands separators (1,234,567). */
export function formatCount(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

/** Fraction (0..1) → percentage string. */
export function formatPct(frac, digits = 1) {
  if (frac == null) return '—';
  return `${(frac * 100).toFixed(digits)}%`;
}
