import { describe, expect, it } from 'vitest';
import { isSensitiveHeader, redactBody, redactHeaders, redactLogLine, REDACTED } from '../../src/utils/redact.js';

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
