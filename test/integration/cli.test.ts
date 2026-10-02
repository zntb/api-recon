/** CLI end-to-end tests: spawn the real CLI against the local fixture site. */

import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../fixtures/server.js';
import { browserAvailable } from '../helpers/browser.js';
import { buildIntegrityManifest } from '../../src/utils/integrity.js';

const exec = promisify(execFile);
const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');
// Run the TypeScript entrypoint through Node itself. Spawning the tsx shell
// shim works on POSIX but fails on Windows, where .cmd files cannot be spawned
// without a shell. The loader is resolved from this file rather than by name,
// because a bare `--import tsx` resolves against the *spawned* process's working
// directory — and one of these tests runs the CLI from a temporary project.
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const NODE_TSX_ARGS = ['--import', TSX_LOADER, CLI_ENTRY];
// The credential the fixture site accepts, and the value the login flow's
// `${FIXTURE_PASS}` substitution reads from the environment.
const FIXTURE_PASS = 'hunter2';

let fixture: FixtureServerHandle;
let outDir: string;
let canRunBrowser = false;

// The help/guard tests run without a browser; these two need a real one.
const NEEDS_BROWSER = [
  'produces report files',
  'diffs',
  'stores a baseline',
  'debug bundle',
  'telemetry',
  'progress',
  'config',
  'preset',
  'print',
  '--open',
  '--share',
  'checksums.json',
];

beforeEach((ctx) => {
  if (!canRunBrowser && NEEDS_BROWSER.some((name) => ctx.task.name.includes(name))) {
    ctx.skip();
  }
});

beforeAll(async () => {
  canRunBrowser = await browserAvailable();
  fixture = await startFixtureServer({ port: 0, thirdPartyPort: 0 });
  outDir = await mkdtemp(join(tmpdir(), 'api-recon-cli-'));
});

afterAll(async () => {
  await fixture.close();
  await rm(outDir, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [...NODE_TSX_ARGS, ...args], {
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('api-recon CLI', () => {
  it('documents every flag in --help', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    for (const flag of [
      '--depth',
      '--max-pages',
      '--max-calls',
      '--max-sockets',
      '--max-frames',
      '--out',
      '--formats',
      '--auth',
      '--login',
      '--browser',
      '--record',
      '--actions',
      '--diff',
      '--fail-on-diff',
      '--rate',
      '--include-third-party',
      '--include-host',
      '--exclude-path',
      '--force',
      '--allow-local',
      '--telemetry',
      '--telemetry-preview',
      '--quiet',
      '--verbose',
      '--json-progress',
      '--config',
      '--no-config',
      '--preset',
      '--open',
      '--print',
      '--share',
      '--strict-redaction',
      '--checksum',
      '--sign-key',
      '--timeout',
      '--resume',
    ]) {
      expect(stdout, `--help should mention ${flag}`).toContain(flag);
    }
    // The presets document themselves in --help, not only in the README.
    for (const preset of ['quick', 'deep', 'ci']) {
      expect(stdout, `--help should describe the ${preset} preset`).toContain(preset);
    }
    // Every report format is advertised as a default, the dashboard included.
    for (const format of ['json', 'md', 'html', 'pdf', 'openapi', 'dashboard']) {
      expect(stdout, `--help should mention the ${format} format`).toContain(format);
    }
    // The subcommands document themselves too.
    for (const command of ['baseline', 'completion', 'verify']) {
      expect(stdout, `--help should list the ${command} command`).toContain(command);
    }
  }, 60_000);

  it('generates a completion script per shell, and refuses an unknown one', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const { code, stdout, stderr } = await runCli(['completion', shell]);
      expect(code, `${shell}: ${stdout}${stderr}`).toBe(0);
      // Built from the live program, so real flags and their values are present.
      expect(stdout, shell).toContain('api-recon');
      expect(stdout, shell).toContain('browser');
      expect(stdout, shell).toContain('chromium firefox webkit');
      expect(stdout, shell).toContain('baseline');
      expect(stdout, shell).toContain('completion');
    }

    const unknown = await runCli(['completion', 'powershell']);
    expect(unknown.code).toBe(2);
    expect(`${unknown.stdout}${unknown.stderr}`).toMatch(/Unknown shell "powershell"/);
    expect(`${unknown.stdout}${unknown.stderr}`).toMatch(/→/);
  }, 60_000);

  it('refuses localhost without --allow-local, and prints what to try next', async () => {
    const { code, stdout, stderr } = await runCli([
      fixture.url,
      '--depth',
      '0',
      '--rate',
      '0',
      '--out',
      join(outDir, 'guard'),
    ]);
    expect(code).toBe(2);
    expect(`${stdout}${stderr}`).toMatch(/allow-local/);
    // A safety refusal ends in a next step, not only a message.
    expect(`${stdout}${stderr}`).toMatch(/→.*--allow-local/);
  }, 60_000);

  it('writes a debug bundle with logs, a trace, and a partial report on failure', async () => {
    const projDir = join(outDir, 'cli-debug', 'project');
    await mkdir(projDir, { recursive: true });
    // A login flow to a dead port fails after the browser has launched, so the
    // bundle has a real trace and a partial report beside the captured log.
    const login = join(projDir, 'login.yaml');
    await writeFile(
      login,
      'loginUrl: http://127.0.0.1:1/\nsteps:\n  - waitForTimeout: 1\n',
      'utf8',
    );
    const out = join(projDir, 'out');

    const { code, stdout, stderr } = await runCli(
      [
        fixture.url,
        '--allow-local',
        '--depth',
        '0',
        '--rate',
        '0',
        '--quiet',
        '--login',
        login,
        '--debug',
        '--out',
        out,
        '--formats',
        'json',
      ],
      {},
      projDir,
    );

    expect(code, `${stdout}${stderr}`).toBe(1);
    const all = `${stdout}${stderr}`;
    expect(all).toMatch(/→/);
    expect(all).toContain('Debug bundle written to');

    const debugDir = join(out, 'debug');
    expect((await readFile(join(debugDir, 'logs.txt'), 'utf8')).length).toBeGreaterThan(0);
    const partial = JSON.parse(await readFile(join(debugDir, 'partial-report.json'), 'utf8')) as {
      schemaVersion: number;
      meta: { seedUrl: string };
    };
    expect(partial.schemaVersion).toBeGreaterThan(0);
    expect(partial.meta.seedUrl).toBe(fixture.url);
    // A real Playwright archive, not an empty placeholder file.
    expect((await readFile(join(debugDir, 'trace.zip'))).length).toBeGreaterThan(0);
  }, 180_000);

  it('verifies an integrity manifest, and fails when a report was edited', async () => {
    const dir = join(outDir, 'cli-integrity-verify');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.json'), '{"endpoints":[]}', 'utf8');
    await writeFile(join(dir, 'share.md'), '# API surface\n', 'utf8');
    const manifestPath = join(dir, 'checksums.json');
    await writeFile(
      manifestPath,
      JSON.stringify(
        buildIntegrityManifest({
          files: { 'report.json': '{"endpoints":[]}', 'share.md': '# API surface\n' },
        }),
        null,
        2,
      ),
      'utf8',
    );

    // A clean directory verifies.
    const ok = await runCli(['verify', manifestPath]);
    expect(ok.code, `${ok.stdout}${ok.stderr}`).toBe(0);
    expect(`${ok.stdout}${ok.stderr}`).toContain('Integrity OK');

    // An edit to a covered file is a failure, so CI can gate on it.
    await writeFile(join(dir, 'report.json'), '{"endpoints":[{"injected":true}]}', 'utf8');
    const bad = await runCli(['verify', manifestPath]);
    expect(bad.code).toBe(2);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/checksum mismatch/);
  }, 60_000);

  it('writes a checksums.json for --checksum and verifies it', async () => {
    const dir = join(outDir, 'cli-checksum');
    const scanned = await runCli([
      fixture.url,
      '--allow-local',
      '--depth',
      '0',
      '--rate',
      '0',
      '--checksum',
      '--formats',
      'json,md',
      '--out',
      dir,
      '--quiet',
    ]);
    expect(scanned.code, `${scanned.stdout}${scanned.stderr}`).toBe(0);

    const manifest = JSON.parse(await readFile(join(dir, 'checksums.json'), 'utf8')) as {
      algorithm: string;
      files: Record<string, string>;
    };
    expect(manifest.algorithm).toBe('sha256');
    expect(Object.keys(manifest.files).sort()).toEqual(['report.json', 'report.md']);

    const verified = await runCli(['verify', join(dir, 'checksums.json')]);
    expect(verified.code, `${verified.stdout}${verified.stderr}`).toBe(0);
    expect(`${verified.stdout}${verified.stderr}`).toContain('Integrity OK');
  }, 150_000);

  it('produces report files for a real scan', async () => {
    const dir = join(outDir, 'cli-scan');
    const { code, stdout } = await runCli([
      fixture.url,
      // Exercises the --browser flag end to end: through commander's validator,
      // into scan(), and out to a real Playwright launch.
      '--browser',
      'chromium',
      '--allow-local',
      '--depth',
      '1',
      '--rate',
      '0',
      '--out',
      dir,
      '--formats',
      'json,md',
      '--quiet',
    ]);
    expect(stdout).toBeTruthy();
    expect(code).toBe(0);

    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
      endpoints: { id: string }[];
    };
    expect(report.endpoints.some((e) => e.id === 'GET /api/products')).toBe(true);
    const md = await readFile(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('# API recon report');
  }, 150_000);

  it('writes only a share-safe summary with --share', async () => {
    const dir = join(outDir, 'cli-share');
    const { code, stdout, stderr } = await runCli([
      fixture.url,
      '--allow-local',
      '--depth',
      '1',
      '--rate',
      '0',
      // The login flow is what puts a secret in the capture, so the summary's
      // silence about it proves no sample was carried rather than that none
      // existed.
      '--login',
      'test/fixtures/login.yaml',
      '--out',
      dir,
      '--share',
      '--quiet',
    ], { FIXTURE_BASE_URL: fixture.url, FIXTURE_USER: 'demo@example.com', FIXTURE_PASS });
    expect(code, stdout + stderr).toBe(0);

    // --share replaces the whole format set: only the summary is written.
    const summary = await readFile(join(dir, 'share.md'), 'utf8');
    expect(summary).toContain('# API surface —');
    expect(summary).toContain('| Method | Path | Category | Status | Calls |');
    await expect(readFile(join(dir, 'report.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(dir, 'report.html'), 'utf8')).rejects.toThrow();

    // No body, header, or frame: not the secret, not the redaction placeholder
    // the full report would keep in its place.
    expect(summary).not.toContain(FIXTURE_PASS);
    expect(summary).not.toContain('connect.sid=');
    expect(summary).not.toContain('[REDACTED]');
  }, 150_000);

  it('writes telemetry only when the flag or env enables it', async () => {
    const host = new URL(fixture.url).host;
    const base = [fixture.url, '--allow-local', '--depth', '0', '--rate', '0', '--formats', 'json', '--quiet'];

    // Off by default: no telemetry.json next to the reports.
    const offDir = join(outDir, 'cli-telemetry-off');
    const off = await runCli([...base, '--out', offDir]);
    expect(off.code).toBe(0);
    await expect(readFile(join(offDir, 'telemetry.json'), 'utf8')).rejects.toThrow();

    // The flag writes it, and it carries no host or path.
    const flagDir = join(outDir, 'cli-telemetry-flag');
    const flagged = await runCli([...base, '--telemetry', '--out', flagDir]);
    expect(flagged.code).toBe(0);
    const raw = await readFile(join(flagDir, 'telemetry.json'), 'utf8');
    expect((JSON.parse(raw) as { version: number }).version).toBe(1);
    expect(raw).not.toContain(host);

    // API_RECON_TELEMETRY=1 does the same without the flag.
    const envDir = join(outDir, 'cli-telemetry-env');
    const viaEnv = await runCli([...base, '--out', envDir], { API_RECON_TELEMETRY: '1' });
    expect(viaEnv.code).toBe(0);
    await expect(readFile(join(envDir, 'telemetry.json'), 'utf8')).resolves.toContain('"version": 1');

    // --telemetry-preview prints the payload to stdout and writes no file.
    const previewDir = join(outDir, 'cli-telemetry-preview');
    const preview = await runCli([...base, '--telemetry-preview', '--out', previewDir]);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain('Telemetry preview (not written to disk):');
    expect(preview.stdout).toContain('"signals"');
    expect(preview.stdout).toContain('No host, path, query values, headers, or bodies');
    expect(preview.stdout).not.toContain(host);
    await expect(readFile(join(previewDir, 'telemetry.json'), 'utf8')).rejects.toThrow();
  }, 300_000);

  it('diffs a scan against a baseline and exits 3 on changes with --fail-on-diff', async () => {
    const dir = join(outDir, 'cli-diff');
    const baseArgs = [fixture.url, '--allow-local', '--depth', '1', '--rate', '0', '--quiet'];

    // 1. A real scan becomes the baseline.
    const first = await runCli([...baseArgs, '--out', dir, '--formats', 'json']);
    expect(first.code).toBe(0);

    // 2. Mutate it so there is definitely something to find: a response field
    //    the next scan cannot produce, and an endpoint it does produce.
    const baselineReport = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
      endpoints: { id: string; responseSchema: { properties?: Record<string, unknown> } | null }[];
    };
    const products = baselineReport.endpoints.find((e) => e.id === 'GET /api/products');
    expect(products, 'baseline should contain GET /api/products').toBeDefined();
    products!.responseSchema!.properties!['legacyField'] = { type: 'string' };
    baselineReport.endpoints = baselineReport.endpoints.filter((e) => e.id !== 'POST /api/collect');

    const baseline = join(dir, 'baseline.json');
    await writeFile(baseline, JSON.stringify(baselineReport), 'utf8');

    // 3. Diff a fresh scan against it. --fail-on-diff turns the finding into an
    //    exit code, which is the part CI needs.
    const diffDir = join(dir, 'out');
    const { code, stdout, stderr } = await runCli([
      ...baseArgs,
      '--out',
      diffDir,
      '--formats',
      'json,md',
      '--diff',
      baseline,
      '--fail-on-diff',
    ]);

    expect(code, `expected exit 3 (diff found)\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(3);
    expect(stdout).toContain('API changes since baseline');

    const diffed = JSON.parse(await readFile(join(diffDir, 'report.json'), 'utf8')) as {
      diff?: {
        hasChanges: boolean;
        changes: { id: string; kind: string; breaking: boolean; details: string[] }[];
      };
    };
    expect(diffed.diff, 'report.json should carry the diff').toBeDefined();
    expect(diffed.diff!.hasChanges).toBe(true);

    const added = diffed.diff!.changes.find((c) => c.id === 'POST /api/collect');
    expect(added?.kind, 'deleted from the baseline, so it is an addition').toBe('added');
    expect(added!.breaking).toBe(false);

    const changed = diffed.diff!.changes.find((c) => c.id === 'GET /api/products');
    expect(changed?.kind).toBe('changed');
    expect(changed!.breaking, 'a vanished response field is breaking').toBe(true);
    expect(changed!.details.join(' ')).toContain('legacyField');

    const md = await readFile(join(diffDir, 'report.md'), 'utf8');
    expect(md).toContain('## 9. Changes Since Baseline');
    expect(md).toContain('legacyField');
  }, 240_000);

  it('streams live progress as JSON when asked, and draws nothing when piped', async () => {
    const dir = join(outDir, 'cli-progress');
    const base = [fixture.url, '--allow-local', '--depth', '1', '--rate', '0', '--formats', 'json'];

    const { code, stdout } = await runCli([...base, '--out', dir, '--json-progress']);
    expect(code).toBe(0);

    const events = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const progress = events.filter((event) => event['event'] === 'progress');
    expect(progress.length, `expected progress events, got:\n${stdout}`).toBeGreaterThan(0);
    // The first event is emitted before any page loads; the crawl then reports
    // as it goes; and the run ends in the analyzing phase with final counts.
    expect(progress[0]!['phase']).toBe('crawling');
    expect(progress[0]!['pagesVisited']).toBe(0);
    expect(progress.some((event) => event['phase'] === 'analyzing')).toBe(true);

    const done = events[events.length - 1]!;
    expect(done['event']).toBe('done');
    expect(done['phase']).toBe('analyzing');
    expect(done['pagesVisited']).toBeGreaterThan(0);
    expect(done['endpoints']).toBeGreaterThan(0);
    expect(done['calls']).toBeGreaterThan(0);
    expect(done['maxPages']).toBeGreaterThan(0);

    // But a consumer of a machine format should never receive cursor tricks.
    expect(stdout).not.toContain('\u001b[');

    // Without the flag the run is piped and quiet: no table, no JSON.
    const plain = await runCli([...base, '--out', join(outDir, 'cli-progress-off')]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toMatch(/^\{"event"/m);
  }, 150_000);

  it('takes flags from a project config file, with the CLI and the environment above it', async () => {
    const projDir = join(outDir, 'cli-config', 'project');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, '.api-reconrc'),
      JSON.stringify({
        depth: 0,
        rate: 0,
        allowLocal: true,
        quiet: true,
        formats: ['json'],
        out: 'reports',
      }),
      'utf8',
    );

    const pagesVisited = async (): Promise<number> => {
      const report = JSON.parse(
        await readFile(join(projDir, 'reports', 'report.json'), 'utf8'),
      ) as { meta: { pagesVisited: number } };
      return report.meta.pagesVisited;
    };

    // 1. The config alone: depth 0 from the file, and output relative to it.
    const plain = await runCli([fixture.url], {}, projDir);
    expect(plain.code, `${plain.stdout}${plain.stderr}`).toBe(0);
    expect(await pagesVisited()).toBe(1);

    // 2. A flag beats the config.
    const withFlag = await runCli([fixture.url, '--depth', '1'], {}, projDir);
    expect(withFlag.code).toBe(0);
    expect(await pagesVisited()).toBeGreaterThan(1);

    // 3. The environment beats the config too.
    await writeFile(join(projDir, 'reports', 'report.json'), '{"meta":{"pagesVisited":0}}', 'utf8');
    const withEnv = await runCli([fixture.url], { API_RECON_DEPTH: '1' }, projDir);
    expect(withEnv.code).toBe(0);
    expect(await pagesVisited()).toBeGreaterThan(1);

    // 4. --no-config ignores it — and then nothing allows a local scan.
    const ignored = await runCli([fixture.url, '--no-config'], {}, projDir);
    expect(ignored.code).toBe(2);
    expect(`${ignored.stdout}${ignored.stderr}`).toMatch(/allow-local/);
  }, 300_000);

  it('applies a preset over the config file, and rejects a name that is not one', async () => {
    const projDir = join(outDir, 'cli-preset', 'project');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, '.api-reconrc'),
      JSON.stringify({
        depth: 2,
        maxPages: 10,
        rate: 0,
        allowLocal: true,
        quiet: true,
        formats: ['json'],
        out: 'reports',
      }),
      'utf8',
    );

    // The config crawls; --preset quick has to beat it to mean anything.
    const quick = await runCli([fixture.url, '--preset', 'quick'], {}, projDir);
    expect(quick.code, `${quick.stdout}${quick.stderr}`).toBe(0);
    const report = JSON.parse(
      await readFile(join(projDir, 'reports', 'report.json'), 'utf8'),
    ) as { meta: { pagesVisited: number } };
    expect(report.meta.pagesVisited).toBe(1);

    const unknown = await runCli([fixture.url, '--preset', 'turbo'], {}, projDir);
    expect(unknown.code).toBe(2);
    expect(`${unknown.stdout}${unknown.stderr}`).toMatch(/Unknown preset "turbo"\. Available presets: quick/);
  }, 240_000);

  it('prints the chosen report to stdout and keeps the commentary on stderr', async () => {
    const dir = join(outDir, 'cli-print');
    const base = [fixture.url, '--allow-local', '--depth', '0', '--rate', '0'];

    // 1. The default is Markdown, and stdout must hold nothing else — that is
    //    what makes `api-recon <url> --print > report.md` safe.
    const md = await runCli([...base, '--formats', 'json', '--out', dir, '--print'], { NO_COLOR: '1' });
    expect(md.code, md.stderr).toBe(0);
    expect(md.stdout.startsWith('# API recon report')).toBe(true);
    expect(md.stdout).toContain('## 1. Overview');
    expect(md.stdout).not.toContain('Scan complete in');
    expect(md.stderr).toContain('Scan complete in');

    // 2. Any of the text formats, and JSON parses as the report itself. The
    //    products page is the one that calls the API the assertion looks for.
    const json = await runCli([
      `${fixture.url}/products`,
      ...base.slice(1),
      '--formats',
      'json',
      '--out',
      dir,
      '--print',
      'json',
    ]);
    expect(json.code, json.stderr).toBe(0);
    const report = JSON.parse(json.stdout) as { endpoints: { id: string }[]; schemaVersion: number };
    expect(report.schemaVersion).toBeGreaterThan(0);
    expect(report.endpoints.some((endpoint) => endpoint.id === 'GET /api/products')).toBe(true);

    // 3. A format that belongs in a file rather than a pipe is refused.
    const refused = await runCli([...base, '--out', dir, '--print', 'pdf']);
    expect(refused.code).toBe(2);
    expect(`${refused.stdout}${refused.stderr}`).toMatch(
      /--print: expected one of md, json, openapi, html/,
    );
  }, 300_000);

  it('writes the dashboard for --open and says where it is when it cannot launch', async () => {
    const dir = join(outDir, 'cli-open');
    const { code, stdout, stderr } = await runCli(
      // Only json was asked for, but --open needs the dashboard to exist.
      [fixture.url, '--allow-local', '--depth', '0', '--rate', '0', '--formats', 'json', '--out', dir, '--open'],
      { API_RECON_NO_OPEN: '1' },
    );

    expect(code, stderr).toBe(0);
    await expect(readFile(join(dir, 'dashboard.html'), 'utf8')).resolves.toContain(
      'API recon dashboard',
    );
    // Suppressed opening still tells the user where the file is.
    expect(`${stdout}${stderr}`).toMatch(/Open it yourself: .*dashboard\.html/);
  }, 240_000);

  it('stores a baseline and resolves --diff latest against it', async () => {
    const projDir = join(outDir, 'cli-baseline', 'project');
    await mkdir(projDir, { recursive: true });
    const baseArgs = [fixture.url, '--allow-local', '--depth', '1', '--rate', '0', '--quiet'];
    const stored = join(projDir, '.api-recon', 'baseline.json');

    // 1. `baseline` writes the canonical file, with no path named by the user.
    const captured = await runCli(
      ['baseline', ...baseArgs, '--out', join(projDir, 'baseline-out'), '--formats', 'json'],
      {},
      projDir,
    );
    expect(captured.code, `${captured.stdout}${captured.stderr}`).toBe(0);
    expect(captured.stdout).toContain('Compare against it later with `--diff latest`.');

    const baselineReport = JSON.parse(await readFile(stored, 'utf8')) as {
      schemaVersion: number;
      endpoints: { id: string }[];
    };
    expect(baselineReport.schemaVersion).toBeGreaterThan(0);
    expect(baselineReport.endpoints.some((e) => e.id === 'GET /api/products')).toBe(true);

    // 2. Mutate the stored baseline so the comparison has something to find.
    baselineReport.endpoints = baselineReport.endpoints.filter((e) => e.id !== 'POST /api/collect');
    await writeFile(stored, JSON.stringify(baselineReport), 'utf8');

    // 3. `--diff latest` finds that file and gates on it.
    const diffDir = join(projDir, 'latest-out');
    const diffed = await runCli(
      [
        ...baseArgs,
        '--out',
        diffDir,
        '--formats',
        'json',
        '--diff',
        'latest',
        '--fail-on-diff',
      ],
      {},
      projDir,
    );
    expect(diffed.code, `expected exit 3\n${diffed.stdout}`).toBe(3);
    expect(diffed.stdout).toContain('API changes since baseline');

    const report = JSON.parse(await readFile(join(diffDir, 'report.json'), 'utf8')) as {
      diff?: { hasChanges: boolean; changes: { id: string; kind: string }[] };
    };
    expect(report.diff?.hasChanges).toBe(true);
    expect(report.diff?.changes.find((c) => c.id === 'POST /api/collect')?.kind).toBe('added');
  }, 300_000);

  it('stores a baseline at an overridden path and reads it back with --baseline', async () => {
    const projDir = join(outDir, 'cli-baseline-override', 'project');
    await mkdir(projDir, { recursive: true });
    const custom = join(projDir, 'baselines', 'api.json');
    const baseArgs = [fixture.url, '--allow-local', '--depth', '1', '--rate', '0', '--quiet'];

    // 1. --baseline names the file instead of the canonical location.
    const captured = await runCli(
      ['baseline', ...baseArgs, '--baseline', custom, '--out', join(projDir, 'out1'), '--formats', 'json'],
      {},
      projDir,
    );
    expect(captured.code, `${captured.stdout}${captured.stderr}`).toBe(0);
    await expect(readFile(join(projDir, '.api-recon', 'baseline.json'), 'utf8')).rejects.toThrow();

    const stored = JSON.parse(await readFile(custom, 'utf8')) as {
      endpoints: { id: string }[];
    };
    expect(stored.endpoints.some((e) => e.id === 'GET /api/products')).toBe(true);

    // 2. Mutate it, then `--diff latest --baseline` reads the same file.
    stored.endpoints = stored.endpoints.filter((e) => e.id !== 'POST /api/collect');
    await writeFile(custom, JSON.stringify(stored), 'utf8');

    const out2 = join(projDir, 'out2');
    const diffed = await runCli(
      [...baseArgs, '--baseline', custom, '--diff', 'latest', '--fail-on-diff', '--out', out2, '--formats', 'json'],
      {},
      projDir,
    );
    expect(diffed.code, `${diffed.stdout}${diffed.stderr}`).toBe(3);

    const report = JSON.parse(await readFile(join(out2, 'report.json'), 'utf8')) as {
      diff?: { changes: { id: string; kind: string }[] };
    };
    expect(report.diff?.changes.find((c) => c.id === 'POST /api/collect')?.kind).toBe('added');
  }, 300_000);

  it('names the overridden path when --diff latest cannot find a baseline', async () => {
    const projDir = join(outDir, 'cli-baseline-override-missing');
    await mkdir(projDir, { recursive: true });

    const { code, stderr } = await runCli(
      [fixture.url, '--allow-local', '--diff', 'latest', '--baseline', 'nowhere.json', '--formats', 'json'],
      {},
      projDir,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/No baseline found at nowhere\.json/s);
  }, 60_000);

  it('refuses --diff latest when no stored baseline exists', async () => {
    const projDir = join(outDir, 'cli-no-baseline');
    await mkdir(projDir, { recursive: true });

    const { code, stderr } = await runCli(
      [fixture.url, '--allow-local', '--diff', 'latest', '--formats', 'json'],
      {},
      projDir,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/No stored baseline found.*api-recon baseline/s);
  }, 60_000);

  it('refuses --resume when the output directory has no checkpoint', async () => {
    const dir = join(outDir, 'cli-resume-missing');

    const { code, stdout, stderr } = await runCli([
      fixture.url,
      '--allow-local',
      '--resume',
      '--out',
      dir,
      '--formats',
      'json',
    ]);

    expect(code).toBe(2);
    expect(stderr).toMatch(/No checkpoint found/);
    // The next step prints on the human stream (stdout without --print).
    expect(`${stdout}${stderr}`).toMatch(/→/);
  }, 60_000);

  // Signals are delivered as real SIGINT on POSIX; on Windows `kill` cannot
  // send SIGINT to a child, so this test only runs where it means something.
  it.runIf(process.platform !== 'win32')(
    'stops a running scan on SIGINT and still flushes report.json',
    async () => {
      const dir = join(outDir, 'cli-sigint');
      const child = spawn(
        process.execPath,
        [
          ...NODE_TSX_ARGS,
          fixture.url,
          '--allow-local',
          '--rate',
          '600',
          '--depth',
          '3',
          '--max-pages',
          '100',
          '--out',
          dir,
          '--formats',
          'json',
        ],
        { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', () => {});

      // Let the crawl get underway, then interrupt it mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      child.kill('SIGINT');

      const code = await new Promise<number | null>((resolve) =>
        child.once('exit', (value) => resolve(value)),
      );

      expect(code).toBe(130);
      expect(stdout).toMatch(/partial report/i);
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        meta: { pagesVisited: number };
      };
      expect(report.meta.pagesVisited).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );

  it('refuses --fail-on-diff with no baseline', async () => {
    const { code, stderr } = await runCli([fixture.url, '--allow-local', '--fail-on-diff']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--fail-on-diff only means something together with --diff/);
  }, 60_000);

  it('rejects a baseline that is not a report', async () => {
    const bogus = join(outDir, 'bogus-baseline.json');
    await writeFile(bogus, JSON.stringify({ hello: 'world' }), 'utf8');

    const { code, stderr } = await runCli([
      fixture.url,
      '--allow-local',
      '--diff',
      bogus,
      '--formats',
      'json',
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/must be an api-recon report/);
  }, 60_000);
});
