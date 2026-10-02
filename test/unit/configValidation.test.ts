import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadActions } from '../../src/core/actions.js';
import { loadLoginFlow } from '../../src/core/authenticator.js';
import { SafetyError } from '../../src/utils/errors.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'api-recon-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, text: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, text, 'utf8');
  return file;
}

describe('actions validation', () => {
  it('accepts a bare list and a { steps } object', async () => {
    const bare = await write('bare.yaml', "- click: '#a'\n- wait: 200\n");
    const wrapped = await write('wrapped.yaml', "steps:\n  - click: '#a'\n  - wait: 200\n");

    await expect(loadActions(bare)).resolves.toEqual([{ click: '#a' }, { wait: 200 }]);
    await expect(loadActions(wrapped)).resolves.toEqual([{ click: '#a' }, { wait: 200 }]);
  });

  it('accepts a JSON file', async () => {
    const file = await write('actions.json', JSON.stringify([{ click: '#a' }, { wait: 5 }]));
    await expect(loadActions(file)).resolves.toEqual([{ click: '#a' }, { wait: 5 }]);
  });

  it('names the path and line of an unknown step', async () => {
    const file = await write('bad.yaml', "steps:\n  - click: '#ok'\n  - clik: '#typo'\n");

    const failure = loadActions(file);
    await expect(failure).rejects.toThrow(SafetyError);
    await expect(failure).rejects.toThrow(/steps\[1\]\.clik/);
    await expect(failure).rejects.toThrow(/:3:/);
    await expect(failure).rejects.toThrow(/unknown step "clik"/);
  });

  it('names a missing field and its parent line', async () => {
    const file = await write('missing.yaml', "steps:\n  - fill: { selector: '#q' }\n");

    const failure = loadActions(file);
    await expect(failure).rejects.toThrow(/steps\[0\]\.fill\.value/);
    await expect(failure).rejects.toThrow(/missing required field "value"/);
    await expect(failure).rejects.toThrow(/:2:/);
  });

  it('rejects a wrong type, a multi-key step, and an unknown field', async () => {
    const wrongType = await write('type.yaml', "steps:\n  - wait: 'soon'\n");
    await expect(loadActions(wrongType)).rejects.toThrow(/expected a non-negative number/);

    const twoKeys = await write('two.yaml', "steps:\n  - click: '#a'\n    wait: 3\n");
    await expect(loadActions(twoKeys)).rejects.toThrow(/expected a single step key, got click, wait/);

    const extra = await write(
      'extra.yaml',
      "steps:\n  - fill: { selector: '#q', value: 'x', extra: 1 }\n",
    );
    await expect(loadActions(extra)).rejects.toThrow(/unexpected field "extra"/);
  });

  it('validates the scroll union', async () => {
    const ok = await write('scroll.yaml', "steps:\n  - scroll: bottom\n  - scroll: { to: top }\n");
    await expect(loadActions(ok)).resolves.toEqual([{ scroll: 'bottom' }, { scroll: { to: 'top' } }]);

    const bad = await write('scroll-bad.yaml', "steps:\n  - scroll: { to: middle }\n");
    await expect(loadActions(bad)).rejects.toThrow(/expected one of top, bottom/);
  });

  it('rejects a document that is neither a list nor { steps }', async () => {
    const file = await write('scalar.yaml', 'just a string\n');
    await expect(loadActions(file)).rejects.toThrow(/expected a list/);
  });

  it('reports a YAML syntax error with its line', async () => {
    const file = await write('syntax.yaml', "steps:\n  - click: '#a'\n  - fill: { selector: '#q',\n");

    const failure = loadActions(file);
    await expect(failure).rejects.toThrow(SafetyError);
    await expect(failure).rejects.toThrow(/syntax\.yaml:\d+:\d+/);
  });

  it('reports a JSON syntax error with its position', async () => {
    const file = await write('syntax.json', '{ "steps": [ }\n');
    await expect(loadActions(file)).rejects.toThrow(/syntax\.json:\d+:\d+/);
    await expect(loadActions(file)).rejects.toThrow(/JSON/i);
  });

  it('reports a missing file rather than throwing a read error', async () => {
    await expect(loadActions(join(dir, 'nope.yaml'))).rejects.toThrow(SafetyError);
    await expect(loadActions(join(dir, 'nope.yaml'))).rejects.toThrow(/config file not found/);
  });
});

describe('login flow validation', () => {
  it('accepts a valid flow and substitutes the login URL', async () => {
    const file = await write(
      'login.yaml',
      "loginUrl: ${API_RECON_TEST_LOGIN}/login\nsteps:\n  - fill: { selector: '#u', value: 'x' }\n  - click: '#go'\n",
    );
    process.env.API_RECON_TEST_LOGIN = 'https://example.com';
    try {
      const flow = await loadLoginFlow(file);
      expect(flow.loginUrl).toBe('https://example.com/login');
      expect(flow.steps).toHaveLength(2);
    } finally {
      delete process.env.API_RECON_TEST_LOGIN;
    }
  });

  it('requires loginUrl and a steps list', async () => {
    const noUrl = await write('no-url.yaml', "steps:\n  - click: '#go'\n");
    await expect(loadLoginFlow(noUrl)).rejects.toThrow(/loginUrl/);
    await expect(loadLoginFlow(noUrl)).rejects.toThrow(/missing required field "loginUrl"/);

    const noSteps = await write('no-steps.yaml', 'loginUrl: https://example.com\n');
    await expect(loadLoginFlow(noSteps)).rejects.toThrow(/missing required field "steps"/);
  });

  it('names an unknown login step and its line', async () => {
    const file = await write(
      'bad-login.yaml',
      "loginUrl: https://example.com\nsteps:\n  - click: '#go'\n  - filler: '#x'\n",
    );

    const failure = loadLoginFlow(file);
    await expect(failure).rejects.toThrow(/steps\[1\]\.filler/);
    await expect(failure).rejects.toThrow(/:4:/);
  });

  it('rejects an unexpected top-level field', async () => {
    const file = await write(
      'extra-top.yaml',
      'loginUrl: https://example.com\nsteps: []\nextra: x\n',
    );
    await expect(loadLoginFlow(file)).rejects.toThrow(/unexpected field "extra"/);
  });
});
