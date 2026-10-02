/**
 * Authentication: saved Playwright storageState, or a scripted login flow with
 * `${ENV_VAR}` substitution. Credential values are never logged. A saved
 * session is written owner-only, an existing `--auth` file is checked for
 * loose permissions, and nothing is persisted unless the login config's
 * `saveStateTo` asks for it.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { loadDocument } from '../utils/config.js';
import {
  checkDocument,
  stringObject,
  type StepSpec,
  type ValueKind,
} from '../utils/configSchema.js';
import { substituteEnv } from '../utils/misc.js';
import type { Logger } from '../utils/logger.js';
import { SafetyError } from '../utils/safety.js';

export type LoginStep =
  | { fill: { selector: string; value: string } }
  | { click: string }
  | { submit: string }
  | { waitForURL: string }
  | { waitForSelector: string }
  | { waitForTimeout: number };

export interface LoginFlowConfig {
  loginUrl: string;
  steps: LoginStep[];
  saveStateTo?: string;
}

const STEP_TIMEOUT = 15_000;

/** True when a POSIX file mode lets group or other readers in. */
export function isGroupOrWorldReadable(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/** Validate a storageState file and return its resolved path. */
export async function validateStorageState(filePath: string, logger?: Logger): Promise<string> {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    throw new SafetyError(`storage state file not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch {
    throw new SafetyError(`storage state file is not valid JSON: ${filePath}`);
  }
  const shape = parsed as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(shape.cookies) && !Array.isArray(shape.origins)) {
    throw new SafetyError(
      `storage state file must contain a cookies[] and/or origins[] array: ${filePath}`,
    );
  }
  // A storage state is a live session: warn if the file is readable by others.
  // POSIX modes only; Windows reports a synthetic mode that would always warn.
  if (logger && process.platform !== 'win32') {
    try {
      const info = await stat(resolved);
      if (isGroupOrWorldReadable(info.mode)) {
        const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
        logger.warn(
          `--auth file ${resolved} is group- or world-readable (mode ${mode}) and holds ` +
            'session cookies — restrict it with `chmod 600` so other users cannot read it.',
        );
      }
    } catch {
      /* the mode check is best-effort; a missing file is caught above */
    }
  }
  return resolved;
}

/** The step kinds a login flow may use, and the shape of each one's value. */
const LOGIN_STEP_SPECS: StepSpec[] = [
  { key: 'fill', kind: stringObject({ selector: 'string', value: 'string' }) },
  { key: 'click', kind: { kind: 'string' } },
  { key: 'submit', kind: { kind: 'string' } },
  { key: 'waitForURL', kind: { kind: 'string' } },
  { key: 'waitForSelector', kind: { kind: 'string' } },
  { key: 'waitForTimeout', kind: { kind: 'number' } },
];

const LOGIN_SCHEMA: ValueKind = {
  kind: 'object',
  fields: [
    { name: 'loginUrl', kind: { kind: 'string' } },
    { name: 'steps', kind: { kind: 'array', of: { kind: 'step', specs: LOGIN_STEP_SPECS } } },
    { name: 'saveStateTo', kind: { kind: 'string' }, optional: true },
  ],
};

/**
 * Load and validate a login flow, so a malformed step is a startup error that
 * names its path and line rather than a failure part-way through a login.
 */
export async function loadLoginFlow(filePath: string): Promise<LoginFlowConfig> {
  const doc = await loadDocument(filePath);
  checkDocument(doc, LOGIN_SCHEMA);
  const cfg = doc.value as LoginFlowConfig;
  return {
    loginUrl: substituteEnv(cfg.loginUrl),
    steps: cfg.steps,
    ...(cfg.saveStateTo ? { saveStateTo: substituteEnv(cfg.saveStateTo) } : {}),
  };
}

/** Execute the configured login steps, then optionally persist the session. */
export async function runLoginFlow(
  context: BrowserContext,
  config: LoginFlowConfig,
  logger: Logger,
): Promise<void> {
  const page = await context.newPage();
  logger.info(`Running login flow at ${config.loginUrl}`);
  await page.goto(config.loginUrl, { waitUntil: 'load', timeout: 30_000 });

  for (const [index, step] of config.steps.entries()) {
    try {
      await runLoginStep(page, step);
      logger.debug(`login step ${index + 1} ok: ${describeStep(step)}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new SafetyError(`login step ${index + 1} (${describeStep(step)}) failed: ${detail}`);
    }
  }

  // Persisting a session is opt-in: only a `saveStateTo` in the login config
  // writes the storage state. When it does, keep it owner-only, since it holds
  // live cookies that authenticate as the user the flow logged in as.
  if (config.saveStateTo) {
    const out = resolve(config.saveStateTo);
    await mkdir(dirname(out), { recursive: true });
    await context.storageState({ path: out });
    try {
      await chmod(out, 0o600);
    } catch {
      /* filesystems without POSIX modes (e.g. Windows) are left as-is */
    }
    logger.success(`Session state saved to ${out} (owner-only)`);
  }
  await page.close().catch(() => {});
}

async function runLoginStep(page: Page, step: LoginStep): Promise<void> {
  if ('fill' in step) {
    // The value may be a secret: never log it.
    await page.fill(step.fill.selector, substituteEnv(step.fill.value), { timeout: STEP_TIMEOUT });
    return;
  }
  if ('click' in step) {
    await page.click(step.click, { timeout: STEP_TIMEOUT });
    return;
  }
  if ('submit' in step) {
    await submitForm(page, step.submit);
    return;
  }
  if ('waitForURL' in step) {
    await page.waitForURL(substituteEnv(step.waitForURL), { timeout: STEP_TIMEOUT });
    return;
  }
  if ('waitForSelector' in step) {
    await page.waitForSelector(step.waitForSelector, { timeout: STEP_TIMEOUT });
    return;
  }
  if ('waitForTimeout' in step) {
    await page.waitForTimeout(step.waitForTimeout);
    return;
  }
  throw new SafetyError(`unknown login step: ${JSON.stringify(step)}`);
}

export async function submitForm(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((el) => {
    const form = el instanceof HTMLFormElement ? el : el.closest('form');
    if (form) form.requestSubmit();
  });
}

/** Human-readable step label without any secret values. */
export function describeStep(step: LoginStep): string {
  if ('fill' in step) return `fill ${step.fill.selector}`;
  if ('click' in step) return `click ${step.click}`;
  if ('submit' in step) return `submit ${step.submit}`;
  if ('waitForURL' in step) return `waitForURL ${step.waitForURL}`;
  if ('waitForSelector' in step) return `waitForSelector ${step.waitForSelector}`;
  if ('waitForTimeout' in step) return `waitForTimeout ${step.waitForTimeout}ms`;
  return 'unknown step';
}
