# Sample output

Reports generated from the bundled fixture site (`test/fixtures/server.ts`).

| File | Format |
| --- | --- |
| `report.json` | machine-readable source of truth |
| `report.md` | human-readable summary |
| `report.html` | styled standalone page |
| `openapi.yaml` | best-effort OpenAPI 3.0 spec |

`report.pdf` is intentionally absent: PDF rendering needs Chromium, which is not
available in every environment. Run the command below somewhere Chromium works
and it will be produced too.

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
