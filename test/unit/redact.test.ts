import { describe, expect, it } from 'vitest';
import {
  isSensitiveHeader,
  isSensitiveScalar,
  isSensitiveValue,
  redactBody,
  redactHeaders,
  redactLogLine,
  REDACTED,
} from '../../src/utils/redact.js';

describe('redactHeaders', () => {
  it('redacts sensitive headers case-insensitively', () => {
    const out = redactHeaders({
      Authorization: 'Bearer abc123',
      'x-API-key': 'secret',
      cookie: 'a=b; c=d',
      'SET-COOKIE': 'sid=1',
      'Content-Type': 'application/json',
    });
    expect(out['Authorization']).toBe(REDACTED);
    expect(out['x-API-key']).toBe(REDACTED);
    expect(out['cookie']).toBe(REDACTED);
    expect(out['SET-COOKIE']).toBe(REDACTED);
    expect(out['Content-Type']).toBe('application/json');
  });

  it('does not mutate the input object', () => {
    const input = { Authorization: 'x' };
    redactHeaders(input);
    expect(input['Authorization']).toBe('x');
  });

  it('redacts proxy authorization and csrf variants', () => {
    const out = redactHeaders({ 'Proxy-Authorization': 'Basic zzz', 'X-Csrf-Token': 't' });
    expect(out['Proxy-Authorization']).toBe(REDACTED);
    expect(out['X-Csrf-Token']).toBe(REDACTED);
  });

  it('isSensitiveHeader matches exact names only', () => {
    expect(isSensitiveHeader('Cookie')).toBe(true);
    expect(isSensitiveHeader('x-custom-cookie-policy')).toBe(false);
    expect(isSensitiveHeader('Accept')).toBe(false);
  });
});

describe('redactBody', () => {
  it('masks values of sensitive keys in JSON bodies', () => {
    const body = JSON.stringify({ username: 'a', password: 'hunter2', nested: { token: 't' } });
    const out = redactBody(body);
    const parsed = JSON.parse(out!) as Record<string, unknown>;
    expect(parsed['username']).toBe('a');
    expect(parsed['password']).toBe(REDACTED);
    expect((parsed['nested'] as Record<string, unknown>)['token']).toBe(REDACTED);
  });

  it('masks camelCase and snake_case secret keys', () => {
    const body = JSON.stringify({
      api_key: 'k',
      accessToken: 'at',
      refresh_token: 'rt',
      apiKeyHint: 'kv',
      username: 'demo',
      itemCount: 3,
    });
    const parsed = JSON.parse(redactBody(body)!) as Record<string, unknown>;
    expect(parsed['api_key']).toBe(REDACTED);
    expect(parsed['accessToken']).toBe(REDACTED);
    expect(parsed['refresh_token']).toBe(REDACTED);
    expect(parsed['apiKeyHint']).toBe(REDACTED);
    expect(parsed['username']).toBe('demo');
    expect(parsed['itemCount']).toBe(3);
  });

  it('masks inside arrays', () => {
    const body = JSON.stringify([{ cvv: '123', keep: 1 }]);
    expect(JSON.parse(redactBody(body)!)).toEqual([{ cvv: REDACTED, keep: 1 }]);
  });

  it('leaves non-JSON bodies unchanged', () => {
    expect(redactBody('<html>hello</html>')).toBe('<html>hello</html>');
    expect(redactBody('plain text')).toBe('plain text');
    expect(redactBody(null)).toBeNull();
    expect(redactBody(undefined)).toBeNull();
    expect(redactBody('')).toBeNull();
  });

  it('leaves malformed JSON unchanged', () => {
    const body = '{not: valid json';
    expect(redactBody(body)).toBe(body);
  });

  it('passes through oversized bodies without parsing', () => {
    const big = JSON.stringify({ password: 'x' }) + ' '.repeat(600 * 1024);
    expect(redactBody(big)).toBe(big);
  });
});

describe('redactBody by value', () => {
  it('masks a JWT under a key that does not name a secret', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart';
    const parsed = JSON.parse(redactBody(JSON.stringify({ note: token }))!) as Record<string, unknown>;
    expect(parsed['note']).toBe(REDACTED);
  });

  it('masks a base64 blob and a hex digest found by shape', () => {
    const parsed = JSON.parse(
      redactBody(
        JSON.stringify({
          data: 'Zk9vYmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZg==',
          traceId: '8f14e45fceea167a5a36dedd4bea2543',
        }),
      )!,
    ) as Record<string, unknown>;
    expect(parsed['data']).toBe(REDACTED);
    expect(parsed['traceId']).toBe(REDACTED);
  });

  it('masks email, phone, and national-id shaped values anywhere', () => {
    const parsed = JSON.parse(
      redactBody(
        JSON.stringify({
          contact: 'jane.doe@example.com',
          phone: '+1 (415) 555-0199',
          ssn: '123-45-6789',
          keep: 'shipped',
        }),
      )!,
    ) as Record<string, unknown>;
    expect(parsed['contact']).toBe(REDACTED);
    expect(parsed['phone']).toBe(REDACTED);
    expect(parsed['ssn']).toBe(REDACTED);
    expect(parsed['keep']).toBe('shipped');
  });

  it('masks PII inside an array, and carries a sensitive key into nested values', () => {
    const parsed = JSON.parse(
      redactBody(JSON.stringify({ tags: ['a@b.com', 'tools'], credentials: { hint: 'demo' } }))!,
    ) as { tags: string[]; credentials: { hint: string } };
    expect(parsed.tags).toEqual([REDACTED, 'tools']);
    expect(parsed.credentials.hint).toBe(REDACTED);
  });

  it('leaves ordinary words, slugs, dates, and URLs alone', () => {
    const parsed = JSON.parse(
      redactBody(
        JSON.stringify({
          slug: 'my-super-long-dashboard-page-name',
          date: '2026-10-01',
          url: 'https://cdn.example.com/avatars/9b2f4a3e.png',
          word: 'internationalization',
          count: 12345678901234,
        }),
      )!,
    ) as Record<string, unknown>;
    expect(parsed['slug']).toBe('my-super-long-dashboard-page-name');
    expect(parsed['date']).toBe('2026-10-01');
    expect(parsed['url']).toBe('https://cdn.example.com/avatars/9b2f4a3e.png');
    expect(parsed['word']).toBe('internationalization');
    expect(parsed['count']).toBe(12345678901234);
  });

  it('replaces a non-JSON body only when the whole body is a secret', () => {
    expect(redactBody('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe(REDACTED);
    // An HTML page that merely mentions an address is left intact.
    const html = '<html>contact jane@example.com</html>';
    expect(redactBody(html)).toBe(html);
  });
});

describe('redactHeaders by value', () => {
  it('masks a secret value in a header it does not recognize by name', () => {
    const out = redactHeaders({
      'x-trace': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      accept: '*/*',
    });
    expect(out['x-trace']).toBe(REDACTED);
    expect(out['accept']).toBe('*/*');
  });
});

describe('isSensitiveValue', () => {
  it('recognizes secrets and PII by shape', () => {
    expect(isSensitiveValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe(true);
    expect(isSensitiveValue('sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0')).toBe(true);
    expect(isSensitiveValue('jane@example.com')).toBe(true);
    expect(isSensitiveValue('123-45-6789')).toBe(true);
    expect(isSensitiveValue('my-super-long-dashboard-page-name')).toBe(false);
    expect(isSensitiveValue('2026-10-01')).toBe(false);
    expect(isSensitiveValue('')).toBe(false);
  });

  it('is stricter about a whole-body scalar than about a value in a body', () => {
    // Prose mentioning an address is not itself a secret, so a whole non-JSON
    // body keeps it; the same text inside a JSON value is masked.
    expect(isSensitiveScalar('see jane@example.com for details')).toBe(false);
    expect(isSensitiveValue('see jane@example.com for details')).toBe(true);
  });
});

describe('redactLogLine', () => {
  it('masks env-style assignments', () => {
    expect(redactLogLine('logging in with PASSWORD=hunter2 now')).toBe(`logging in with PASSWORD=${REDACTED} now`);
  });

  it('masks bearer tokens', () => {
    const out = redactLogLine('sent Authorization: Bearer eyJhbGciOi.abc.def');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain(REDACTED);
  });

  it('leaves normal lines untouched', () => {
    const line = 'crawled /products with 200';
    expect(redactLogLine(line)).toBe(line);
  });
});
