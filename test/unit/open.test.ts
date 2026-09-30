import { describe, expect, it, vi } from 'vitest';
import { openFile, openingDisabled, resolveOpener } from '../../src/utils/open.js';

describe('resolveOpener', () => {
  it('uses the desktop command for each platform', () => {
    expect(resolveOpener('darwin', {})).toEqual({ command: 'open', args: [] });
    expect(resolveOpener('linux', {})).toEqual({ command: 'xdg-open', args: [] });
    expect(resolveOpener('freebsd', {})).toEqual({ command: 'xdg-open', args: [] });
    // `start` is a shell builtin, and the empty argument is the window title.
    expect(resolveOpener('win32', {})).toEqual({ command: 'cmd', args: ['/c', 'start', ''] });
  });

  it('has nothing to offer on a platform it does not know', () => {
    expect(resolveOpener('aix', {})).toBeNull();
  });

  it('lets API_RECON_OPENER choose the program instead', () => {
    expect(resolveOpener('linux', { API_RECON_OPENER: 'wslview' })).toEqual({
      command: 'wslview',
      args: [],
    });
    // An override is honoured on every platform, including unknown ones.
    expect(resolveOpener('aix', { API_RECON_OPENER: ' custom ' })).toEqual({
      command: 'custom',
      args: [],
    });
  });
});

describe('openingDisabled', () => {
  it('reads the documented truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', ' True ']) {
      expect(openingDisabled({ API_RECON_NO_OPEN: value }), value).toBe(true);
    }
    for (const value of ['0', 'false', '', undefined]) {
      expect(openingDisabled({ API_RECON_NO_OPEN: value }), String(value)).toBe(false);
    }
  });
});

describe('openFile', () => {
  it('launches the platform command with the file last', async () => {
    const spawn = vi.fn();
    const opened = await openFile('/reports/dashboard.html', {
      platform: 'darwin',
      env: {},
      spawn,
    });

    expect(opened).toBe(true);
    expect(spawn).toHaveBeenCalledWith('open', ['/reports/dashboard.html']);
  });

  it('passes the title argument on Windows so a path with spaces survives', async () => {
    const spawn = vi.fn();
    await openFile('C:\\My Reports\\dashboard.html', { platform: 'win32', env: {}, spawn });

    expect(spawn).toHaveBeenCalledWith('cmd', [
      '/c',
      'start',
      '',
      'C:\\My Reports\\dashboard.html',
    ]);
  });

  it('does nothing at all when opening is disabled', async () => {
    const spawn = vi.fn();
    const opened = await openFile('/reports/dashboard.html', {
      platform: 'linux',
      env: { API_RECON_NO_OPEN: '1' },
      spawn,
    });

    expect(opened).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports failure rather than throwing when the launcher is missing', async () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT');
    });

    await expect(
      openFile('/reports/dashboard.html', { platform: 'linux', env: {}, spawn }),
    ).resolves.toBe(false);
  });

  it('returns false on a platform with no opener', async () => {
    const spawn = vi.fn();
    await expect(
      openFile('/reports/dashboard.html', { platform: 'aix', env: {}, spawn }),
    ).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
