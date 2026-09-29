import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/reporters/markdown.js';
import { diffReports } from '../../src/core/diff.js';
import type { ReconReport } from '../../src/types.js';

function report(overrides: Partial<ReconReport> = {}): ReconReport {
  return {
    meta: {
      seedUrl: 'https://example.com',
      startedAt: '2026-09-01T00:00:00.000Z',
      durationMs: 1000,
      pagesVisited: 1,
      apiReconVersion: '0.2.2',
      engine: 'chromium',
    },
    technologies: [],
    endpoints: [],
    pages: [],
    webSockets: [],
    safety: {
      robotsRespected: true,
      robotsSkippedPaths: [],
      rateLimitMs: 500,
      maxBodyBytes: 1048576,
      allowLocal: false,
      redact: true,
    },
    ...overrides,
  };
}

describe('renderMarkdown', () => {
  it('warns when the baseline ran in a different engine', () => {
    const current = report({ meta: { ...report().meta, engine: 'firefox' } });
    const md = renderMarkdown(report({ diff: diffReports(report(), current) }));

    expect(md).toContain('## 9. Changes Since Baseline');
    expect(md).toContain('the baseline ran in **chromium** and this scan in **firefox**');
  });

  it('does not warn when both scans used the same engine', () => {
    const md = renderMarkdown(report({ diff: diffReports(report(), report()) }));
    expect(md).not.toContain('engine-specific');
  });

  it('renders captured WebSocket frames as their own section', () => {
    const md = renderMarkdown(
      report({
        webSockets: [
          {
            url: 'wss://example.com/live',
            origins: ['wss://example.com'],
            triggeredBy: 'https://example.com/',
            openedAt: 0,
            closedAt: 5,
            frameCount: 1,
            sentCount: 1,
            receivedCount: 0,
            framesTruncated: false,
            frames: [
              {
                direction: 'sent',
                type: 'text',
                payloadSample: '{"subscribe":true,"token":"[REDACTED]"}',
                size: 40,
                truncated: false,
                at: 1,
              },
            ],
            sentSchema: {
              type: 'object',
              properties: { subscribe: { type: 'boolean' } },
            },
            receivedSchema: null,
          },
        ],
      }),
    );

    expect(md).toContain('## 8. WebSocket Traffic');
    expect(md).toContain('wss://example.com/live');
    expect(md).toContain('[REDACTED]');
    expect(md).toContain('**Inferred sent message schema**');
    expect(md).toContain('"subscribe"');
  });
});
