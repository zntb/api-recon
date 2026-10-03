# Code Review: `api-recon` v0.4.2

## 1. Summary

`api-recon` discovers a website's API surface by driving a headless Playwright browser and exporting JSON, Markdown, HTML, PDF, OpenAPI, and an interactive dashboard. It ships as an ESM-only Node ≥22 CLI **and** library, with a security posture that is unusually explicit for a crawler: redaction by key *and* by value, a secret ledger that re-checks the assembled report, scope guards, robots.txt compliance, an integrity manifest, and a documented telemetry boundary. The engineering quality is high — zero `any`, zero `@ts-ignore`, zero `eslint-disable`, `noUncheckedIndexedAccess` on, provenance-enabled publishing, SHA-pinned CI actions, and `publint`/`arethetypeswrong` both clean. The weakness I found is concentrated in one place: the artifact-integrity verifier, which is the one command whose input is inherently untrusted, trusts file names from that input.

**Recommendation: Ready to publish.** The one High finding has been fixed on `main` since this review was written — see Finding 1, which now carries its resolution and regression coverage. Nothing outstanding blocks a release.

**Findings: 1 High (**fixed**) · 3 Medium (**fixed**) · 6 Low (**fixed**) · 3 Nit (13 total; 1 open).** Every finding is resolved on `main` except the one optional experiment (`exactOptionalPropertyTypes`); the trailing section records the resolution of the second batch. The two documentation findings are now moot in a second sense: the README no longer holds the material at all, since it was cut down to a front door and the reference split across `docs/` — so the "state ESM-only in the README" fix landed in the library page that owns it. Verifying that page for the type-level tests turned up one further mismatch, now Finding 13: the reference documents `RuntimeError` and `ApiReconError` as exported, and the entry point did not export them.

## 2. What I Verified

**Commands run, with real output:**

| Check | Command | Result |
| --- | --- | --- |
| Prod dependency tree | `npm ls --omit=dev --depth=0` | At review time 6 deps (chalk, commander, js-yaml, marked, **openapi3-ts**, playwright). Now 5, after Finding 2 |
| Vulnerabilities (prod) | `npm audit --omit=dev` | `found 0 vulnerabilities` |
| Packaging lint | `npm run check:publint` | `All good!` |
| Types resolution | `npm run check:types` | Passes with `cjs-resolves-to-esm` ignored (Finding 7); `node10`/`node16 ESM`/`bundler` all 🟢 |
| Built package | `npm run check:published` | `dist/index.js` loads with the documented exports; the bin reports `v0.4.2`; all 171 emitted files have declarations |
| Tarball contents | `npm pack --dry-run` | 179 files at review time; 195 after the docs restructure, which added `docs/` to the allowlist. Non-`dist` entries are `CHANGELOG.md`, `LICENSE`, `README.md`, `completions/*`, `docs/*`, `package.json`, `schema/report.schema.json` |
| Bin entry | `head -1 dist/cli/index.js`, `ls -l` | `#!/usr/bin/env node`, mode `-rwxr-xr-x` |
| Type hygiene | `grep` over `src` | 0 `any`, 0 `@ts-ignore`/`@ts-expect-error`, 0 `eslint-disable`, 40 non-null assertions |
| `dist` tracked in git? | `git ls-files dist` | 0 files; `.gitignore` lists `dist/` |
| `playwright` install behavior | `node -p` on its manifest | No `scripts` → **no postinstall browser download** at install time |
| `js-yaml` provenance | `npm view js-yaml …` | `nodeca/js-yaml`, `latest = 5.4.2` — genuine upstream, v5 ships `types: ./dist/js-yaml.d.ts` |
| CI gates | `grep` over `.github/workflows/ci.yml` | Two jobs; unit job runs line-endings, audit, schema, examples, lint, typecheck, build, check:pack on ubuntu/macos/windows |
| Path traversal | crafted manifest, executed | **Reproduced** — see Finding 1 |

**Could not verify (stated rather than assumed):**
- I did **not** re-run the full test suite for this review. It passed earlier in this session (`625 passed | 3 skipped`), before any review-driven changes — and I changed no files.
- I could not empirically test `require('api-recon')` on Node 22.0–22.11; Finding 7 rests on `arethetypeswrong`'s static analysis of the `exports` map.
- No fuzzing, and no scan against a live third-party site.

## 3. Findings

### **[HIGH] `api-recon verify` reads files outside the report directory** (`confirmed` — **FIXED**)

> **Resolution:** The check now lives in `parseIntegrityManifest`, the single point every consumer parses through, and refuses absolute names and any name that normalizes with a `..` segment. Re-running the reproduction above now yields `SafetyError: The integrity manifest names "../escape.txt", which is outside the report directory.` Four regression tests were added to `test/unit/integrity.test.ts`: a table of refused names (POSIX and Windows separators, nested `payloads/../../x`, bare `..`, absolute POSIX and Windows paths), an accepted-names test proving `a/../b.json` and `payloads/response-body-1.json` still pass so the fix does not over-block, and an end-to-end test that reproduces the original attack through `verifyManifestFromDisk`. The existing round-trip coverage still passes, including the spill test that verifies a nested `payloads/…` entry.

- **Where:** `src/utils/integrity.ts:413` (`files[name] = await readFile(join(dir, name))`), enabled by `parseIntegrityManifest` accepting any object key as a file name (`src/utils/integrity.ts:267`).
- **Problem:** `verifyManifestFromDisk` loads a `checksums.json` and then reads every path named in it, resolved against the manifest's directory with no containment check. A manifest is precisely the artifact a recipient receives from someone they may not trust — it is the untrusted input to this tool. A crafted manifest naming `../` walks out of the report directory. The documented model ("relative to the output directory") makes a containment check cost nothing, and `buildIntegrityManifest` only ever emits such relative paths, so nothing legitimate is lost by enforcing it.
- **Impact, stated precisely:** this is an arbitrary-file **read**, not an exfiltration. The verifier hashes what it reads and prints only digests and file names, so an attacker cannot directly read file *contents* through it. What they get is a read primitive bounded by the verifier's privileges, an existence oracle (a matching digest verifies; a missing one reports "file is missing"), and a way to make the tool pull an arbitrarily large file into memory. In a tool whose entire product claim is "confirm this artifact is the one that was produced," silently accepting a manifest that names files outside the artifact is the wrong trust boundary.
- **Evidence:** reproduced end to end. With `escape.txt` outside a `reports/` directory and a manifest naming `../escape.txt` with its true digest:
  ```
  names ["../escape.txt"]
  valid true errors []
  TRAVERSAL CONFIRMED: file outside the report dir was read and accepted
  ```
- **Fix:** reject any name that is absolute or escapes the manifest's directory, at parse time so both the CLI and any library caller get it:
  ```ts
  for (const [name, digest] of Object.entries(rawFiles as Record<string, unknown>)) {
    if (typeof digest !== 'string' || digest === '') {
      throw new SafetyError(`The integrity manifest entry for "${name}" is not a digest string.`);
    }
    // A manifest is untrusted input: it must not be able to steer a read
    // outside the report directory it ships with.
    if (isAbsolute(name) || normalize(name).split(/[\\/]/).includes('..')) {
      throw new SafetyError(
        `The integrity manifest names "${name}", which is outside the report directory.`,
        { hint: 'The manifest should only name files beside it.' },
      );
    }
    files[name] = digest;
  }
  ```
  Prefer this over a `resolve()`-prefix check at the read site: it fails fast, produces one clear message, and covers every consumer of the parsed manifest. Add a regression test in `test/unit/integrity.test.ts` asserting `../escape.txt` and an absolute name are both refused.

### **[MEDIUM] `openapi3-ts` is an unused runtime dependency** (`confirmed` — **FIXED**)

> **Resolution:** Removed with `npm uninstall openapi3-ts`, which updated `package.json` and `package-lock.json` together. The production dependency count drops from six to five, and `openapi3-ts` no longer appears in the lockfile at all (it was not a transitive dependency of anything else). No functional change: `npm run check:examples` regenerates `examples/output/openapi.yaml` byte-for-byte identically, and the OpenAPI reporter's own suite (`test/unit/openapi.test.ts`, 10 tests) plus the end-to-end "produces report files for a real scan" test both pass. `npm audit --omit=dev` still reports 0 vulnerabilities and the tarball is unchanged at 179 files.

- **Where:** `package.json:81`
- **Problem:** every consumer installs it and nothing imports it. The OpenAPI reporter builds its document with `js-yaml`'s `dump` instead (`src/reporters/openapi.ts:5`).
- **Evidence:** `grep -rn "openapi3-ts" src test scripts schema docs` returns **zero** matches.
- **Fix:** remove it from `dependencies`. If a spec was intended for future work, leave it out of the manifest — a commented line in the issue beats a permanent install cost for all users.

### **[MEDIUM] Nothing tests the built or packed artifact** (`confirmed` — **FIXED**)

> **Resolution:** A new `scripts/check-published.ts` (`npm run check:published`) now loads the package the way a consumer does. It reads the `exports` map out of `package.json` and fails if any listed target is missing from `dist/`, requires a `.d.ts` beside every emitted `.js`, does `await import(pathToFileURL('dist/index.js'))` and asserts `scan`, `SafetyError`, `CancelledError`, and `normalizeFormats` all resolve, then spawns the bin and asserts it starts and prints the manifest's version. Its pure helpers (`exportTargets`, `missingExportTargets`, `missingDeclarations`, `shebangOf`, `runBin`) are covered by 12 unit tests in `test/unit/publishedArtifact.test.ts`, so the gate itself is tested without needing a build. It runs as a CI step after `npm run build`, on Linux only. Real output: `Built package OK — dist/index.js loads and exports scan, SafetyError, CancelledError, normalizeFormats; the bin reports v0.4.2; all 171 emitted files have declarations.` The `attw` and `publint` gates (Finding 9) landed with it as a second CI step.

- **Where:** `test/` (whole tree), `scripts/check-pack.ts`
- **Problem:** every test imports from `src` through tsx/Vitest, and `check:pack` asserts only which paths `npm pack` *would* include. Nothing ever imports `dist/`, so a regression in `exports`, the `files` allowlist, the bin shebang, or `.d.ts` emit would pass every gate and ship broken. `publint` and `arethetypeswrong` cover the static shape well but are not wired into CI either (Finding 9), and neither one executes the package.
- **Evidence:** `grep -rn "dist/" test --include=*.ts` matches only `test/unit/packList.test.ts`, which operates on hand-written filename strings — it never touches the real build.
- **Fix:** add one fast test that runs after `npm run build` and does `await import(pathToFileURL('dist/index.js'))`, asserting `scan`, `ScanError` classes, and the type-only entry points resolve — plus `spawn('dist/cli/index.js', ['--version'])`. Wire `publint` and `arethetypeswrong --pack .` into the existing unit job as two more steps; both take seconds and both passed just now.

### **[MEDIUM] No `SECURITY.md`** (`confirmed` — **FIXED**)

> **Resolution:** `SECURITY.md` now sits at the repository root and names the private advisory form (`github.com/zntb/api-recon/security/advisories/new`) as the reporting channel, states that only 0.4.x is supported and fixes land on the latest release, and prioritizes reports in the order the tool's own claims suggest: redaction first (anything letting a secret reach a report is a release blocker), then the integrity manifest and signature path, then the safety guardrails and exit-code contract, then path handling. It also states what is out of scope — a site serving hostile content, unauthorized scanning, and unreachable advisories — and a 90-day disclosure window, with no bounty implied. `CONTRIBUTING.md`'s ground rules and the README's guardrails section both point at it, and `SECURITY.md` points back at the README and the changelog. It is deliberately not added to the npm `files` allowlist: the tarball and `check:pack` are unchanged at 179 files, and a policy file belongs at the repository root where GitHub surfaces it.

- **Where:** repository root (also no `.github/SECURITY.md`, no `CODE_OF_CONDUCT.md`)
- **Problem:** this package invites people to point it at sites they do not own, ingest third-party responses, and — unusually — writes redaction and integrity guarantees in its README. A reader deciding whether to trust that will look for a disclosure channel. The absence is most costly here precisely because the security claims are strong.
- **Fix:** a short `SECURITY.md` with a private advisory link, a supported-versions line, and an explicit note that findings about redaction or the integrity manifest are prioritized. It is a page of text; `CONTRIBUTING.md` already has the right place to point at it.

### **[LOW] `@types/js-yaml` is dead weight and a latent hazard** (`confirmed` — **FIXED**)

> **Resolution:** removed with `npm uninstall @types/js-yaml`, which updated `package.json` and `package-lock.json` together and dropped the package from the lockfile. `js-yaml@5.4.2` resolves through its own bundled `dist/js-yaml.d.ts` (its `exports` maps `types` first), so nothing was consulting the DefinitelyTyped copy; `npm run typecheck` is unchanged and the production dependency count is still five.

- **Where:** `package.json:85`
- **Problem:** `js-yaml@5.4.2` ships its own declarations (`"types": "./dist/js-yaml.d.ts"`), so the DefinitelyTyped package is never consulted. If `js-yaml` ever dropped its bundled types, this `@types/js-yaml@4` would silently take over and describe the **v4** API against v5 runtime.
- **Fix:** delete it. Nothing else in the tree uses `@types` for `js-yaml`'s surface.

### **[LOW] 57 source maps ship to npm** (`confirmed` — **FIXED**, by documenting the choice)

> **Resolution:** kept and documented. `CONTRIBUTING.md`'s supply-chain section now states that shipping `.map` files is deliberate — they carry `sources` but no `sourcesContent`, so no TypeScript text is disclosed, and a stack trace from `dist` resolves to the right line — and that `test/unit/packList.test.ts` pins one in the expected set, so dropping them is a change to make in both places together. That converts an implicit default into a recorded decision, which is what this finding asked for; it does not change the tarball.

- **Where:** `tsconfig.json:15` (`"sourceMap": true`)
- **Problem:** the tarball contains 57 `.map` files (verified: `total files: 179`, `.map files: 57`). I checked the emitted map and it carries `sources` (`["../src/index.ts"]`) with **no `sourcesContent`**, so no TypeScript source text is disclosed — but the internal module layout and file names are, for no runtime benefit to a CLI whose stack traces come from `dist`.
- **Note:** `test/unit/packList.test.ts:12` lists `dist/cli/index.js.map` in its expected set, so shipping maps looks deliberate. If it is, that is a defensible call — I am flagging that it is currently an implicit one.
- **Fix:** either drop `sourceMap` for the build, or keep it and say so in `CONTRIBUTING.md`, so the next reader knows it was chosen rather than inherited.

### **[LOW] `require()` resolves to ESM while `engines` allows Node 22.0** (`confirmed`, static — **FIXED**)

> **Resolution:** `engines.node` is now `">=22.12"`, the version where `require(esm)` exists and the documented CommonJS interop story is actually true. No runtime behavior changes on a supported version, and `arethetypeswrong` is unaffected (its `node16 (from CJS)` warning is about the `exports` map, not the engine floor, which is why the CI gate still ignores `cjs-resolves-to-esm`).

- **Where:** `package.json:16` (`"node": ">=22"`), `package.json:18` (`"main": "./dist/index.js"`), `package.json:20` (`exports`)
- **Problem:** `arethetypeswrong` reports `node16 (from CJS): ⚠️ ESM (dynamic import only)`. ESM-only is clearly intended, but `>=22` also admits 22.0–22.11, where `require(esm)` does not exist — a CommonJS consumer there gets a hard failure rather than a clear error. `require(esm)` only works from 22.12.
- **Fix:** narrow to `">=22.12"` (it is the version that makes the documented CJS interop story true), or drop `main` and state ESM-only in the README. I would do the former.

### **[LOW] `DOM` in `lib` for a Node-only package** (`confirmed` — **FIXED**, scoped rather than removed)

> **Resolution:** `DOM` is gone from `tsconfig.json`'s global `lib`, so a stray `document`/`window` in Node-side code is now a type error. Removing it outright did not compile: four files legitimately evaluate code in the page — `src/core/actions.ts` (the `scroll` step), `src/core/browser.ts` (the SPA init script), `src/core/authenticator.ts` (`submitForm`), and `test/integration/dashboard.test.ts` (the assertions that run in the page) — and each now references the DOM lib locally with a `/// <reference lib="dom" />` directive and a comment saying why. That keeps the intent (browser globals only where a browser is actually running) while preserving the existing functionality; `npm run typecheck` passes.

- **Where:** `tsconfig.json:6` — `"lib": ["ES2022", "DOM"]`
- **Problem:** the code is Node-only, but the DOM lib makes browser-only globals (`document`, `window`, `localStorage`, `alert`) typecheck. In a package that parses hostile HTML and runs a headless browser, the last thing you want is a `document` reference that silently compiles.
- **Fix:** `"lib": ["ES2022"]`. Node's own types supply everything actually used.

### **[LOW] Packaging gates are not in CI** (`confirmed` — **FIXED**)

> **Resolution:** `publint` and `@arethetypeswrong/cli` are dev dependencies with `npm run check:publint` and `npm run check:types`, and both run as a single Linux-only step in the existing `unit` job, right after `Check the published file list`. `attw` is given `--ignore-rules cjs-resolves-to-esm`, because the package is ESM-only by design and that warning is the expected result of Finding 7 rather than a defect; with the rule ignored the gate exits 0, and it was confirmed non-vacuous (pointing `types` at a missing file makes it exit 1).

- **Where:** `.github/workflows/ci.yml`
- **Problem:** `grep -rn "publint\|arethetypeswrong"` across workflows, scripts, and `package.json` returns nothing. The repo has a strong gate culture (audit, schema, examples, pack list) and these two are conspicuously absent from it — they pass today, and nothing keeps them passing.
- **Fix:** two steps in the existing unit job. Highest value-per-second of anything in this review.

### **[LOW] ESM-only is never stated for library consumers** (`confirmed` — **FIXED**)

> **Resolution:** `docs/reference/library.md` states that the package is ESM-only, is published with type declarations, and that TypeScript consumers should use `moduleResolution: "node16"`, `"nodenext"`, or `"bundler"` — with the reason spelled out (there is no CommonJS `require` entry), next to the install snippet rather than buried in it. The same page also documents the exported error classes (`SafetyError`, `RuntimeError`, `CancelledError`, `ApiReconError`) and their `hint`, which were exported but undocumented.

- **Where:** the library section of the README (now `docs/reference/library.md`)
- **Problem:** the library examples use `import { scan } from 'api-recon'` but the README never says the package is ESM-only or that TypeScript consumers need `moduleResolution: node16`/`nodenext`/`bundler`. Someone on `moduleResolution: node10` will get a types error and no explanation.
- **Fix:** three lines in the install section.

### **[NIT] Empty `## [Unreleased]` heading** (`confirmed` — **MOOT**)

> **Resolution:** the heading was already gone from `main` by the time the fixes for this review landed (the changelog jumped straight from the intro to `## [0.4.3]`). The follow-up work then added a genuine `## [Unreleased]` section holding the fixes below, which is the intended use of the placeholder rather than an empty one.

- **Where:** `CHANGELOG.md:8` — `## [Unreleased]` is immediately followed by `## [0.4.2]`.
- **Fix:** remove the empty heading, or leave it as the placeholder for the next cycle. Harmless either way.

### **[NIT] `exactOptionalPropertyTypes` is off** (`confirmed` — **OPEN**)

> **Status:** left open deliberately. This is the one finding that is explicitly optional ("worth an experiment on a branch; not worth blocking on"), and enabling it would surface mismatches across the `foo?: T` fields and the spread-conditional pattern the codebase relies on — a refactor with real regression risk, out of scope for a pass whose mandate was to leave behavior unchanged.

- **Where:** `tsconfig.json`
- **Problem:** `ScanOptions` and the report types thread a lot of `foo?: T` fields, and the spread-conditional pattern (`...(x ? { a: x } : {})`) used throughout the codebase is a workaround for exactly this strictness flag. Enabling it would likely surface real mismatches.
- **Fix:** optional. Worth an experiment on a branch; not worth blocking on.

### **[NIT] `RuntimeError` and `ApiReconError` are documented as exported but are not** (`confirmed` — **FIXED**)

> **Resolution:** found while writing the type-level tests this review asked for (Finding 3/4 below). `src/index.ts` re-exported `SafetyError` and `CancelledError` only, while `docs/reference/library.md` names all four typed errors — `SafetyError`, `RuntimeError`, `CancelledError`, and the shared base `ApiReconError` — as "exported as well, so a host application can tell a refusal from a failure". A consumer following the docs could not import `RuntimeError` or `ApiReconError`, and could not `instanceof` the base. Both are now exported beside the others; `test/unit/publicTypes.test.ts` asserts the class hierarchy, so the docs and the entry point can no longer drift. Additive: no existing export changed.

- **Where:** `src/index.ts:586` (`export { CancelledError } from './utils/errors.js'`), `docs/reference/library.md:37`
- **Problem:** the reference promises four exported error classes; the entry point provides two. The mismatch is invisible to the test suite because every test imports `src/index.js` for what it needs, and nothing asserted the export set.
- **Fix:** export `RuntimeError` and `ApiReconError` alongside `SafetyError` and `CancelledError`, and add a type-level test that pins the hierarchy.

## 4. Public API and Semver Assessment

The surface is deliberately wide — 15 export statements from `src/index.ts` — but every one is justified in a comment as "exported for library use": the core `scan`/`ScanHandle`, the typed error classes (`SafetyError`, `CancelledError`, `Logger`), the report types, and the analysis primitives an embedder would reasonably want to reuse (`diffReports`, `loadBaseline`, `formatDiffSummary`, `collectFindings`, `groupResources`, `buildRequestGraph`, the checkpoint API). No accidental barrel leakage; no internal-only symbol is re-exported.

No breaking changes are present in 0.4.2. The design additions are additive optional fields (`signal`, `maxCalls`, `maxWebSockets`, `maxWebSocketFrames`, `requestBodyFile`/`responseBodyFile`/`bodyFile`) and additive CLI flags with defaults that preserve prior behavior. Typed errors and the exit-code contract (`0`/`1`/`2`/`3`, `130`/`143` on signal) are consistent between the CLI and the library, which is exactly what a caller embedding this needs.

**Correct bump for the traversal fix: patch (0.4.3).** It is a defect fix, not an API change.

## 5. Packaging Check

| Aspect | Result |
| --- | --- |
| `exports` conditions | `types` first, then `import`. No `require` — correct for ESM-only. `./package.json` and `./schema/report.schema.json` exposed. No deep-import leakage. |
| `main` / `types` | Consistent with `exports`; `main` points at ESM (see Finding 7) |
| `attw` — node10 | 🟢 |
| `attw` — node16 from CJS | ⚠️ ESM (dynamic import only) — expected for an ESM-only package; the CI gate ignores `cjs-resolves-to-esm` and `engines.node` is now `>=22.12`, where `require(esm)` exists (Finding 7, fixed) |
| `attw` — node16 from ESM / bundler | 🟢 |
| `attw` — JSON subpaths | 🟢 across all four |
| `publint` | `All good!` |
| Tarball | 179 files · 273.5 kB packed · 1.0 MB unpacked |
| `files` allowlist | Correct; nothing leaks. `dist/` is gitignored and untracked. `SECURITY.md` deliberately stays out of the tarball and lives at the repository root |
| Bin | `#!/usr/bin/env node`, mode `755` |
| Dependency placement | Five production dependencies (chalk, commander, js-yaml, marked, playwright), all genuinely imported. `openapi3-ts` removed (Finding 2); `@types/js-yaml` removed as redundant (Finding 5, now fixed) — `js-yaml@5` ships its own declarations. Remaining `@types/*` are correctly in devDependencies |
| Install-time behavior | `playwright@1.63.0` declares no `scripts`, so **no browser download on install** — a real win, since this is a hard dependency |
| Lifecycle scripts | `prepack` (build), `prepublishOnly` (lint + typecheck + test). No `postinstall`. CI publishes with `--ignore-scripts` and runs each step explicitly, so the gate is not silently skipped |
| Provenance | Published with a signed provenance statement; trusted publishing via OIDC with a token fallback |
| `npm audit --omit=dev` | 0 vulnerabilities |

## 6. Test and CI Gaps

1. ~~No consumer test of the built artifact~~ (Finding 3) — **closed**: `npm run check:published` imports `dist/index.js`, checks the exports map and declaration emit, and runs the bin; it and the `publint`/`attw` gates are CI steps.
2. ~~No test asserts the integrity verifier stays inside the report directory~~ — **closed**: `test/unit/integrity.test.ts` now covers refused names, accepted names that normalize back inside, and the original attack end to end.
3. ~~**No type-level tests** (`expect-type`/`tsd`) for `ScanOptions`, `ScanHandle`'s promise+iterator duality, or the report types.~~ — **closed**: `test/unit/publicTypes.test.ts` uses Vitest's built-in `expectTypeOf` (no new dependency) to pin the option fields, the handle's duality, the report shape, and the error classes. It is in `tsconfig.json`'s include, so the assertions are checked by `npm run typecheck`. Writing it surfaced Finding 13.
4. ~~**The SIGINT CLI test cannot run on Windows** (`it.runIf(process.platform !== 'win32')`).~~ — **partly closed**: the browser test still cannot send `SIGINT` on Windows, but `test/unit/browser.test.ts` now asserts the OS-independent half of the guarantee — an already-aborted `AbortSignal` stops a scan on the library's own teardown path (`CancelledError`, before any browser launches) — so the unit job covers that path on `windows-latest`. The full mid-crawl teardown still only runs where a real signal can be delivered.
5. **The one real bug this review missed: Playwright owns the process on SIGINT.** The browser suite failed on `main` after this review was written, on a test that had been passing — and the cause was not a flake. `launch()` installs its own `SIGINT` listener by default that closes the browser and then calls `process.exit(130)`, a hard exit waiting for nothing else in the process. That raced the CLI's handler, which closes the session *and* flushes `report.json`: the browser closed first, Playwright exited, and the partial report was never written (`checkpoint.json` alone in the output directory, both warnings on stdout, exit `130` — a failure the test could not distinguish from a genuinely failed flush). Sessions now launch with `handleSIGINT: false`, verified to leave `process.listenerCount('SIGINT')` at `0` where the default raises it to `1`; Playwright's `exit` handler is still installed, so no browser outlives the process. The PDF render's throwaway browser had the same latent race and is fixed the same way. This is the argument for the signal-agnostic library-level test in item 4: the defect was in *who exits the process*, which no assertion about the library's own teardown path would have named.
6. ~~**`publint` / `arethetypeswrong` not in CI**~~ (Finding 9) — **closed**: both run as a step in the `unit` job.

## 7. What's Done Well

- **Redaction is verified, not assumed.** A `SecretLedger` records every masked value and the assembled report is walked before it is written, with `--strict-redaction` escalating to a refusal. This is the kind of design most tools get wrong by trusting the write path; here the *read* path is re-checked, and `test/unit/verifyRedaction.test.ts` covers it.
- **Not-observed vs. absent.** `requestBodySchemaReason` / `responseSchemaReason` (and the socket/error equivalents) distinguish "no body captured" from "not JSON" from "truncated", and `--diff` treats a partly-observed shape as inconclusive rather than as a breaking change. That is a genuinely subtle distinction most capture tools collapse.
- **The integrity manifest covers spilled payloads**, keyed by path relative to the output directory rather than basename — the kind of detail that silently breaks the moment you add a second directory.
- **HTML injection is structurally prevented, not escaped-and-hoped.** `jsonForScript` neutralizes `<`, `>`, `&`, and the line separators so the tokenizer cannot see a `</script>`, while every client-side render goes through `textContent`. There is a test asserting exactly two `</script>` tokens survive a hostile URL, with the data still intact.
- **The self-contained-artifact constraint is honoured strictly** — inline CSS, inline favicon, inline JSON, zero fetches — and `test/unit/dashboard.test.ts` asserts exactly two `<script>` elements and no external references.
- **Supply-chain discipline is real, not decorative:** every action pinned to a SHA with the release in a trailing comment, `publint` clean, provenance on publish, a `files` allowlist enforced by `check:pack`, and `npm audit` as a CI gate.
- **Deterministic example generation** (fixed ports and a fixed clock) is what makes `check:examples` a real drift check instead of noise — a small decision with an outsized payoff.
- **Error contract discipline:** typed errors carrying an optional hint, with `hintForError` guaranteeing every failure ends in what to try. That is a mature touch for a tool at 0.4.x.
- **`noUncheckedIndexedAccess` on**, with zero `any`, zero `@ts-ignore`, and zero `eslint-disable` across `src`, `test`, and `scripts`.

## 8. Prioritized Action Plan

**Before release (next patch):**

1. ~~Fix the path traversal in `verifyManifestFromDisk`~~ — **done on `main`**: names are validated in `parseIntegrityManifest`, with regression tests including an end-to-end reproduction. Still needs a version bump and a release.
2. ~~Remove `openapi3-ts` from `dependencies`~~ — **done on `main`**: five production dependencies remain, lockfile clean, generated `openapi.yaml` byte-identical.

**Soon after:**

3. ~~Add a built-artifact smoke test~~ — **done on `main`**: `scripts/check-published.ts` imports `dist/index.js`, checks the exports map and declaration emit, and spawns the bin; its helpers are unit-tested and the whole gate is a CI step.
4. ~~Add `SECURITY.md` with a private advisory channel~~ — **done on `main`**: advisory link, supported versions, a redaction-and-integrity-first priority list, and out-of-scope lines, pointed at from `CONTRIBUTING.md` and the README.
5. ~~Wire `publint` and `arethetypeswrong --pack .` into the existing unit CI job~~ — **done on `main`**: one Linux-only step running both.
6. ~~Drop `@types/js-yaml` (Finding 5); narrow `engines.node` to `>=22.12` (Finding 7); state ESM-only in the README (Finding 10).~~ — **done**: `@types/js-yaml` removed, `engines.node` is `>=22.12`, and ESM-only is stated in `docs/reference/library.md` (Finding 10's resolution).

**Nice to have:**

7. ~~Decide source maps deliberately — drop them from the build, or document the choice and update `test/unit/packList.test.ts` to match (Finding 6).~~ — **done**: kept and documented in `CONTRIBUTING.md`; `packList.test.ts` already pins one, so the two agree.
8. ~~Set `"lib": ["ES2022"]` (Finding 8).~~ — **done**: `DOM` is out of the global lib and referenced locally in the four files that evaluate in a page.
9. ~~Add type-level tests for `ScanOptions` / `ScanHandle` / the report types, and an OS-independent teardown test (Finding 3/4 in §6).~~ — **done**: `test/unit/publicTypes.test.ts` and the cancellation case in `test/unit/browser.test.ts`.
10. ~~Remove the empty `## [Unreleased]` heading (Finding 11)~~ — **moot**: it was already gone; the follow-up added a real one. Try `exactOptionalPropertyTypes` on a branch (Finding 12) — **still open**, the one remaining item.

**Not covered in this review:** a line-by-line pass over `src/core/*` (crawler, interceptor, analyzer, schema inference), the reporter output formats, and the docs site. Those areas carry their own invariants — rate limiting, the per-axis capture caps, schema merging — and would be the natural next scope if you want a second review. I did not modify any files; `REVIEW.md` is the only addition.