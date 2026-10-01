import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isGroupOrWorldReadable, validateStorageState } from '../../src/core/authenticator.js';
import { Logger } from '../../src/utils/logger.js';

describe('isGroupOrWorldReadable', () => {
  it('flags any group or other permission bit', () => {
    expect(isGroupOrWorldReadable(0o600)).toBe(false);
    expect(isGroupOrWorldReadable(0o400)).toBe(false);
    expect(isGroupOrWorldReadable(0o640)).toBe(true);
    expect(isGroupOrWorldReadable(0o604)).toBe(true);
    expect(isGroupOrWorldReadable(0o777)).toBe(true);
  });
});

describe('validateStorageState', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-recon-auth-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the resolved path for a valid storage state', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ cookies: [], origins: [] }));
    await expect(validateStorageState(file)).resolves.toContain('state.json');
  });

  it('rejects a file that is not a storage state', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, JSON.stringify({ hello: 'world' }));
    await expect(validateStorageState(file)).rejects.toThrow(/cookies/);
  });

  it('rejects a missing file', async () => {
    await expect(validateStorageState(join(dir, 'missing.json'))).rejects.toThrow(/not found/);
  });

  it.runIf(process.platform !== 'win32')(
    'warns when the file is group- or world-readable',
    async () => {
      const file = join(dir, 'loose.json');
      await writeFile(file, JSON.stringify({ cookies: [] }));
      await chmod(file, 0o644);
      const lines: string[] = [];
      const logger = new Logger({ record: (line) => lines.push(line) });
      await validateStorageState(file, logger);
      expect(lines.join('\n')).toContain('group- or world-readable');
    },
  );

  it.runIf(process.platform !== 'win32')('stays quiet for an owner-only file', async () => {
    const file = join(dir, 'tight.json');
    await writeFile(file, JSON.stringify({ cookies: [] }));
    await chmod(file, 0o600);
    const lines: string[] = [];
    const logger = new Logger({ record: (line) => lines.push(line) });
    await validateStorageState(file, logger);
    expect(lines.join('\n')).not.toContain('world-readable');
  });
});
