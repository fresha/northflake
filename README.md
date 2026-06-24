# Northflake

A client-side web application for analyzing **Snowflake** query profiles. Load a CSV
export of [`GET_QUERY_OPERATOR_STATS()`](https://docs.snowflake.com/en/sql-reference/functions/get_query_operator_stats)
and get a visual breakdown of operator performance — bottlenecks, spilling, partition
pruning, cache usage and per-operator statistics.

Sibling app to [NorthStar](../northstar) (which does the same for StarRocks), sharing its
Nord theme and look & feel.

## Features

### Overview
- **Query summary** — query type (SELECT / CTAS / INSERT / …), operator count, and rows
  returned/written (resolved from the query shape, not a single raw field).
- **Key metrics** — bytes scanned / written / spilled, weighted cache-hit %, partition
  pruning %, network bytes.
- **Insights** — auto-flagged issues: disk spilling, poor partition pruning, time
  concentrated in a few operators, low cache hit.
- **Where time goes** — top operators by execution time %.

### Operators
- Browse every operator with **type filters** (colour-coded by family), **search**
  (table name, join/filter condition, operator id) and **sort** (time %, output rows,
  bytes scanned, spill, operator id).
- **Type-aware cards** — each operator shows only the metrics it actually reports
  (a TableScan shows pruning/cache; a Join shows row flow + spill + condition), with the
  key attribute inline and the full attribute set on expand.

## Usage

1. Serve the folder (ES modules require http, not `file://`):
   ```bash
   python -m http.server 8000
   ```
2. Open `http://localhost:8000`, then drag a query-profile CSV onto the drop zone or click
   **Load Profile**.
3. Toggle dark/light with the sun/moon button.

### Getting a profile CSV from Snowflake

```sql
SELECT * FROM TABLE(GET_QUERY_OPERATOR_STATS('<query_id>'));
```
Export the result as CSV and load it into Northflake.

## Tech Stack

- **Vanilla JavaScript** (ES6 modules) — no build tools, no dependencies
- **HTML5** / **CSS3**, **Nord** colour palette, `JetBrains Mono`

## Project Structure

```
northflake/
├── index.html              # shell: header, tabs, drop-zone, panels
├── css/styles.css          # Nord theme + components
├── js/
│   ├── main.js             # entry: file loading, drag/drop, tab nav
│   ├── theme.js            # dark/light toggle
│   ├── csv.js              # RFC-4180 CSV parser (handles quoted newlines)
│   ├── profileParser.js    # CSV rows → operator model + DAG + aggregates
│   ├── utils.js            # formatting helpers
│   ├── overviewRender.js   # Overview tab
│   └── operatorsRender.js  # Operators explorer tab
└── northflake.svg          # logo / favicon
```

## License

MIT
