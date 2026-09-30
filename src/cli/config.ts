/**
 * The project config file — `.api-reconrc` — and the precedence that reads it.
 *
 * A team runs the same scan with the same flags every time, so the flags belong
 * in the repository rather than in everyone's shell history. The file is plain
 * JSON, discovered by walking up from the working directory (like `.gitignore`),
 * and it can only *reduce* typing: every value is overridable, and two of them
 * are deliberately not allowed in a shared file at all (see `NOT_COMMITTABLE`).
 *
 * Precedence, highest first:
 *
 *   1. a flag on the command line
 *   2. an `API_RECON_*` environment variable
 *   3. a `--preset` bundle (see `presets.ts`)
 *   4. the config file
 *   5. the built-in default
 *
 * The preset sits above the config because it is a per-run choice: `--preset
 * quick` on a repository whose config says `depth: 3` has to actually be quick.
 * It sits below the environment and the flags because those name one setting
 * each and are therefore more specific than a bundle.
 *
 * The same order applies to `login`, `actions`, and `out`, with one refinement:
 * a *relative* path in the config file resolves against the config file's own
 * directory, so a committed config means the same thing from any subdirectory.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveEngine } from '../core/browser.js';
import { SafetyError } from '../utils/safety.js';
import { presetValues } from './presets.js';

/** Looked for in each directory, in this order, walking up to the root. */
export const CONFIG_FILENAMES = [
  'api-recon.config.json',
  '.api-reconrc.json',
  '.api-reconrc',
] as const;

/** Point at a config file without a flag, for CI. */
export const CONFIG_ENV = 'API_RECON_CONFIG';

/** Where a value came from, so the CLI can explain itself. */
export type Provenance = 'cli' | 'env' | 'preset' | 'config' | 'default';

export interface ProjectConfigFile {
  path: string;
  /** The directory relative paths in the file are resolved against. */
  dir: string;
  values: Record<string, unknown>;
}

type OptionKind = 'int' | 'number' | 'bool' | 'string' | 'list' | 'engine' | 'path';

interface OptionSpec {
  key: string;
  kind: OptionKind;
  /** The environment variable that can also set it, if any. */
  env?: string;
  /** Set when a shared config file must not carry this value. */
  notCommittable?: (value: unknown) => string | null;
}

/**
 * Settings a config file may carry — the same names as the long flags, in
 * camelCase (kebab-case is accepted too, so `--max-pages` maps to `maxPages`).
 */
const OPTION_SPECS: OptionSpec[] = [
  { key: 'depth', kind: 'int', env: 'API_RECON_DEPTH' },
  { key: 'maxPages', kind: 'int', env: 'API_RECON_MAX_PAGES' },
  { key: 'out', kind: 'path', env: 'API_RECON_OUT' },
  { key: 'formats', kind: 'list', env: 'API_RECON_FORMATS' },
  { key: 'browser', kind: 'engine', env: 'API_RECON_BROWSER' },
  { key: 'auth', kind: 'path', env: 'API_RECON_AUTH' },
  { key: 'login', kind: 'path', env: 'API_RECON_LOGIN' },
  { key: 'actions', kind: 'path', env: 'API_RECON_ACTIONS' },
  { key: 'record', kind: 'bool', env: 'API_RECON_RECORD' },
  { key: 'rate', kind: 'int', env: 'API_RECON_RATE' },
  { key: 'diff', kind: 'path', env: 'API_RECON_DIFF' },
  { key: 'failOnDiff', kind: 'bool', env: 'API_RECON_FAIL_ON_DIFF' },
  { key: 'respectRobots', kind: 'bool', env: 'API_RECON_RESPECT_ROBOTS' },
  { key: 'includeThirdParty', kind: 'bool', env: 'API_RECON_INCLUDE_THIRD_PARTY' },
  {
    key: 'redact',
    kind: 'bool',
    env: 'API_RECON_REDACT',
    notCommittable: (value) =>
      value === false
        ? 'turning redaction off affects everyone who uses the repository — pass --no-redact (or API_RECON_REDACT=0) for a run'
        : null,
  },
  {
    key: 'force',
    kind: 'bool',
    env: 'API_RECON_FORCE',
    notCommittable: (value) =>
      value === true
        ? 'bypassing robots.txt affects everyone who uses the repository — pass --force (or API_RECON_FORCE=1) for a run'
        : null,
  },
  { key: 'allowLocal', kind: 'bool', env: 'API_RECON_ALLOW_LOCAL' },
  { key: 'telemetry', kind: 'bool', env: 'API_RECON_TELEMETRY' },
  { key: 'telemetryPreview', kind: 'bool', env: 'API_RECON_TELEMETRY_PREVIEW' },
  { key: 'maxBodyMb', kind: 'number', env: 'API_RECON_MAX_BODY_MB' },
  {
    key: 'preset',
    kind: 'string',
    env: 'API_RECON_PRESET',
    notCommittable: () =>
      'a preset bundles flags for one run — commit the flags themselves to share them with the team',
  },
  { key: 'quiet', kind: 'bool', env: 'API_RECON_QUIET' },
  { key: 'verbose', kind: 'bool', env: 'API_RECON_VERBOSE' },
  { key: 'jsonProgress', kind: 'bool', env: 'API_RECON_JSON_PROGRESS' },
];

const SPEC_BY_KEY = new Map(OPTION_SPECS.map((spec) => [spec.key, spec]));

/** The settings a config file may contain, for the error message and the docs. */
export function configKeys(): string[] {
  return OPTION_SPECS.map((spec) => spec.key);
}

// ---- loading ---------------------------------------------------------------

/** The nearest config file at or above `startDir`, or null. */
export async function findProjectConfig(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (await isFile(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read and check a config file. `file` may be relative to `cwd`. */
export async function loadProjectConfig(file: string, cwd = process.cwd()): Promise<ProjectConfigFile> {
  const path = isAbsolute(file) ? file : resolve(cwd, file);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new SafetyError(`Config file not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SafetyError(
      `Config file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SafetyError(`Config file ${path} must contain a JSON object.`);
  }

  const values: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
    const key = toCamelCase(rawKey);
    if (!SPEC_BY_KEY.has(key)) {
      throw new SafetyError(
        `Unknown setting "${rawKey}" in ${path}. Valid settings: ${configKeys().join(', ')}.`,
      );
    }
    values[key] = value;
  }

  return { path, dir: dirname(path), values };
}

// ---- resolution ------------------------------------------------------------

export interface ResolveInput {
  /** Parsed command-line options, including commander's defaults. */
  cli: Record<string, unknown>;
  /** Whether the flag was actually passed (commander's option source). */
  isExplicit: (key: string) => boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ResolvedOptions {
  /** The same shape as the parsed CLI options, with env and config folded in. */
  options: Record<string, unknown>;
  provenance: Record<string, Provenance>;
  /** The config file that was used, if any. */
  configPath: string | null;
  /** True when a config file was found but `--no-config` suppressed it. */
  configIgnored: boolean;
}

/**
 * Fold the command line, the environment, and the config file into one set of
 * options. `cli` doubles as the default layer: what the flags default to is what
 * the tool does when nobody says otherwise.
 */
export async function resolveOptions(input: ResolveInput): Promise<ResolvedOptions> {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();

  const requested = input.cli['config'];
  let config: ProjectConfigFile | null = null;
  let configIgnored = false;
  if (requested === false) {
    configIgnored = await findProjectConfig(cwd) !== null;
  } else {
    const explicit = typeof requested === 'string' ? requested : env[CONFIG_ENV];
    if (explicit) config = await loadProjectConfig(explicit, cwd);
    else {
      const found = await findProjectConfig(cwd);
      if (found) config = await loadProjectConfig(found, cwd);
    }
  }

  // The preset is chosen before the loop, because its bundle is one of the
  // layers the loop applies. It can come from a flag or the environment, never
  // from the file (a shared preset would be policy by another name).
  const chosenPreset = selectPreset(input, env);
  const preset = chosenPreset ? presetValues(chosenPreset.value).values : null;

  const options: Record<string, unknown> = {};
  const provenance: Record<string, Provenance> = {};

  for (const spec of OPTION_SPECS) {
    let value: unknown;
    let from: Provenance;

    if (input.isExplicit(spec.key)) {
      value = input.cli[spec.key];
      from = 'cli';
    } else if (spec.env && env[spec.env] !== undefined && env[spec.env] !== '') {
      value = parseEnv(spec, env[spec.env]!, spec.env);
      from = 'env';
    } else if (preset && spec.key in preset) {
      value = preset[spec.key];
      from = 'preset';
    } else if (config && spec.key in config.values) {
      value = config.values[spec.key];
      const refusal = spec.notCommittable?.(value);
      if (refusal) {
        throw new SafetyError(`"${spec.key}" cannot be set in ${config.path}: ${refusal}.`);
      }
      if (spec.kind === 'path') value = resolveAgainst(config.dir, value, spec.key, config.path);
      from = 'config';
    } else {
      value = input.cli[spec.key];
      from = 'default';
    }

    // The chosen preset itself has no layer to fall back to: it was resolved above.
    if (spec.key === 'preset') {
      options[spec.key] = chosenPreset?.value;
      provenance[spec.key] = chosenPreset?.from ?? 'default';
      continue;
    }

    options[spec.key] = from === 'default' ? value : validate(spec, value, label(spec, from, config, chosenPreset));
    provenance[spec.key] = from;
  }

  return { options, provenance, configPath: config?.path ?? null, configIgnored };
}

/**
 * Which preset applies, and where that choice came from. The config file is not
 * consulted: `preset` is refused there, so a repository cannot pick one for you.
 */
function selectPreset(
  input: ResolveInput,
  env: NodeJS.ProcessEnv,
): { value: string; from: Provenance } | null {
  if (input.isExplicit('preset')) {
    const value = input.cli['preset'];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new SafetyError(`--preset: expected a preset name, got ${show(value)}.`);
    }
    return { value: value.trim(), from: 'cli' };
  }
  const fromEnv = env['API_RECON_PRESET'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { value: fromEnv.trim(), from: 'env' };
  }
  return null;
}

/** Names the source in an error message, so a bad value is traceable. */
function label(
  spec: OptionSpec,
  from: Provenance,
  config: ProjectConfigFile | null,
  preset: { value: string } | null,
): string {
  if (from === 'config') return `${spec.key} in ${config?.path ?? 'the config file'}`;
  if (from === 'env') return `${spec.env}`;
  if (from === 'preset') return `preset "${preset?.value}"`;
  return `--${toKebabCase(spec.key)}`;
}

// ---- validation ------------------------------------------------------------

function validate(spec: OptionSpec, value: unknown, where: string): unknown {
  switch (spec.kind) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new SafetyError(`${where}: expected a non-negative integer, got ${show(value)}.`);
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new SafetyError(`${where}: expected a positive number, got ${show(value)}.`);
      }
      return value;
    }
    case 'bool': {
      if (typeof value !== 'boolean') {
        throw new SafetyError(`${where}: expected true or false, got ${show(value)}.`);
      }
      return value;
    }
    case 'list': {
      if (typeof value === 'string' && value.trim() !== '') return value;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        return value.join(',');
      }
      throw new SafetyError(
        `${where}: expected a comma-separated string or a list of strings, got ${show(value)}.`,
      );
    }
    case 'engine': {
      if (typeof value !== 'string') {
        throw new SafetyError(`${where}: expected a browser engine, got ${show(value)}.`);
      }
      try {
        return resolveEngine(value);
      } catch {
        throw new SafetyError(`${where}: expected one of chromium, firefox, webkit, got ${show(value)}.`);
      }
    }
    case 'path':
    case 'string': {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new SafetyError(`${where}: expected a non-empty string, got ${show(value)}.`);
      }
      return value;
    }
  }
}

function parseEnv(spec: OptionSpec, raw: string, name: string): unknown {
  switch (spec.kind) {
    case 'int':
    case 'number': {
      const number = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(number)) {
        throw new SafetyError(`${name}: expected a number, got "${raw}".`);
      }
      return number;
    }
    case 'bool': {
      const normalized = raw.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
      throw new SafetyError(`${name}: expected one of 1, 0, true, false, yes, no, on, off — got "${raw}".`);
    }
    case 'list':
      return raw;
    case 'engine':
    case 'path':
    case 'string':
      return raw;
  }
}

/** A relative path in the config file means "next to the config file". */
function resolveAgainst(dir: string, value: unknown, key: string, path: string): unknown {
  if (typeof value !== 'string' || isAbsolute(value)) return value;
  try {
    return resolve(dir, value);
  } catch {
    throw new SafetyError(`${key} in ${path}: could not resolve the relative path "${value}".`);
  }
}

// ---- helpers ---------------------------------------------------------------

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function toCamelCase(key: string): string {
  return key.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function toKebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function show(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === undefined) return 'nothing';
  return JSON.stringify(value) ?? String(value);
}
