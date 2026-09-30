/**
 * Hand a finished report to the user's own browser.
 *
 * `--open` is the last step of an interactive run, so it has to work the way the
 * desktop does: `open` on macOS, `start` through the shell on Windows, and
 * `xdg-open` everywhere else. It is deliberately best-effort — a headless box, a
 * container, or a WSL session may have none of those — so the caller gets a
 * boolean and can print the path instead of failing the run.
 *
 * Two environment hooks keep it controllable without new flags:
 *   API_RECON_OPENER   the program to run instead of the platform default
 *   API_RECON_NO_OPEN  set to 1 to resolve the path without launching anything
 *                      (for CI and sandboxes, where nothing can be opened)
 */

import { spawn } from 'node:child_process';

export interface OpenerCommand {
  command: string;
  /** Arguments *before* the file path. */
  args: string[];
}

export interface OpenOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to `child_process.spawn`. */
  spawn?: (command: string, args: string[]) => unknown;
}

/** The command that opens a file, or null when the platform gives us nothing. */
export function resolveOpener(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): OpenerCommand | null {
  const override = env['API_RECON_OPENER']?.trim();
  if (override) return { command: override, args: [] };
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') {
    // `start` is a shell builtin, and the empty argument is the window title —
    // without it, a quoted path would be taken for one.
    return { command: 'cmd', args: ['/c', 'start', ''] };
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { command: 'xdg-open', args: [] };
  }
  return null;
}

/** True when launching is suppressed by `API_RECON_NO_OPEN`. */
export function openingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['API_RECON_NO_OPEN']?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Open `file` in whatever the platform uses. Resolves to false — never throws —
 * when opening is disabled, unsupported, or the launcher is missing, because a
 * report that was written is a success even if nobody looked at it.
 */
export async function openFile(file: string, options: OpenOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (openingDisabled(env)) return false;

  const opener = resolveOpener(options.platform ?? process.platform, env);
  if (!opener) return false;

  const run =
    options.spawn ??
    ((command: string, args: string[]) =>
      spawn(command, args, { detached: true, stdio: 'ignore' }).unref());

  try {
    run(opener.command, [...opener.args, file]);
    return true;
  } catch {
    return false;
  }
}
