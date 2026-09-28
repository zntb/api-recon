import { describe, expect, it } from 'vitest';
import { isBrowserEngine, resolveEngine } from '../../src/core/browser.js';
import { BROWSER_ENGINES, SafetyError, scan } from '../../src/index.js';
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
