/**
 * Presets: `--preset quick|deep|ci`.
 *
 * Each preset is nothing but a bundle of the flags people otherwise piece
 * together by hand, so "look at this page" is one word instead of three. Nothing
 * is hidden behind them: every value is an ordinary setting with an ordinary
 * default, listed here and in the README, and `--verbose` prints the ones that
 * were applied.
 *
 * A preset is a per-run convenience, not a policy — which is why it sits above
 * the config file (a `--preset quick` has to win over a committed `depth: 3` to
 * mean anything) and why a config file may not set one. Commit the flags you
 * want, and keep the shorthand for the run in front of you.
 */

import { SafetyError } from '../utils/safety.js';

export interface Preset {
  name: PresetName;
  /** One line, for --help and for the error when a name is misspelled. */
  summary: string;
  /** Values in the resolved option shape, keyed like the config file's keys. */
  values: Record<string, unknown>;
}

export type PresetName = 'quick' | 'deep' | 'ci';

export const PRESETS: Record<PresetName, Preset> = {
  quick: {
    name: 'quick',
    summary: 'one page, no crawl, skips the PDF render',
    values: {
      depth: 0,
      maxPages: 1,
      formats: 'json,md,dashboard',
    },
  },
  deep: {
    name: 'deep',
    summary: 'crawl further and include cross-origin traffic',
    values: {
      depth: 3,
      maxPages: 100,
      includeThirdParty: true,
    },
  },
  ci: {
    name: 'ci',
    summary: 'bounded, quiet, and machine-readable for a pipeline',
    values: {
      depth: 2,
      maxPages: 50,
      formats: 'json,md',
      quiet: true,
    },
  },
};

export function presetNames(): PresetName[] {
  return Object.keys(PRESETS) as PresetName[];
}

export function isPresetName(name: string): name is PresetName {
  return Object.prototype.hasOwnProperty.call(PRESETS, name);
}

/** The bundle for a preset name, or a `SafetyError` naming the alternatives. */
export function presetValues(name: string): { preset: Preset; values: Record<string, unknown> } {
  if (!isPresetName(name)) {
    const available = presetNames()
      .map((preset) => `${preset} (${PRESETS[preset].summary})`)
      .join(', ');
    throw new SafetyError(`Unknown preset "${name}". Available presets: ${available}.`);
  }
  return { preset: PRESETS[name], values: PRESETS[name].values };
}

/** What `--help` shows after the flag's own description. */
export function presetHelp(): string {
  return presetNames()
    .map((name) => `${name} (${PRESETS[name].summary})`)
    .join(', ');
}
