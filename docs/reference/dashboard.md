# Dashboard

`dashboard.html` is the report you actually work in. Open it in any browser —
no server, no build step:

```bash
api-recon https://example.com --formats dashboard --out ./reports
open ./reports/dashboard.html
```

- **Search** across paths, methods, categories, status codes, hosts, params,
  MIME types, and the pages that triggered each call.
- **Group** by category, resource, or change kind. Each group gets a
  collapsible header with its count, and a left-hand nav lists the groups with
  per-group counts while you are grouped — so a hundred endpoints read as a
  handful of sections instead of one long table. Search and filters still apply,
  and a group only shows the rows that pass them.
- **Filter** by category, HTTP method, and status code.
- **Sort** by any column; the default order is discovery order.
- **Expand** a row for its headers, query and path params, and the inferred
  request/response schemas — rendered from the sampled bodies. WebSocket rows
  expand to their frames and inferred sent/received message schemas instead.
- **Diff** — with `--diff`, a Change column and "Changed only" / "Breaking only"
  filters appear. Without a baseline they are omitted entirely rather than
  shown empty.
- **Removed endpoints stay visible** — an endpoint that existed in the baseline
  and not in this scan has no row in the current report, so the dashboard
  reconstructs one from the diff. It appears struck through on a red row, sorts
  and searches like any other, and there is a `Removed (baseline)` filter to
  isolate the endpoints that disappeared. Only such rows carry no request or
  response detail, and they say so instead of showing empty sections.
- **Findings at a glance** — when the report carries findings, the summary tiles
  show their counts coloured by severity and a panel lists every cue, so the
  things to act on are the first thing you see.
- **Keyboard and screen reader** — `/` focuses search, the arrow keys move
  between rows, and Enter/Space expands the focused one. Every sortable header
  is a button, so the sort order can be set from the keyboard, and each header
  announces its direction (`aria-sort`). Rows name the endpoint they expand and
  point at the detail they open (`aria-controls`); the result count is a live
  region; each summary tile is labelled; and the table's scroll box takes focus,
  so a long table can be scrolled without a mouse.
- **Mobile** — on a phone-sized screen the table becomes a stack of cards, one
  per endpoint, each cell labelled with the column it belongs to, so an endpoint
  is read top to bottom instead of scrolled sideways. The summary strip folds to
  two columns and nothing overflows the viewport.
- **Dark mode** — the theme follows `prefers-color-scheme`, so the page darkens
  with the rest of your desktop rather than flashing white.
- **Sticky table** — the header row and the method column stay pinned while you
  scroll a long report.
- **Prints like `report.html`** — a print stylesheet drops the interactive
  controls and unpins the table, so the dashboard prints as a readable report.

It is a single self-contained file: all CSS, the report JSON, and the rendering
script are inlined, so nothing is fetched at open time and it works from
`file://`, from a CI artifact, or on a machine with no network. Scanned values
are written to the DOM as text, never as HTML, so a target site cannot inject
markup into its own report — and the embedded payload is the same redacted
report as `report.json`.

Use `report.md` / `report.html` / `report.pdf` when you need something to send
someone; use `dashboard.html` when you need to find something. Both a plain and
a diffed dashboard are committed under
[`examples/output/`](https://github.com/zntb/api-recon/tree/main/examples/output).
