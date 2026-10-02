# Security Policy

`api-recon` observes other people's sites. It drives a real browser against a
seed URL, reads whatever that site serves, and writes the result to disk — so it
is worth saying plainly how to report a problem with it and what happens next.

## Reporting a vulnerability

Please report privately through GitHub's advisory form rather than opening a
public issue:

**<https://github.com/zntb/api-recon/security/advisories/new>**

That opens a private advisory visible only to the maintainer until it is
published. If you would rather not use GitHub, email the maintainer listed in
the repository's commit log.

Please include the version (`api-recon --version`), what the tool did, and a
report or manifest that reproduces it if you have one. A report directory under
`--out` is enough — the scan is reproducible from the command line, and
`--debug` produces `debug/partial-report.json` for a run that failed.

**Redact before you attach.** The tool masks secrets it can recognize, but a
report can still hold data the site returned. Scan a site you are allowed to
scan, and check what you are about to share.

You can expect an acknowledgement within a few days and an assessment with a
planned fix or an explanation within two weeks.

## What gets prioritized

Reports are triaged in this order:

1. **Redaction.** Anything that lets a secret reach a report — a value the
   redactors miss, a mask that is written back unmasked, or a field the
   `SecretLedger` does not cover — is treated as a release blocker.
2. **The integrity manifest.** `api-recon verify` and the `--checksum` /
   `--sign-key` path are the tool's claim that a report is the one that was
   produced. A manifest that accepts a file it should reject, or a signature
   check that can be bypassed, is the same severity.
3. **The safety guardrails.** Scope enforcement (`--include-host`,
   `--exclude-path`), `--allow-local`, and the exit-code contract (`0` / `1` /
   `2` / `3`, `130` / `143` on a signal). A guard that can be talked past by a
   hostile site is the class of bug this tool is most careful about.
4. **Path handling.** The output directory, the checkpoint, spilled payloads, and
   every file a flag names.
5. **Everything else**, including injection into the generated HTML, in order of
   impact.

Findings that need a fix ship as a patch release. See
[`CHANGELOG.md`](CHANGELOG.md) for what changed in each version.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.4.x | ✅ |
| < 0.4 | ❌ |

Fixes land on the latest release. If you are pinned to an older version,
upgrading is the fix.

## Scope

In scope: anything in this repository, the published npm package, and the
artifacts a scan writes.

Out of scope:

- **A site that serves hostile content.** The tool renders whatever the seed
  page returns inside a browser; that is what it was pointed at. Report a crash
  or an unsafe write, not the fact that the content was hostile.
- **Unauthorized scanning.** Point the tool only at sites you own or have
  permission to test. `robots.txt` compliance, rate limiting, and the scope
  guards are on by default for a reason — turning them off to reach a site is
  not a vulnerability.
- **Dependabot alerts with no reachable path.** Transitive advisories in a
  development-only dependency are still worth an issue; a critical advisory
  against `playwright` or `js-yaml` is a release blocker.

## Responsible disclosure

Please give the maintainer a reasonable window to ship a fix before disclosing
publicly — 90 days from the acknowledgement, or until the fix is released,
whichever comes first. There is no bug bounty for this project.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the ground rules that apply to
changes, and [`README.md`](README.md#safety-guardrails) for what the tool
refuses to do on its own.
