import { describe, expect, it } from 'vitest';
import { ScanScope } from '../../src/core/scope.js';

describe('ScanScope hosts', () => {
  it('treats the seed host and its www form as in scope', () => {
    const scope = new ScanScope('https://app.example.com/start');
    expect(scope.allowsHost('https://app.example.com/other')).toBe(true);
    expect(scope.allowsHost('https://www.app.example.com/other')).toBe(true);
    expect(scope.allowsHost('https://evil.example.com/')).toBe(false);
    expect(scope.allowsHost('https://example.com/')).toBe(false);
  });

  it('adds hosts from --include-host in bare, host:port, and URL forms', () => {
    const scope = new ScanScope(
      'https://app.example.com',
      ['api.example.com', 'auth.example.com:8443', 'https://cdn.example.com/x'],
    );
    expect(scope.allowsHost('https://api.example.com/v1')).toBe(true);
    expect(scope.allowsHost('https://auth.example.com:8443/cb')).toBe(true);
    expect(scope.allowsHost('https://cdn.example.com/asset')).toBe(true);
    // A sibling that was not included is still out of scope.
    expect(scope.allowsHost('https://other.example.com/')).toBe(false);
  });

  it('ignores blank entries and treats a non-default port as a separate host', () => {
    const scope = new ScanScope('https://app.example.com', ['  ', 'api.example.com']);
    expect(scope.allowsHost('https://api.example.com/v1')).toBe(true);
    expect(scope.allowsHost('http://api.example.com:8080/')).toBe(false);
    expect(scope.allowsHost('https://app.example.com:9000/')).toBe(false);
  });

  it('includes a host on a specific port when one is given', () => {
    const scope = new ScanScope('http://127.0.0.1:4610', ['127.0.0.1:4611']);
    expect(scope.allowsHost('http://127.0.0.1:4611/sdk/config.json')).toBe(true);
    expect(scope.allowsHost('http://127.0.0.1:4612/')).toBe(false);
  });

  it('tolerates an invalid seed URL without throwing', () => {
    const scope = new ScanScope('not a url');
    expect(scope.allowsHost('https://example.com/')).toBe(false);
  });
});

describe('ScanScope paths', () => {
  it('skips an excluded path and everything under it', () => {
    const scope = new ScanScope('https://example.com', [], ['/admin', '/logout']);
    expect(scope.allowsPath('https://example.com/admin')).toBe(false);
    expect(scope.allowsPath('https://example.com/admin/users')).toBe(false);
    expect(scope.allowsPath('https://example.com/logout')).toBe(false);
    // A sibling whose name merely starts with the same letters is kept.
    expect(scope.allowsPath('https://example.com/administrators')).toBe(true);
    expect(scope.allowsPath('https://example.com/products')).toBe(true);
  });

  it('supports globs anchored to the whole pathname', () => {
    const scope = new ScanScope('https://example.com', [], ['*.pdf', '/orders/*/export']);
    expect(scope.allowsPath('https://example.com/docs/manual.pdf')).toBe(false);
    expect(scope.allowsPath('https://example.com/orders/42/export')).toBe(false);
    expect(scope.allowsPath('https://example.com/orders/42')).toBe(true);
    expect(scope.allowsPath('https://example.com/docs/manual.html')).toBe(true);
  });

  it('allows everything when nothing is excluded', () => {
    const scope = new ScanScope('https://example.com');
    expect(scope.allowsPath('https://example.com/anything')).toBe(true);
  });
});

describe('ScanScope.allows', () => {
  it('requires both an in-scope host and a non-excluded path', () => {
    const scope = new ScanScope('https://example.com', ['api.example.com'], ['/admin']);
    expect(scope.allows('https://example.com/products')).toBe(true);
    expect(scope.allows('https://api.example.com/v1')).toBe(true);
    expect(scope.allows('https://example.com/admin')).toBe(false);
    expect(scope.allows('https://other.example.com/')).toBe(false);
  });

  it('lists the hosts in scope', () => {
    const scope = new ScanScope('https://example.com', ['api.example.com']);
    expect(scope.hostList()).toEqual(['api.example.com', 'example.com']);
  });
});
