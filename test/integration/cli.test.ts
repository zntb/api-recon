/** CLI end-to-end tests: spawn the real CLI against the local fixture site. */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../fixtures/server.js';
import { browserAvailable } from '../helpers/browser.js';

const exec = promisify(execFile);
const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');
// Run the TypeScript entrypoint through Node itself. Spawning the tsx shell
// shim works on POSIX but fails on Windows, where .cmd files cannot be spawned
// without a shell.
const NODE_TSX_ARGS = ['--import', 'tsx', CLI_ENTRY];

let fixture: FixtureServerHandle;
let outDir: string;
let canRunBrowser = false;

// The help/guard tests run without a browser; these two need a real one.
const NEEDS_BROWSER = ['produces report files', 'diffs'];

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
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [...NODE_TSX_ARGS, ...args], {
      env: { ...process.env, ...env },
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
      '--force',
      '--allow-local',
      '--quiet',
      '--verbose',
    ]) {
      expect(stdout, `--help should mention ${flag}`).toContain(flag);
    }
  }, 60_000);

  it('refuses localhost without --allow-local', async () => {
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
  }, 60_000);

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
    expect(md).toContain('## 8. Changes Since Baseline');
    expect(md).toContain('legacyField');
  }, 240_000);

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
