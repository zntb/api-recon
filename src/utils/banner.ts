/**
 * First-run acceptable-use banner, persisted via a marker file so it does not
 * spam every run. In sandboxed environments without HOME, fall back to a
 * process-local flag.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACCEPTABLE_USE_BANNER, Logger } from './logger.js';

const CONFIG_DIR = join(homedir() ?? '/tmp', '.api-recon');
const SEEN_FILE = join(CONFIG_DIR, 'config.json');

export function shouldShowBanner(): boolean {
  try {
    if (existsSync(SEEN_FILE)) {
      const cfg = JSON.parse(readFileSync(SEEN_FILE, 'utf8')) as { bannerSeen?: boolean };
      return !cfg.bannerSeen;
    }
    return true;
  } catch {
    return true;
  }
}

export function markBannerSeen(): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    let cfg: Record<string, unknown> = {};
    if (existsSync(SEEN_FILE)) {
      cfg = JSON.parse(readFileSync(SEEN_FILE, 'utf8')) as Record<string, unknown>;
    }
    cfg.bannerSeen = true;
    writeFileSync(SEEN_FILE, JSON.stringify(cfg, null, 2));
  } catch {
    /* non-fatal */
  }
}

/** Print the banner once per machine (or once per process as fallback). */
export function showBannerOnce(logger: Logger): void {
  if (shouldShowBanner()) {
    logger.always(ACCEPTABLE_USE_BANNER);
    markBannerSeen();
  }
}
