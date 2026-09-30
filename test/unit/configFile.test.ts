import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAMES,
  configKeys,
  findProjectConfig,
  loadProjectConfig,
  resolveOptions,
} from '../../src/cli/config.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'api-recon-config-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(relDir: string, name: string, contents: unknown): Promise<string> {
  const dir = join(root, relDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
}

describe('findProjectConfig', () => {
  it('walks up from the working directory and takes the nearest file', async () => {
    const file = await writeConfig('project', CONFIG_FILENAMES[0]!, { depth: 2 });
    await mkdir(join(root, 'project', 'packages', 'web'), { recursive: true });

    const found = await findProjectConfig(join(root, 'project', 'packages', 'web'));

    expect(found).toBe(file);
  });

  it('prefers the documented order when several names exist in one directory', async () => {
    const dir = 'many';
    await writeConfig(dir, CONFIG_FILENAMES[2]!, { depth: 3 });
    const preferred = await writeConfig(dir, CONFIG_FILENAMES[0]!, { depth: 4 });

    expect(await findProjectConfig(join(root, dir))).toBe(preferred);
  });

  it('starts at the directory itself, not only its parents', async () => {
    const file = await writeConfig('self', '.api-reconrc', { depth: 5 });
    expect(await findProjectConfig(join(root, 'self'))).toBe(file);
  });
});

describe('loadProjectConfig', () => {
  it('accepts kebab-case keys, because that is how the flags are written', async () => {
    const file = await writeConfig('kebab', '.api-reconrc', { 'max-pages': 12, 'json-progress': true });

    const config = await loadProjectConfig(file);

    expect(config.values).toEqual({ maxPages: 12, jsonProgress: true });
    expect(config.dir).toBe(join(root, 'kebab'));
  });

  it('refuses an unknown setting rather than quietly ignoring a typo', async () => {
    const file = await writeConfig('typo', '.api-reconrc', { maxPags: 12 });

    await expect(loadProjectConfig(file)).rejects.toThrow(/Unknown setting "maxPags".*Valid settings:/s);
  });

  it('reports broken JSON and a missing file clearly', async () => {
    const broken = await writeConfig('broken', '.api-reconrc', '{ "depth": }');
    await expect(loadProjectConfig(broken)).rejects.toThrow(/not valid JSON/);

    await expect(loadProjectConfig(join(root, 'nope', '.api-reconrc'))).rejects.toThrow(
      /Config file not found/,
    );
  });

  it('insists on an object', async () => {
    const file = await writeConfig('array', '.api-reconrc', '[1, 2, 3]');
    await expect(loadProjectConfig(file)).rejects.toThrow(/must contain a JSON object/);
  });
});

describe('resolveOptions precedence', () => {
  /** A parsed CLI as commander would hand it over: values plus defaults. */
  const cli = {
    depth: 1,
    maxPages: 25,
    rate: 500,
    out: './api-recon-output',
    formats: 'json,md,html,pdf,openapi,dashboard',
    browser: 'chromium',
    quiet: false,
    redact: true,
    respectRobots: true,
  };

  it('falls back to the CLI defaults when nobody says otherwise', async () => {
    const { options, provenance, configPath } = await resolveOptions({
      cli,
      isExplicit: () => false,
      env: {},
      cwd: root,
    });

    expect(options['depth']).toBe(1);
    expect(options['out']).toBe('./api-recon-output');
    expect(provenance['depth']).toBe('default');
    expect(configPath).toBeNull();
  });

  it('reads a discovered config file, and lets the environment override it', async () => {
    const res = 'precedence';
    await writeConfig(res, '.api-reconrc', { depth: 3, maxPages: 9, browser: 'firefox', quiet: true });
    const cwd = join(root, res);

    const fromConfig = await resolveOptions({ cli, isExplicit: () => false, env: {}, cwd });
    expect(fromConfig.options['depth']).toBe(3);
    expect(fromConfig.options['maxPages']).toBe(9);
    expect(fromConfig.options['browser']).toBe('firefox');
    expect(fromConfig.provenance['depth']).toBe('config');
    expect(fromConfig.configPath).toBe(join(cwd, '.api-reconrc'));

    const fromEnv = await resolveOptions({
      cli,
      isExplicit: () => false,
      env: { API_RECON_DEPTH: '4' },
      cwd,
    });
    expect(fromEnv.options['depth']).toBe(4);
    expect(fromEnv.provenance['depth']).toBe('env');
    // Untouched keys still come from the config.
    expect(fromEnv.options['maxPages']).toBe(9);
  });

  it('lets a flag beat both the environment and the config', async () => {
    const res = 'flag-wins';
    await writeConfig(res, '.api-reconrc', { depth: 3 });
    const cwd = join(root, res);

    const { options, provenance } = await resolveOptions({
      cli: { ...cli, depth: 7 },
      isExplicit: (key) => key === 'depth',
      env: { API_RECON_DEPTH: '4' },
      cwd,
    });

    expect(options['depth']).toBe(7);
    expect(provenance['depth']).toBe('cli');
  });

  it('honours --no-config, even when a file is there', async () => {
    const res = 'no-config';
    await writeConfig(res, '.api-reconrc', { depth: 3 });
    const cwd = join(root, res);

    const { options, configPath, configIgnored } = await resolveOptions({
      cli: { ...cli, config: false },
      isExplicit: (key) => key === 'config',
      env: {},
      cwd,
    });

    expect(options['depth']).toBe(1);
    expect(configPath).toBeNull();
    expect(configIgnored).toBe(true);
  });

  it('takes an explicit path from --config, or from API_RECON_CONFIG', async () => {
    const file = await writeConfig('explicit/nested', 'custom.json', { depth: 6 });
    const cwd = join(root, 'explicit');

    const viaFlag = await resolveOptions({
      cli: { ...cli, config: 'nested/custom.json' },
      isExplicit: (key) => key === 'config',
      env: {},
      cwd,
    });
    expect(viaFlag.configPath).toBe(file);
    expect(viaFlag.options['depth']).toBe(6);

    const viaEnv = await resolveOptions({
      cli,
      isExplicit: () => false,
      env: { API_RECON_CONFIG: file },
      cwd: root,
    });
    expect(viaEnv.options['depth']).toBe(6);
    expect(viaEnv.provenance['depth']).toBe('config');
  });

  it('explains a config file that cannot be parsed', async () => {
    await expect(
      resolveOptions({
        cli: { ...cli, config: 'missing.json' },
        isExplicit: () => false,
        env: {},
        cwd: root,
      }),
    ).rejects.toThrow(/Config file not found/);
  });

  it('resolves a relative path in the config against the config file itself', async () => {
    const res = 'paths';
    await writeConfig(res, '.api-reconrc', {
      login: 'flows/login.yaml',
      actions: 'flows/actions.json',
      out: 'reports',
    });
    const cwd = join(root, res, 'deep', 'inside');

    const { options } = await resolveOptions({ cli, isExplicit: () => false, env: {}, cwd });

    expect(options['login']).toBe(join(root, res, 'flows', 'login.yaml'));
    expect(options['actions']).toBe(join(root, res, 'flows', 'actions.json'));
    expect(options['out']).toBe(join(root, res, 'reports'));
    // An absolute path is left alone.
  });

  it('leaves paths from a flag relative to the working directory', async () => {
    const { options } = await resolveOptions({
      cli: { ...cli, login: 'flows/login.yaml' },
      isExplicit: (key) => key === 'login',
      env: {},
      cwd: root,
    });
    expect(options['login']).toBe('flows/login.yaml');
  });

  it('refuses a shared config that would loosen safety for the whole team', async () => {
    const force = await writeConfig('danger-force', '.api-reconrc', { force: true });
    const redact = await writeConfig('danger-redact', '.api-reconrc', { redact: false });

    await expect(loadProjectConfig(force).then(() =>
      resolveOptions({ cli, isExplicit: () => false, env: {}, cwd: join(root, 'danger-force') }),
    )).rejects.toThrow(/cannot be set in .*pass --force/s);

    await expect(loadProjectConfig(redact).then(() =>
      resolveOptions({ cli, isExplicit: () => false, env: {}, cwd: join(root, 'danger-redact') }),
    )).rejects.toThrow(/cannot be set in .*pass --no-redact/s);
  });

  it('still allows those settings from a flag or the environment', async () => {
    const viaFlag = await resolveOptions({
      cli: { ...cli, force: true },
      isExplicit: (key) => key === 'force',
      env: {},
      cwd: root,
    });
    expect(viaFlag.options['force']).toBe(true);

    const viaEnv = await resolveOptions({
      cli,
      isExplicit: () => false,
      env: { API_RECON_REDACT: '0' },
      cwd: root,
    });
    expect(viaEnv.options['redact']).toBe(false);
  });

  it('accepts a list for formats, and validates the type of everything else', async () => {
    const res = 'types';
    await writeConfig(res, '.api-reconrc', { formats: ['json', 'md'] });
    const cwd = join(root, res);

    const { options } = await resolveOptions({ cli, isExplicit: () => false, env: {}, cwd });
    expect(options['formats']).toBe('json,md');

    const badType = await writeConfig('types-bad', '.api-reconrc', { depth: 'two' });
    expect(badType).toBeTruthy();
    await expect(
      resolveOptions({ cli, isExplicit: () => false, env: {}, cwd: join(root, 'types-bad') }),
    ).rejects.toThrow(/depth in .*: expected a non-negative integer, got "two"/s);

    const badBrowser = await writeConfig('types-browser', '.api-reconrc', { browser: 'netscape' });
    expect(badBrowser).toBeTruthy();
    await expect(
      resolveOptions({ cli, isExplicit: () => false, env: {}, cwd: join(root, 'types-browser') }),
    ).rejects.toThrow(/expected one of chromium, firefox, webkit/);
  });

  it('reads booleans and numbers out of the environment', async () => {
    const { options } = await resolveOptions({
      cli,
      isExplicit: () => false,
      env: {
        API_RECON_QUIET: 'yes',
        API_RECON_MAX_BODY_MB: '2.5',
        API_RECON_BROWSER: 'webkit',
        API_RECON_FORMATS: 'json',
      },
      cwd: root,
    });

    expect(options['quiet']).toBe(true);
    expect(options['maxBodyMb']).toBe(2.5);
    expect(options['browser']).toBe('webkit');
    expect(options['formats']).toBe('json');
  });

  it('rejects a value in the environment that makes no sense', async () => {
    await expect(
      resolveOptions({
        cli,
        isExplicit: () => false,
        env: { API_RECON_TELEMETRY: 'maybe' },
        cwd: root,
      }),
    ).rejects.toThrow(/API_RECON_TELEMETRY: expected one of 1, 0, true, false/);
  });
});

describe('presets in the precedence chain', () => {
  const cli = {
    depth: 1,
    maxPages: 25,
    rate: 500,
    formats: 'json,md,html,pdf,openapi,dashboard',
    quiet: false,
    respectRobots: true,
    redact: true,
  };

  it('beats the config file, which is what makes --preset quick mean quick', async () => {
    const res = 'preset-vs-config';
    await writeConfig(res, '.api-reconrc', { depth: 3, maxPages: 90, rate: 100 });

    const { options, provenance } = await resolveOptions({
      cli: { ...cli, preset: 'quick' },
      isExplicit: (key) => key === 'preset',
      env: {},
      cwd: join(root, res),
    });

    expect(options['depth']).toBe(0);
    expect(provenance['depth']).toBe('preset');
    // A setting the preset does not bundle still comes from the file.
    expect(options['rate']).toBe(100);
    expect(provenance['rate']).toBe('config');
  });

  it('loses to a flag and to an environment variable', async () => {
    const withFlag = await resolveOptions({
      cli: { ...cli, preset: 'deep', maxPages: 7 },
      isExplicit: (key) => key === 'preset' || key === 'maxPages',
      env: {},
      cwd: root,
    });
    expect(withFlag.options['maxPages']).toBe(7);
    expect(withFlag.provenance['maxPages']).toBe('cli');
    expect(withFlag.options['depth']).toBe(3);

    const withEnv = await resolveOptions({
      cli,
      isExplicit: () => false,
      env: { API_RECON_PRESET: 'deep', API_RECON_MAX_PAGES: '8' },
      cwd: root,
    });
    expect(withEnv.options['preset']).toBe('deep');
    expect(withEnv.provenance['preset']).toBe('env');
    expect(withEnv.options['maxPages']).toBe(8);
    expect(withEnv.provenance['maxPages']).toBe('env');
    expect(withEnv.options['depth']).toBe(3);
  });

  it('refuses to let a repository choose a preset for everyone', async () => {
    const res = 'preset-in-config';
    await writeConfig(res, '.api-reconrc', { preset: 'ci' });

    await expect(
      resolveOptions({ cli, isExplicit: () => false, env: {}, cwd: join(root, res) }),
    ).rejects.toThrow(/"preset" cannot be set in .*commit the flags themselves/s);
  });

  it('rejects a name that is not a preset', async () => {
    await expect(
      resolveOptions({
        cli: { ...cli, preset: 'turbo' },
        isExplicit: (key) => key === 'preset',
        env: {},
        cwd: root,
      }),
    ).rejects.toThrow(/Unknown preset "turbo"/);
  });
});

describe('configKeys', () => {
  it('lists the settings a config file may carry, and what it may not loosen', () => {
    expect(configKeys()).toContain('maxPages');
    expect(configKeys()).toContain('login');
    expect(configKeys()).toContain('jsonProgress');
    // Documented as valid keys; the values that loosen safety are refused above.
    expect(configKeys()).toContain('force');
    expect(configKeys()).toContain('redact');
    // Listed, but any value for it is refused — see the preset tests.
    expect(configKeys()).toContain('preset');
  });
});
