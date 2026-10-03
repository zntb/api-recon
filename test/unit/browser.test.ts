import { describe, expect, it } from 'vitest';
import {
  isBrowserEngine,
  resolveEngine,
  SESSION_LAUNCH_OPTIONS,
} from '../../src/core/browser.js';
import { BROWSER_ENGINES, CancelledError, SafetyError, scan } from '../../src/index.js';
import type { BrowserEngine } from '../../src/index.js';

describe('resolveEngine', () => {
  it('defaults to chromium when no engine is given', () => {
    expect(resolveEngine(undefined)).toBe('chromium');
  });

  it('accepts every advertised engine', () => {
    for (const engine of BROWSER_ENGINES) {
      expect(resolveEngine(engine)).toBe(engine);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveEngine('  Firefox ')).toBe('firefox');
    expect(resolveEngine('WEBKIT')).toBe('webkit');
  });

  it('rejects an unknown engine and lists the supported ones', () => {
    expect(() => resolveEngine('netscape')).toThrow(SafetyError);
    expect(() => resolveEngine('netscape')).toThrow(/chromium, firefox, webkit/);
  });

  it('rejects an empty engine string rather than silently defaulting', () => {
    expect(() => resolveEngine('')).toThrow(SafetyError);
  });
});

describe('isBrowserEngine', () => {
  it('narrows known engines and rejects everything else', () => {
    expect(isBrowserEngine('firefox')).toBe(true);
    expect(isBrowserEngine('chromium')).toBe(true);
    expect(isBrowserEngine('webkit')).toBe(true);
    expect(isBrowserEngine('safari')).toBe(false);
  });
});

describe('SESSION_LAUNCH_OPTIONS', () => {
  // Playwright's default SIGINT handling hard-exits with 130 the moment the
  // browser closes, which raced the flush of the partial report on Ctrl+C and
  // lost it. This asserts the option stays off, so restoring the default cannot
  // pass silently.
  it('keeps Playwright from exiting the process on SIGINT', () => {
    expect(SESSION_LAUNCH_OPTIONS.handleSIGINT).toBe(false);
  });
});

describe('scan() engine validation', () => {
  it('rejects an unknown engine before any network or browser work', async () => {
    // No allowLocal and an unreachable-by-design URL: if validation ran late,
    // this would surface a different error (the private-host guard or a
    // navigation failure) instead of the engine message.
    await expect(
      scan({ url: 'https://example.com', browser: 'netscape' as BrowserEngine }),
    ).rejects.toThrow(/Unknown browser engine/);
  });
});

describe('scan() cancellation', () => {
  // The OS-independent half of the SIGINT guarantee: an already-aborted signal
  // stops the scan on the library's own teardown path, without a browser and
  // without a signal, so this runs on Windows too (the CLI SIGINT test does
  // not). The mid-crawl case is covered by the browser suite.
  it('refuses to start and rejects with CancelledError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      scan({ url: 'https://example.com', signal: controller.signal }),
    ).rejects.toThrow(CancelledError);
  });
});
