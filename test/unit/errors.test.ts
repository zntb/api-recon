import { describe, expect, it } from 'vitest';
import {
  ApiReconError,
  RuntimeError,
  SafetyError,
  hintForError,
} from '../../src/utils/errors.js';
import { attachDebugInfo, debugInfoFor } from '../../src/utils/debug.js';

describe('typed errors', () => {
  it('names the subclass, so an uncaught error reads as what it is', () => {
    expect(new SafetyError('no').name).toBe('SafetyError');
    expect(new RuntimeError('no').name).toBe('RuntimeError');
    expect(new SafetyError('no')).toBeInstanceOf(ApiReconError);
  });

  it('carries an optional hint and cause', () => {
    const cause = new Error('root cause');
    const err = new SafetyError('bad value', { hint: 'try X instead', cause });

    expect(err.hint).toBe('try X instead');
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('bad value');
  });

  it('omits the hint property when none is given', () => {
    expect(new SafetyError('no hint').hint).toBeUndefined();
  });
});

describe('hintForError', () => {
  it('prefers the error’s own hint', () => {
    expect(hintForError(new SafetyError('x', { hint: 'do y' }))).toBe('do y');
  });

  it('falls back by class, so every error ends in a next step', () => {
    expect(hintForError(new SafetyError('x'))).toMatch(/--verbose/);
    expect(hintForError(new Error('x'))).toMatch(/--debug/);
    expect(hintForError('boom')).toMatch(/--debug/);
  });
});

describe('debug artifact attachment', () => {
  it('attaches artifacts to an error and reads them back', () => {
    const err = new Error('boom');
    attachDebugInfo(err, { dir: '/tmp/x', trace: '/tmp/x/trace.zip' });

    expect(debugInfoFor(err)).toEqual({ dir: '/tmp/x', trace: '/tmp/x/trace.zip' });
  });

  it('returns undefined for an error with no bundle, and for non-objects', () => {
    expect(debugInfoFor(new Error('x'))).toBeUndefined();
    expect(debugInfoFor('boom')).toBeUndefined();
    expect(debugInfoFor(null)).toBeUndefined();
  });
});
