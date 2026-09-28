import { describe, expect, it } from 'vitest';
import { extractEnvRefs, formatDuration, substituteEnv } from '../../src/utils/misc.js';
import { loadConfig } from '../../src/utils/config.js';

describe('env refs', () => {
  it('extracts variable names', () => {
    expect(extractEnvRefs('fill ${USER} with ${PASS} ok')).toEqual(['USER', 'PASS']);
    expect(extractEnvRefs('no refs here')).toEqual([]);
  });

  it('substitutes present env vars', () => {
    process.env.API_RECON_TEST_VAR = 'hello';
    expect(substituteEnv('x ${API_RECON_TEST_VAR} y')).toBe('x hello y');
    delete process.env.API_RECON_TEST_VAR;
  });

  it('throws on missing env vars without leaking values', () => {
    expect(() => substituteEnv('${DEFINITELY_NOT_SET_VAR_123}')).toThrow(/DEFINITELY_NOT_SET_VAR_123/);
  });
});

describe('formatDuration', () => {
  it('formats sub-second, seconds, and minutes', () => {
    expect(formatDuration(400)).toBe('400ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});

describe('loadConfig', () => {
  it('parses yaml files', async () => {
    const cfg = await loadConfig<{ loginUrl: string }>('test/fixtures/login.yaml');
    expect(cfg.loginUrl).toContain('/login');
  });

  it('parses json files', async () => {
    const cfg = await loadConfig<unknown[]>('test/fixtures/actions.json');
    expect(Array.isArray(cfg)).toBe(true);
  });
});
