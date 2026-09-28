import { describe, expect, it } from 'vitest';
import { assertScanAllowed, SafetyError } from '../../src/utils/safety.js';

describe('assertScanAllowed', () => {
  it('refuses localhost without allowLocal', () => {
    expect(() => assertScanAllowed('http://localhost:3000', { allowLocal: false })).toThrow(SafetyError);
    expect(() => assertScanAllowed('http://127.0.0.1:8080', { allowLocal: false })).toThrow(SafetyError);
  });

  it('allows localhost with allowLocal', () => {
    expect(() => assertScanAllowed('http://localhost:3000', { allowLocal: true })).not.toThrow();
    expect(() => assertScanAllowed('http://127.0.0.1:8080', { allowLocal: true })).not.toThrow();
  });

  it('refuses private ranges without allowLocal', () => {
    expect(() => assertScanAllowed('http://192.168.1.50', { allowLocal: false })).toThrow(SafetyError);
    expect(() => assertScanAllowed('http://10.0.0.3', { allowLocal: false })).toThrow(SafetyError);
  });

  it('allows public URLs regardless', () => {
    expect(() => assertScanAllowed('https://example.com', { allowLocal: false })).not.toThrow();
  });

  it('rejects invalid and non-http URLs', () => {
    expect(() => assertScanAllowed('not a url', { allowLocal: true })).toThrow(SafetyError);
    expect(() => assertScanAllowed('ftp://example.com', { allowLocal: true })).toThrow(SafetyError);
    expect(() => assertScanAllowed('file:///etc/passwd', { allowLocal: true })).toThrow(SafetyError);
  });
});
