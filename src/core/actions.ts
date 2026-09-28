/** Scripted interaction steps. Each step is resilient: failures log and continue. */

import type { Page } from 'playwright';
import { loadConfig } from '../utils/config.js';
import { substituteEnv } from '../utils/misc.js';
import type { Logger } from '../utils/logger.js';
import { SafetyError } from '../utils/safety.js';

export type ActionStep =
  | { click: string }
  | { fill: { selector: string; value: string } }
  | { submit: string }
  | { wait: number }
  | { waitForSelector: string }
  | { scroll: { to: 'top' | 'bottom' } | string }
  | { navigate: string }
  | { press: { selector: string; key: string } };

const STEP_TIMEOUT = 8_000;

export async function loadActions(filePath: string): Promise<ActionStep[]> {
  const cfg = await loadConfig<unknown>(filePath);
  const steps = Array.isArray(cfg) ? cfg : (cfg as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) {
    throw new SafetyError(`actions file must be a list of steps (or { steps: [...] }): ${filePath}`);
  }
  return steps as ActionStep[];
}

/**
 * Run every step, logging failures and continuing. Never throws: a broken
 * selector must not abort the whole scan.
 */
export async function runActions(page: Page, steps: ActionStep[], logger: Logger): Promise<void> {
  for (const [index, step] of steps.entries()) {
    try {
      await runAction(page, step);
      logger.debug(`action ${index + 1} ok: ${describeStep(step)}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.warn(`action ${index + 1} failed (${describeStep(step)}): ${detail} — continuing`);
    }
  }
}

async function runAction(page: Page, step: ActionStep): Promise<void> {
  if ('click' in step) {
    await page.click(step.click, { timeout: STEP_TIMEOUT });
    return;
  }
  if ('fill' in step) {
    await page.fill(step.fill.selector, substituteEnv(step.fill.value), { timeout: STEP_TIMEOUT });
    return;
  }
  if ('submit' in step) {
    await page.locator(step.submit).evaluate((el) => {
      const form = el instanceof HTMLFormElement ? el : el.closest('form');
      if (form) form.requestSubmit();
    });
    return;
  }
  if ('wait' in step) {
    await page.waitForTimeout(Math.min(Math.max(step.wait, 0), 15_000));
    return;
  }
  if ('waitForSelector' in step) {
    await page.waitForSelector(step.waitForSelector, { timeout: STEP_TIMEOUT });
    return;
  }
  if ('scroll' in step) {
    const target = step.scroll;
    if (typeof target === 'string') {
      await page.locator(target).first().scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT });
    } else {
      await page.evaluate((where) => {
        if (where === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else window.scrollTo(0, 0);
      }, target.to);
    }
    return;
  }
  if ('navigate' in step) {
    const target = new URL(substituteEnv(step.navigate), page.url()).toString();
    await page.goto(target, { waitUntil: 'load', timeout: 30_000 });
    return;
  }
  if ('press' in step) {
    await page.press(step.press.selector, step.press.key, { timeout: STEP_TIMEOUT });
    return;
  }
  throw new SafetyError(`unknown action step: ${JSON.stringify(step)}`);
}

export function describeStep(step: ActionStep): string {
  if ('click' in step) return `click ${step.click}`;
  if ('fill' in step) return `fill ${step.fill.selector}`;
  if ('submit' in step) return `submit ${step.submit}`;
  if ('wait' in step) return `wait ${step.wait}ms`;
  if ('waitForSelector' in step) return `waitForSelector ${step.waitForSelector}`;
  if ('scroll' in step) return `scroll ${typeof step.scroll === 'string' ? step.scroll : step.scroll.to}`;
  if ('navigate' in step) return `navigate ${step.navigate}`;
  if ('press' in step) return `press ${step.press.key}`;
  return 'unknown step';
}
