# Authentication and interaction

Two mechanisms for an authenticated app, both credential-safe, plus two ways to
make the page actually do something before the capture is taken.

## Saved session

Anything you saved with Playwright, or that `--login` produced:

```bash
api-recon https://app.example.com --auth ./session.json
```

## Scripted login

A YAML/JSON flow with `${ENV_VAR}` substitution. Values are read from the
environment, never logged, and never written to reports:

```yaml
loginUrl: https://app.example.com/login
steps:
  - fill: { selector: '#email', value: '${APP_USER}' }
  - fill: { selector: '#password', value: '${APP_PASS}' }
  - click: 'button[type="submit"]'
  - waitForURL: '**/dashboard'
saveStateTo: ./session.json   # optional: reuse later with --auth
```

Supported steps: `fill`, `click`, `submit`, `waitForURL`, `waitForSelector`,
`waitForTimeout`. The flow is validated before the browser opens: an unknown
step, a missing field, or the wrong type fails with the offending path and line
(`steps[1].fill.value`), and a YAML syntax error names its line and column — so
a typo costs a moment, not a run.

Credential handling is deliberate. A session written because of `saveStateTo`
is saved owner-only (`chmod 600`), since it holds live cookies; an `--auth` file
that is group- or world-readable is flagged with a warning on startup; and
nothing is persisted unless `saveStateTo` asks for it — passing `--auth` reads a
session but never rewrites it.

The [authenticated SPA cookbook recipe](../cookbook/authenticated-spa.md) walks
through both mechanisms on a real app shape.

## Scripted actions

Run interaction steps on every crawled page to surface lazy-loaded endpoints:

```yaml
- wait: 500
- scroll: { to: bottom }
- click: 'button.load-more'
- wait: 1000
- fill: { selector: 'input[name="q"]', value: 'widget' }
- submit: 'form#search'
```

Supported steps: `click`, `fill`, `submit`, `wait`, `waitForSelector`,
`scroll` (`{ to: top|bottom }` or a selector), `navigate`, `press`. A step that
fails at run time (a selector that is not there) logs a warning and the crawl
continues — but a *malformed* step is rejected before the browser opens, naming
its path and line, so a typo is never silently skipped.

The file may be a bare list of steps or `{ "steps": [ … ] }`.

## Interactive record mode

```bash
api-recon https://app.example.com --record
```

A headed browser opens; browse, click, log in — every XHR/fetch call is
captured. Type `done` + Enter (or press Ctrl+C) to finish and write the report.
Redaction settings still apply.

Automation hooks: `API_RECON_HEADLESS=1` runs record mode headless,
`API_RECON_TELEMETRY=1` enables telemetry, and
`API_RECON_RECORD_AUTOSTOP_MS=<ms>` ends the session automatically.
