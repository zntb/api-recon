/** CLI end-to-end tests: spawn the real CLI against the local fixture site. */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

beforeEach((ctx) => {
  // The help/guard tests do not need a browser; only the scan test does.
  if (!canRunBrowser && ctx.task.name.includes('produces report files')) ctx.skip();
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
      '--record',
      '--actions',
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
});
