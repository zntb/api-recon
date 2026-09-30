import { describe, expect, it } from 'vitest';
import { presetHelp, presetNames, presetValues, PRESETS } from '../../src/cli/presets.js';
import { configKeys, resolveOptions } from '../../src/cli/config.js';

/** Parsed CLI options as commander hands them over, defaults included. */
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
  includeThirdParty: false,
  failOnDiff: false,
};

describe('presets', () => {
  it('offers the three documented names', () => {
    expect(presetNames()).toEqual(['quick', 'deep', 'ci']);
    expect(presetHelp()).toContain('quick (');
    expect(presetHelp()).toContain('deep (');
    expect(presetHelp()).toContain('ci (');
  });

  it('only sets settings that exist, and no more than a handful each', () => {
    const known = new Set(configKeys());
    for (const name of presetNames()) {
      const preset = PRESETS[name];
      expect(preset.name).toBe(name);
      expect(preset.summary.length).toBeGreaterThan(0);
      for (const key of Object.keys(preset.values)) {
        expect(known.has(key), `${name} sets unknown setting ${key}`).toBe(true);
      }
    }
  });

  it('never relaxes a safety guard or a mode that needs a human', () => {
    for (const name of presetNames()) {
      const values = PRESETS[name].values;
      // force/redact are refused in a config for good reason; a preset that set
      // them would be the same trap with a shorter name.
      expect(values['force'], `${name} must not bypass robots.txt`).toBeUndefined();
      expect(values['redact'], `${name} must not change redaction`).toBeUndefined();
      expect(values['record'], `${name} must not open a browser for a human`).toBeUndefined();
      // --fail-on-diff refuses to run without --diff, so a preset cannot set it.
      expect(values['failOnDiff'], `${name} cannot require a baseline`).toBeUndefined();
    }
  });

  it('names the alternatives when a name is misspelled', () => {
    expect(() => presetValues('fast')).toThrow(/Unknown preset "fast"\. Available presets: quick/);
  });

  it('passes its own values through the ordinary validation', async () => {
    // A typo in a bundle (a string where a number belongs) would throw here.
    for (const name of presetNames()) {
      const { options, provenance } = await resolveOptions({
        cli: { ...cli, preset: name },
        isExplicit: (key) => key === 'preset',
        env: {},
      });
      expect(options['preset']).toBe(name);
      for (const key of Object.keys(PRESETS[name].values)) {
        expect(provenance[key], `${name}.${key}`).toBe('preset');
        expect(options[key]).toEqual(PRESETS[name].values[key]);
      }
    }
  });

  it('keeps quick quick: one page, no crawl, no PDF render', async () => {
    const { options } = await resolveOptions({
      cli: { ...cli, preset: 'quick' },
      isExplicit: (key) => key === 'preset',
      env: {},
    });

    expect(options['depth']).toBe(0);
    expect(options['maxPages']).toBe(1);
    expect(String(options['formats'])).not.toContain('pdf');
  });

  it('leaves everything it does not bundle at its default', async () => {
    const { options, provenance } = await resolveOptions({
      cli: { ...cli, preset: 'deep' },
      isExplicit: (key) => key === 'preset',
      env: {},
    });

    expect(options['depth']).toBe(3);
    expect(options['includeThirdParty']).toBe(true);
    // rate and browser are not part of any bundle.
    expect(options['rate']).toBe(500);
    expect(provenance['rate']).toBe('default');
    expect(provenance['browser']).toBe('default');
  });
});
