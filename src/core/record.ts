/**
 * Interactive recording mode: a human drives a real browser while the tool
 * captures XHR/fetch traffic. The session ends when the user types `done`
 * (Enter) or presses Ctrl+C.
 */

import { createInterface } from 'node:readline';
import type { Page } from 'playwright';
import type { CapturedPage } from '../types.js';
import { normalizeUrl } from '../utils/url.js';
import type { Logger } from '../utils/logger.js';

export const RECORD_INSTRUCTIONS = `
  Recording mode — a browser window is opening for you.

  Browse the site normally (click, search, log in, paginate…). Every XHR/fetch
  call is captured as you go. The session respects your redaction settings.

  When you are finished:
    • type  done  and press Enter, or
    • press Ctrl+C

  A report is written to disk as soon as the session ends.
`;

export interface RecordSessionOptions {
  page: Page;
  seedUrl: string;
  logger: Logger;
  /** Cap on pages recorded, so a long interactive session stays bounded. */
  maxPages?: number;
  /** Override for tests. Defaults to reading process.stdin. */
  waitForStop?: () => Promise<void>;
  /** Fired for every page the human navigates to, so progress can keep up. */
  onPage?: (page: CapturedPage) => void;
}

export async function runRecordSession(options: RecordSessionOptions): Promise<CapturedPage[]> {
  const { page, seedUrl, logger } = options;
  const pages = new Map<string, CapturedPage>();

  const record = (url: string): void => {
    if (!url || url === 'about:blank') return;
    const normalized = normalizeUrl(url);
    if (!pages.has(normalized)) {
      if (options.maxPages !== undefined && pages.size >= options.maxPages) return;
      const entry: CapturedPage = {
        url,
        normalizedUrl: normalized,
        depth: 0,
        title: null,
        visitedAt: Date.now(),
      };
      pages.set(normalized, entry);
      options.onPage?.(entry);
    }
  };

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) record(frame.url());
  });

  logger.always(RECORD_INSTRUCTIONS);
  try {
    await page.goto(seedUrl, { waitUntil: 'load', timeout: 30_000 });
  } catch (err) {
    logger.warn(`could not load seed URL: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  record(page.url());

  await (options.waitForStop ?? waitForDone)(logger);
  record(page.url());
  return [...pages.values()];
}

/** Resolve when the user types `done` or interrupts with Ctrl+C. */
export function waitForDone(logger: Logger, input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const rl = createInterface({ input, terminal: false });

    const finish = (reason: string): void => {
      if (finished) return;
      finished = true;
      logger.always(`\nRecord mode finished (${reason}). Building report…`);
      if (autoStopTimer) clearTimeout(autoStopTimer);
      rl.close();
      process.off('SIGINT', onSigint);
      resolve();
    };
    const onSigint = (): void => finish('Ctrl+C');

    // Automation hook: bound the session length for scripted runs.
    const autoStopMs = Number(process.env.API_RECON_RECORD_AUTOSTOP_MS ?? '');
    const autoStopTimer =
      Number.isFinite(autoStopMs) && autoStopMs > 0
        ? setTimeout(() => finish(`auto-stop after ${autoStopMs}ms`), autoStopMs)
        : null;

    rl.on('line', (line) => {
      if (line.trim().toLowerCase() === 'done') finish("'done' received");
    });
    rl.on('close', () => finish('input closed'));
    process.on('SIGINT', onSigint);
  });
}
