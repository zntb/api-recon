# Sample output

Reports generated from the bundled fixture site (`test/fixtures/server.ts`).

| File | Format |
| --- | --- |
| `report.json` | machine-readable source of truth |
| `report.md` | human-readable summary |
| `report.html` | styled standalone page |
| `openapi.yaml` | best-effort OpenAPI 3.0 spec |
| `dashboard.html` | interactive dashboard (search, filter, sort, expand) |
| `dashboard-diff.html` | the same dashboard run against a baseline, with the Change column |

`report.pdf` is intentionally absent: PDF rendering needs Chromium, which is not
available in every environment. Run the command below somewhere Chromium works
and it will be produced too.

`dashboard-diff.html` shows what a scan looks like when compared against an
earlier one: a Change column, "Changed only" and "Breaking only" filters, and
the removed endpoint (`GET /api/legacy/orders`) rendered as a struck-through red
row you can still search, filter, and expand. The current half of that report is
the same real capture as `report.json`; only the baseline is simulated, so the
example does not need a second crawl. To produce a genuine one, keep a report
and diff against it:

```bash
api-recon https://example.com --out ./now --formats dashboard,json
api-recon https://example.com --out ./later --diff ./now/report.json --formats dashboard
```

## How these were generated

`npm run examples:generate` drives the fixture server over plain HTTP and feeds
the **real** responses through the same analyzer and reporters the tool uses, so
the endpoints, status codes, headers, inferred schemas, categorization, and
redaction are genuine. Only the browser interception layer is simulated.

To capture the same surface with the real browser pipeline:

```bash
npm run test:server                     # terminal 1
node dist/cli/index.js http://127.0.0.1:4599 \
  --allow-local --depth 2 --rate 100 \
  --actions test/fixtures/actions.json \
  --include-third-party --out examples/output   # terminal 2
```

With no `--auth`, `/api/user`, `/api/orders`, and `/api/orders/{id}` are
recorded with `401`; add the fixture login flow to see the authenticated `200`s:

```bash
export FIXTURE_USER=demo@example.com FIXTURE_PASS=hunter2
export FIXTURE_BASE_URL=http://127.0.0.1:4599
node dist/cli/index.js http://127.0.0.1:4599 \
  --allow-local --login test/fixtures/login.yaml --out examples/output
```
