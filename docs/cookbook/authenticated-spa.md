# Scan an authenticated SPA

A single-page app is the case that breaks naive crawlers. There are no server
rendered links to follow, the interesting APIs only answer after a login, and
the URL changes without a page load. `api-recon` handles all three, but it needs
a little help from you for the login.

## 1. Describe the login once

A **scripted login** is a small YAML file. Credentials are read from the
environment with `${VAR}` substitution and are never logged or written into a
report.

```yaml
# flows/login.yaml
loginUrl: https://app.example.com/login
steps:
  - fill: { selector: '#email', value: '${APP_USER}' }
  - fill: { selector: '#password', value: '${APP_PASS}' }
  - click: 'button[type="submit"]'
  - waitForURL: '**/dashboard'
saveStateTo: ./session.json
```

The steps are `fill`, `click`, `submit`, `waitForURL`, `waitForSelector`, and
`waitForTimeout`. `submit` calls the form's native submit, so a site that
validates a button click still works. `saveStateTo` persists the cookies and
localStorage so later runs do not have to log in again.

```bash
APP_USER=you@example.com APP_PASS='…' \
  api-recon https://app.example.com --login flows/login.yaml --depth 2
```

> If the app logs you out between runs, the session file is a credential. Keep
> it out of version control and off shared machines. `api-recon` only writes it
> when `saveStateTo` asks.

## 2. Reuse the session

```bash
api-recon https://app.example.com --auth ./session.json --depth 2 \
  --out ./reports
```

`--auth` takes a Playwright `storageState.json`, which is also what
`saveStateTo` produces — so the two halves are the same file.

## 3. Let the SPA change routes

Client-side navigation (`history.pushState` / `replaceState` / `popstate`) is
recorded, so the pages the app visits in place are followed like real links up
to `--depth`. If a route is reached only through a click, drive that click with
`--actions`:

```yaml
# flows/actions.yaml
- wait: 500
- scroll: { to: bottom }        # trigger lazy-loaded widgets
- click: 'button.load-more'     # paginate
- wait: 1000
- click: 'a[href="/settings"]'  # a route with no visible link on load
```

```bash
api-recon https://app.example.com --auth ./session.json \
  --depth 2 --actions flows/actions.yaml
```

Actions run on every crawled page and are resilient: a missing selector logs a
warning and the crawl continues.

## 4. When clicks are too fiddly, record

If the flow is hard to script — a modal, an OAuth redirect — record it by hand:

```bash
api-recon https://app.example.com --record
```

A headed browser opens; browse normally and click through the app. Every
XHR/fetch call is captured. Type `done` and press Enter (or press Ctrl+C) to
finish, and the same report is written as any other run.

## Putting it together

```bash
# First run: log in and keep the session
APP_USER=you@example.com APP_PASS='…' \
  api-recon https://app.example.com \
  --login flows/login.yaml --depth 2 --actions flows/actions.yaml \
  --formats json,md,dashboard --out ./reports

# Later runs: reuse the session
api-recon https://app.example.com --auth ./session.json \
  --depth 2 --actions flows/actions.yaml --out ./reports
```

## Reading the report

- `authentication` endpoints are the login and token calls; they are the ones to
  check for overly broad responses.
- `/api/...` entries under `data-fetching` are the app's read surface. Their
  inferred schemas are merged across every sample the crawl saw.
- The **Page → request graph** (in `report.md` and the dashboard) shows which
  route triggered which call, which is usually how you find a missing one.
- If a route never appears, it was not exercised — add an action for it, or scan
  it directly as the seed: `api-recon https://app.example.com/settings --auth …`.

See also: [GraphQL](graphql.md) for an app whose whole API is one endpoint, and
the [FAQ](../faq.md) when a page loads but no calls show up.
