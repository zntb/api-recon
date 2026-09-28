/**
 * Authentication: saved Playwright storageState, or a scripted login flow with
 * `${ENV_VAR}` substitution. Credential values are never logged.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { loadConfig } from '../utils/config.js';
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

/** Validate a storageState file and return its resolved path. */
export async function validateStorageState(filePath: string): Promise<string> {
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
  return resolved;
}

export async function loadLoginFlow(filePath: string): Promise<LoginFlowConfig> {
  const cfg = await loadConfig<LoginFlowConfig>(filePath);
  if (!cfg || typeof cfg.loginUrl !== 'string' || !Array.isArray(cfg.steps)) {
    throw new SafetyError(`login config must define 'loginUrl' and a 'steps' array: ${filePath}`);
  }
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

  if (config.saveStateTo) {
    const out = resolve(config.saveStateTo);
    await mkdir(dirname(out), { recursive: true });
    await context.storageState({ path: out });
    logger.success(`Session state saved to ${out}`);
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
