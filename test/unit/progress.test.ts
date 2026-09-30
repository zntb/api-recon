import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveProgress,
  buildSnapshot,
  formatProgressEvent,
  formatProgressTable,
  progressModeFor,
  type ProgressSnapshot,
  type ProgressStream,
} from '../../src/utils/progress.js';
import type { CapturedCall, CapturedPage, ScanProgressState } from '../../src/types.js';

function page(url: string, depth = 0): CapturedPage {
  return { url, normalizedUrl: url, depth, title: null, visitedAt: 0 };
}

function call(method: string, url: string): CapturedCall {
  return {
    method,
    url,
    status: 200,
    mimeType: 'application/json',
    resourceType: 'xhr',
    requestHeaders: {},
    requestBodySample: null,
    responseHeaders: {},
    responseBodySample: '{}',
    responseBodyTruncated: false,
    startedAt: 0,
    durationMs: 5,
    triggeredBy: url,
  };
}

function state(overrides: Partial<ScanProgressState> = {}): ScanProgressState {
  return {
    phase: 'crawling',
    seedUrl: 'http://127.0.0.1:4610',
    pages: [],
    maxPages: 25,
    calls: [],
    startedAt: 1_000,
    ...overrides,
  };
}

/** A stream that records what was written, so the frames can be inspected. */
function sink(isTTY = true): { out: string[]; stream: ProgressStream } {
  const out: string[] = [];
  return { out, stream: { isTTY, columns: 60, write: (chunk: string) => out.push(chunk) } };
}

describe('progressModeFor', () => {
  it('uses a table on a terminal and nothing when piped', () => {
    expect(progressModeFor({ stream: { isTTY: true, write: () => {} } })).toBe('tty');
    expect(progressModeFor({ stream: { isTTY: false, write: () => {} } })).toBe('none');
  });

  it('treats --quiet as silent, and --json-progress as an explicit request', () => {
    expect(progressModeFor({ quiet: true, stream: { isTTY: true, write: () => {} } })).toBe('none');
    // Machine output is the point of the flag, so it outranks --quiet.
    expect(
      progressModeFor({ json: true, quiet: true, stream: { isTTY: false, write: () => {} } }),
    ).toBe('json');
  });
});

describe('buildSnapshot', () => {
  it('counts pages, requests, and distinct endpoints as they arrive', () => {
    const snapshot = buildSnapshot(
      state({
        pages: [page('http://127.0.0.1:4610/'), page('http://127.0.0.1:4610/products', 1)],
        calls: [
          call('GET', 'http://127.0.0.1:4610/api/products'),
          // Two ids of the same route: one endpoint, two requests.
          call('GET', 'http://127.0.0.1:4610/api/orders/42'),
          call('GET', 'http://127.0.0.1:4610/api/orders/7'),
          call('POST', 'http://127.0.0.1:4610/api/collect'),
        ],
      }),
      { now: 3_500 },
    );

    expect(snapshot.pagesVisited).toBe(2);
    expect(snapshot.maxPages).toBe(25);
    expect(snapshot.calls).toBe(4);
    expect(snapshot.endpoints).toBe(3);
    expect(snapshot.elapsedMs).toBe(2_500);
    expect(snapshot.currentPage).toBe('/products');
  });

  it('shows the most recent rows first, capped to the reserved height', () => {
    const snapshot = buildSnapshot(
      state({
        pages: [
          page('http://x.test/a'),
          page('http://x.test/b', 1),
          page('http://x.test/c', 1),
          page('http://x.test/d', 2),
        ],
        calls: ['/api/one', '/api/two', '/api/three', '/api/four'].map((p) => call('GET', `http://x.test${p}`)),
      }),
      { now: 1_000, rows: 2 },
    );

    expect(snapshot.recentPages).toEqual([
      { label: '/d', depth: 2 },
      { label: '/c', depth: 1 },
    ]);
    expect(snapshot.recentEndpoints).toEqual(['GET /api/four', 'GET /api/three']);
  });

  it('has no current page before the first one loads', () => {
    expect(buildSnapshot(state(), { now: 1_000 }).currentPage).toBeNull();
  });
});

describe('formatProgressTable', () => {
  const snapshot: ProgressSnapshot = buildSnapshot(
    state({
      pages: [page('http://127.0.0.1:4610/'), page('http://127.0.0.1:4610/dashboard', 1)],
      calls: [call('GET', 'http://127.0.0.1:4610/api/user')],
    }),
    { now: 4_000 },
  );

  it('draws the running table with its counts and rows', () => {
    const table = formatProgressTable(snapshot, { rows: 3, columns: 80 });
    expect(table).toContain('api-recon · crawling · 127.0.0.1:4610 · 3.0s');
    expect(table).toContain('pages 2/25');
    expect(table).toContain('requests 1');
    expect(table).toContain('endpoints 1');
    expect(table).toContain('/dashboard  (depth 1)');
    expect(table).toContain('GET /api/user');
  });

  it('is always the same height, so the redraw cannot leave stragglers', () => {
    const rows = 3;
    expect(formatProgressTable(snapshot, { rows }).split('\n')).toHaveLength(5 + rows * 2);
    // Empty report, same height.
    const empty = buildSnapshot(state(), { now: 1_000 });
    expect(formatProgressTable(empty, { rows }).split('\n')).toHaveLength(5 + rows * 2);
  });

  it('truncates a label wider than the terminal', () => {
    const wide = buildSnapshot(state({ calls: [call('GET', `http://x.test/${'seg/'.repeat(40)}end`)] }), {
      now: 1_000,
    });
    const table = formatProgressTable(wide, { rows: 3, columns: 40 });
    // Measure what the terminal shows, not the colour codes around it.
    const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, '');
    for (const line of table.split('\n')) {
      expect(plain(line).length, line).toBeLessThanOrEqual(38);
    }
    expect(table).toContain('…');
  });
});

describe('formatProgressEvent', () => {
  it('is one JSON object per line, with the counts a consumer needs', () => {
    const snapshot = buildSnapshot(
      state({ pages: [page('http://127.0.0.1:4610/products')], calls: [call('GET', 'http://x.test/a')] }),
      { now: 2_000 },
    );
    const event = JSON.parse(formatProgressEvent(snapshot)) as Record<string, unknown>;

    expect(event['event']).toBe('progress');
    expect(event['phase']).toBe('crawling');
    expect(event['pagesVisited']).toBe(1);
    expect(event['maxPages']).toBe(25);
    expect(event['calls']).toBe(1);
    expect(event['endpoints']).toBe(1);
    expect(event['elapsedMs']).toBe(1_000);
    expect(event['currentPage']).toBe('/products');
    expect(formatProgressEvent(snapshot, 'done')).toContain('"event":"done"');
  });
});

describe('LiveProgress', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('redraws the table in place and hands the terminal back on stop', () => {
    const { out, stream } = sink();
    let clock = 1_000;
    const progress = new LiveProgress({ mode: 'tty', stream, now: () => clock, rows: 2, intervalMs: 100 });

    progress.render(state({ pages: [page('http://127.0.0.1:4610/')] }));
    const first = out.join('');
    expect(first).toContain('api-recon · crawling');
    expect(first).not.toContain('\u001b[1A');

    // A second state inside the throttle window does not repaint…
    const beforeSecond = out.length;
    clock += 10;
    progress.render(state({ pages: [page('http://127.0.0.1:4610/a'), page('http://127.0.0.1:4610/b')] }));
    expect(out.length).toBe(beforeSecond);

    // …but past it, it moves the cursor up by the table's height and redraws.
    clock += 200;
    progress.render(state({ pages: [page('http://127.0.0.1:4610/a'), page('http://127.0.0.1:4610/b')] }));
    const second = out.slice(beforeSecond).join('');
    expect(second).toContain('\u001b[9A');
    expect(second).toContain('/b');

    progress.stop();
    const tail = out.join('');
    expect(tail).toContain('\u001b[2K');
    // Cleared and left at the top of the block: the summary prints over it.
    expect(tail.trimEnd().endsWith('\u001b[9A')).toBe(true);
  });

  it('keeps repainting while a slow page loads', () => {
    vi.useFakeTimers();
    const { out, stream } = sink();
    const progress = new LiveProgress({ mode: 'tty', stream, now: () => Date.now(), intervalMs: 50, rows: 2 });

    progress.render(state({ startedAt: Date.now() }));
    expect(out.length).toBeGreaterThan(0);
    const afterFirst = out.length;
    vi.advanceTimersByTime(120);
    expect(out.length).toBeGreaterThan(afterFirst);
    progress.stop();
  });

  it('streams JSON lines and closes with a done event', () => {
    const { out, stream } = sink(false);
    const progress = new LiveProgress({ mode: 'json', stream, now: () => 2_000, intervalMs: 0 });

    progress.render(state({ pages: [page('http://127.0.0.1:4610/')] }));
    progress.stop();

    const lines = out.join('').trim().split('\n');
    expect(lines).toHaveLength(2);
    const events = lines.map((line) => JSON.parse(line) as { event: string; pagesVisited: number });
    expect(events[0]!.event).toBe('progress');
    expect(events[0]!.pagesVisited).toBe(1);
    expect(events[1]!.event).toBe('done');
    expect(out.join('')).not.toContain('\u001b[');
  });

  it('writes nothing at all when the mode is none', () => {
    const { out, stream } = sink();
    const progress = new LiveProgress({ mode: 'none', stream, now: () => 1_000 });

    expect(progress.mode).toBe('none');
    progress.render(state());
    progress.stop();
    expect(out).toEqual([]);
  });

  it('defaults to a table only on a terminal', () => {
    expect(new LiveProgress({ stream: sink(true).stream }).mode).toBe('tty');
    expect(new LiveProgress({ stream: sink(false).stream }).mode).toBe('none');
  });
});
