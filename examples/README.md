# Examples

Runnable inputs for `api-recon`, plus a sample report generated from the
bundled fixture site.

| File | What it shows |
| --- | --- |
| `login.yaml` | Scripted login flow with `${ENV_VAR}` credentials and `saveStateTo` |
| `actions.yaml` | Interaction steps: wait, scroll, click, fill, submit |
| `output/` | A real report captured from `test/fixtures` (all five formats) |

## Reproduce the sample output

Fastest path (no Chromium needed — drives the fixture over HTTP through the
real analyzer and reporters):

```bash
npm run examples:generate
```

Or capture it with the full browser pipeline against the local fixture site:

```bash
# 1. Start the fixture site (terminal 1)
npm run test:server

# 2. Scan it and write the sample outputs (terminal 2)
mkdir -p examples/output
node dist/cli/index.js http://127.0.0.1:4599 \
  --allow-local --depth 2 --rate 100 \
  --actions test/fixtures/actions.json \
  --out examples/output

# 3. Optional: scripted login against the fixture
export FIXTURE_USER=demo@example.com
export FIXTURE_PASS=hunter2
export FIXTURE_BASE_URL=http://127.0.0.1:4599
node dist/cli/index.js http://127.0.0.1:4599 \
  --allow-local --login test/fixtures/login.yaml --out examples/output
```

The fixture exposes `/api/products` (data fetching), `/api/search` (mutations),
`/api/login` + `/api/user` + `/api/orders` (authentication), a same-origin
`/api/collect` beacon (analytics), a cross-origin partner endpoint (third-party,
only captured with `--include-third-party`), and `/api/graphql` (GraphQL). The
`/websocket` page opens a live `/ws` socket, so the sample report includes
WebSocket traffic too.
