/**
 * Minimal RFC-4180 CSV parser.
 * Handles quoted fields, escaped quotes ("") and newlines inside quotes —
 * essential here because Snowflake's JSON columns contain embedded newlines.
 *
 * Returns an array of row objects keyed by the header row.
 */
export function parseCSV(text) {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    // skip fully blank trailing lines
    .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map(r => {
      const obj = {};
      header.forEach((key, i) => { obj[key] = r[i] !== undefined ? r[i] : ''; });
      return obj;
    });
}

/** Parse raw CSV text into an array of string-arrays (rows of fields). */
function parseRows(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  // Normalise newlines so \r\n and \r behave like \n
  const s = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
  }
  // flush trailing field/row (file may not end with newline)
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
