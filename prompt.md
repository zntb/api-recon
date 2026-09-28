**Project:** Build an npm package called **`api-recon`** (working title) — a Node.js CLI + library that discovers a website's APIs by driving a headless browser, simulating user actions, and exporting a categorized report in JSON, Markdown, HTML, PDF, and OpenAPI formats.

### 1. Core Objective

Given a single seed URL, the tool must:

1. Launch a headless Chromium browser via **Playwright**.
2. Optionally authenticate using a saved session, or by performing a scripted login flow.
3. Load the seed page and **crawl same-domain links** up to a configurable depth.
4. During crawling, **intercept all XHR/Fetch traffic** and record request/response metadata.
5. Optionally run an **interactive recording mode** where a human drives the browser while the tool captures traffic.
6. Analyze the captured traffic to categorize endpoints and infer schemas.
7. Emit reports in **JSON, Markdown, HTML, PDF, and OpenAPI 3.0**.
8. Enforce safety guardrails: `robots.txt` compliance, rate limiting, and sensitive-header redaction.

### 2. Tech Stack & Deliverables

- **Runtime:** Node.js 22+ (ESM).
- **Browser automation:** Playwright (`playwright` package, Chromium only by default).
- **CLI framework:** `commander` or `yargs`.
- **HTML→PDF:** `puppeteer` (headless Chrome) or Playwright's built-in `page.pdf()`.
- **Markdown templating:** `ejs` or plain template literals.
- **OpenAPI generation:** hand-rolled generator or `openapi3-ts` for types.
- **Testing:** `vitest` or `jest` with a local mock server (e.g., `http-server` + fixtures).
- **Packaging:** Publishable to npm with `bin` entry (`api-recon`) and a programmatic `main` export.

Deliverables:

- Full source tree with clear folder structure (`src/cli`, `src/core`, `src/reporters`, `src/utils`).
- `package.json` with scripts: `build`, `test`, `lint`, `start`.
- `README.md` with usage examples for both CLI and library.
- At least one integration test using a local fixture site.
- Sample output files in a `examples/` directory.

### 3. Functional Requirements

**3.1 Input**

- CLI accepts a single seed URL: `api-recon https://example.com`
- Optional flags:
  - `--depth <n>` (default 1) — same-domain crawl depth.
  - `--max-pages <n>` (default 25) — hard cap.
  - `--out <dir>` (default `./api-recon-output`).
  - `--formats <list>` (default `json,md,html,pdf,openapi`).
  - `--auth <file>` — path to a Playwright `storageState.json`.
  - `--login <file>` — path to a login-flow config (see 3.3).
  - `--record` — launch interactive recording mode.
  - `--actions <file>` — path to an actions config for scripted interaction.
  - `--rate <ms>` (default 500) — minimum delay between requests to the same origin.
  - `--respect-robots` (default true).
  - `--include-third-party` (default false) — capture cross-origin calls too.
  - `--redact` (default true) — redact `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`.

**3.2 Crawling**

- Collect same-domain links from `<a href>` and SPA route changes (`history.pushState` / `popstate`).
- Normalize URLs to avoid duplicates (strip fragments, sort query params).
- Respect `--depth` and `--max-pages`.
- Fetch and parse `/robots.txt` before crawling; skip disallowed paths when `--respect-robots` is true.

**3.3 Authentication**

- **Saved session mode:** load a Playwright `storageState.json` via `browser.newContext({ storageState })`.
- **Scripted login mode:** read a JSON/YAML config describing the flow, e.g.:

```yaml
loginUrl: https://example.com/login
steps:
  - fill: { selector: "#email", value: "${ENV_USER}" }
  - fill: { selector: "#password", value: "${ENV_PASS}" }
  - click: "#submit"
  - waitForURL: "**/dashboard"
saveStateTo: ./session.json
```

- Support environment variable substitution for credentials (never hardcode secrets).
- After login, persist the session so subsequent runs can reuse it via `--auth`.

**3.4 Network Interception**

- Listen on `page.on('request')` and `page.on('response')`.
- Capture only `resourceType === 'xhr' || 'fetch'` by default.
- For each call, record:
  - URL (normalized), method, status, MIME type.
  - Request headers (redacted by default), request body (if any).
  - Response headers, response body (if JSON and under a size cap, e.g. 1 MB).
  - Timing (start, duration).
  - The page/URL that triggered it.
- Deduplicate identical `(method, URL pattern, status)` tuples but keep a count and one sample payload.

**3.5 Interactive Recording Mode**

- `--record` launches a **headed** browser and prints instructions to the console.
- The user browses/clicks/fills freely while the tool captures traffic.
- Pressing `Ctrl+C` (or typing `done` in the terminal) ends the session and writes the report.
- The recorded session must still respect redaction settings.

**3.6 Scripted Actions**

- `--actions <file>` runs a YAML/JSON list of steps, e.g.:

```yaml
- scroll: { to: bottom }
- click: "button.load-more"
- wait: 2000
- fill: { selector: "input[name=q]", value: "test" }
- submit: "form#search"
```

- Each step must be resilient to timeouts and log failures without aborting the whole run.

**3.7 Analysis & Categorization**

Group captured endpoints into categories using heuristics:

- **Authentication** — URLs matching `/login`, `/auth`, `/oauth`, `/token`, `/session`.
- **Data Fetching** — GET requests returning JSON.
- **Mutations** — POST/PUT/PATCH/DELETE.
- **Analytics/Telemetry** — hosts like `google-analytics.com`, `segment.io`, `mixpanel.com`, or URLs containing `/track`, `/collect`, `/beacon`.
- **Third-party** — anything cross-origin (only included when `--include-third-party`).
- **Uncategorized** — fallback bucket.

For each endpoint, infer:

- Path parameters (segments that look like IDs: UUIDs, numeric IDs).
- Query parameters (names and sample values).
- Request body schema (basic JSON shape inference).
- Response body schema (basic JSON shape inference, capped depth 4).

**3.8 Tech Stack Detection (Bonus)**

Reuse the earlier conversation's fingerprinting logic: detect CMS, frameworks, CDNs, and analytics from headers, HTML meta tags, script paths, and cookies. Include a "Detected Technologies" section in the report.

### 4. Report Generation

Emit all enabled formats into `--out`:

- **`report.json`** — raw structured data (the source of truth).
- **`report.md`** — human-readable summary with sections:
  1. Overview (seed URL, crawl stats, timestamp).
  2. Detected Technologies.
  3. Endpoint Summary by Category (table: method, path, status, count).
  4. Detailed Endpoints (with sample request/response, redacted).
  5. Authentication Flows Observed.
  6. Third-party Calls (if enabled).
  7. Safety Notes (robots.txt status, rate-limit info).
- **`report.html`** — styled version of the Markdown (use a lightweight CSS).
- **`report.pdf`** — rendered from the HTML via Puppeteer/Playwright.
- **`openapi.yaml`** — best-effort OpenAPI 3.0 spec from inferred paths, methods, params, and schemas.

Redaction rule: if `--redact` is on, replace sensitive header values with `[REDACTED]` in every output format.

### 5. Safety & Ethics (Non-negotiable)

- Default to respecting `robots.txt`; warn and require `--force` to bypass.
- Enforce `--rate` between requests to the same origin.
- Cap response body storage (default 1 MB) and total crawl size.
- Never persist credentials to disk unless the user explicitly runs `--login` with `saveStateTo`.
- Print a clear banner on first run explaining acceptable use.
- Refuse to run against `localhost` unless `--allow-local` is passed (prevents accidental self-scanning).

### 6. Library API

Expose a programmatic interface:

```javascript
import { scan } from 'api-recon';

const result = await scan({
  url: 'https://example.com',
  depth: 2,
  formats: ['json', 'md', 'openapi'],
  auth: './session.json',
  actions: './actions.yaml',
  redact: true,
  respectRobots: true,
});

console.log(result.endpoints);
await result.writeReports('./out');
```

### 7. Project Structure (Suggested)

```
api-recon/
├── src/
│   ├── cli/index.js
│   ├── core/
│   │   ├── browser.js
│   │   ├── crawler.js
│   │   ├── interceptor.js
│   │   ├── authenticator.js
│   │   ├── actions.js
│   │   ├── analyzer.js
│   │   ├── techStack.js
│   │   └── schemaInference.js
│   ├── reporters/
│   │   ├── json.js
│   │   ├── markdown.js
│   │   ├── html.js
│   │   ├── pdf.js
│   │   └── openapi.js
│   ├── utils/
│   │   ├── url.js
│   │   ├── redact.js
│   │   ├── robots.js
│   │   └── rateLimit.js
│   └── index.js
├── examples/
├── test/
├── package.json
└── README.md
```

### 8. Acceptance Criteria

The build is considered complete when:

1. `api-recon https://<test-site> --depth 2 --formats json,md,html,pdf,openapi` produces all five files in `./api-recon-output`.
2. Running with `--auth ./session.json` correctly captures authenticated API calls.
3. `--record` allows interactive browsing and captures traffic until the user quits.
4. Sensitive headers are redacted in every output format by default.
5. `robots.txt` is respected and violations require `--force`.
6. The library API (`import { scan } from 'api-recon'`) returns a structured result and can write reports.
7. An integration test against a local fixture site passes in CI.

### 9. What NOT to Do

- Do not attempt to bypass authentication, CAPTCHAs, or bot protections.
- Do not capture or store credentials in plaintext.
- Do not attack, fuzz, or brute-force any endpoint.
- Do not include code that circumvents paywalls or access controls.
- The tool is for **observation and documentation**, not exploitation.

---
