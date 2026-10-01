# api-recon documentation

**Discover a website's APIs by driving a real browser.** Give it one seed URL;
it crawls (or you drive it interactively), records every XHR/fetch call and
WebSocket frame, infers schemas, categorizes the endpoints, and writes a report
in JSON, Markdown, HTML, PDF, and OpenAPI 3.0.

The [README](https://github.com/zntb/api-recon#readme) is the reference for every
flag and option. This site is the part you read when you have a specific app in
front of you and want the shortest path to a good report.

## Start here

```bash
npm install -g api-recon
npx playwright install chromium

# Look at one page — no crawl, no slow PDF render
api-recon https://example.com --preset quick

# A bounded, quiet scan for a pipeline
api-recon https://app.example.com --preset ci
```

`api-recon --help` lists every flag, and `api-recon completion bash` (or `zsh`,
`fish`) teaches your shell to complete them.

## Cookbook

| Recipe | Use it when |
| --- | --- |
| [Authenticated SPA](cookbook/authenticated-spa.md) | The APIs only appear after logging in, and routing happens client-side |
| [GraphQL](cookbook/graphql.md) | The app talks to one `/graphql` endpoint and you want the operations, not the URL |
| [WebSockets](cookbook/websocket.md) | Real-time traffic is where the interesting contract lives |
| [CI gate](cookbook/ci-gate.md) | You want a build to fail when the API surface changes |
| [Troubleshooting FAQ](faq.md) | A scan found nothing, refused to run, or you need a bug report |

## How a scan works

1. **Guardrails first.** robots.txt is fetched and enforced, the rate limiter is
   set from it, and localhost/private ranges are refused unless `--allow-local`
   says otherwise.
2. **A real browser** loads the pages. Same-origin links are followed to
   `--depth`, cross-origin calls are ignored unless `--include-third-party`.
3. **Every XHR/fetch and WebSocket is captured** — method, URL, status, redacted
   headers, body samples, timing, and the page that triggered it. Secrets are
   scrubbed at capture time, not at report time.
4. **Calls are grouped into endpoints** by `(method, URL pattern, status)`, then
   categorized, and JSON schemas are inferred and merged across samples.
5. **Reporters** derive every format from the one JSON report, so the formats
   cannot disagree.

Two behaviors are worth internalizing early, because they explain most surprises:

- **A scan samples the traffic the crawl happened to trigger.** "Not seen this
  time" is not proof an endpoint is gone; the diff says so in as many words.
- **Redaction is on by default**, so what you see in a report is already the safe
  version. Review it before sharing all the same.
