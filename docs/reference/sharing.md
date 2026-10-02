# Sharing a report

## Share-safe mode

`report.json`, `report.md`, `report.html`, and `dashboard.html` all keep
*redacted* samples — a request body, a header, a socket frame. That is what you
want for yourself, and not what you want in a ticket, a chat, or a shared drive:
redaction masks the secrets it recognizes and leaves everything else. `--share`
writes a different artifact instead:

```bash
api-recon https://example.com --share --out ./reports
# ./reports/share.md — one page, paste it into a ticket
```

`share.md` is built only from request patterns, categories, status codes, call
counts, and inferred schemas. It is safe by construction rather than by
redaction: the reporter never reads a request or response body, a header, a
query value, a socket frame, a page URL, or an origin, so the output cannot leak
what the scan saw. Finding *details* are omitted too, because the verbose-error
cue quotes a slice of an error body. `--share` replaces the whole format set — a
full report is never written beside it — and a `--print` in the same run prints
the summary rather than the sampled report.

`share` is also an ordinary format, if you want the summary in a pipe rather
than a file:

```bash
api-recon https://example.com --print share > ticket.md
api-recon https://example.com --formats share --out ./reports
```

## Report integrity

A report attached to a ticket or uploaded as a CI artifact can be edited on the
way. `--checksum` writes a `checksums.json` beside the reports that records a
digest of each one, so a recipient can recompute it and confirm the bytes are
the ones the scan wrote:

```bash
api-recon https://example.com --checksum --out ./reports
api-recon verify ./reports/checksums.json
```

A plain checksum proves the files were not changed, but not who wrote the
manifest — anyone can edit a report and the manifest that covers it. Add
`--sign-key <file>` to sign the manifest with an HMAC held in a file, so a
recipient with the same key can also confirm the manifest came from the scan:

```bash
api-recon https://example.com --checksum sha512 --sign-key ./report.key --out ./reports
api-recon verify ./reports/checksums.json --sign-key ./report.key
```

`verify` exits `0` when every file matches (and the signature checks, if the
manifest is signed) and `2` otherwise, so a pipeline can fail on it. It launches
no browser and does no network work:

```console
$ api-recon verify ./reports/checksums.json
✓ Integrity OK — 6 file(s) match the sha256 manifest.
```

The manifest names the digest algorithm, the time it was written, the tool name
and version, and a digest per file — the artifact-to-run link the npm provenance
attestation gives the published tarball. It never covers itself, and the digests
are computed over the files on disk, so they describe exactly what a recipient
receives. It also covers the files under `<out>/payloads/`, so a spilled body
cannot be swapped for another one of the same length. Off by default.

A manifest is untrusted input — it is the artifact a recipient receives from
someone they may not know — so `verify` refuses any entry that is an absolute
path or that climbs out of the report directory with `..`. A manifest that
names `../../etc/passwd` fails as a `SafetyError` (exit `2`) before anything is
opened. Names that stay inside are unaffected, including a nested `payloads/…`
entry.
