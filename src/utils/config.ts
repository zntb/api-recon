/** Load JSON/YAML config files (login flows, action scripts). */

import { readFile } from 'node:fs/promises';
import { load as loadYaml, YAMLException } from 'js-yaml';
import { SafetyError } from './errors.js';

export type SourceFormat = 'yaml' | 'json';

/**
 * A parsed config file plus the text it came from, so a later validation error
 * can point at the line it was found on. `format` decides how a path is located
 * in `text`.
 */
export interface SourceDocument {
  value: unknown;
  text: string;
  format: SourceFormat;
  filePath: string;
}

/** True when a path is a YAML file by extension; anything else is JSON. */
export function sourceFormatOf(filePath: string): SourceFormat {
  return /\.ya?ml$/i.test(filePath) ? 'yaml' : 'json';
}

/**
 * Read and parse a config file, turning a read or syntax error into a
 * `SafetyError` that names the file and, for YAML, the offending line and
 * column. Validation of the parsed value happens separately.
 */
export async function loadDocument(filePath: string): Promise<SourceDocument> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new SafetyError(`config file not found: ${filePath}`, {
      hint: 'Check the path passed to --login or --actions.',
    });
  }

  const format = sourceFormatOf(filePath);
  let value: unknown;
  try {
    value = format === 'yaml' ? loadYaml(text, { filename: filePath }) : JSON.parse(text);
  } catch (err) {
    throw syntaxError(err, filePath, format, text);
  }
  return { value, text, format, filePath };
}

/** The 1-based line and column of a character offset in `text`. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function syntaxError(
  err: unknown,
  filePath: string,
  format: SourceFormat,
  text: string,
): SafetyError {
  if (format === 'yaml' && err instanceof YAMLException && err.mark) {
    const line = err.mark.line + 1;
    const column = err.mark.column + 1;
    const reason = err.reason ?? err.message.split('\n')[0] ?? err.message;
    return new SafetyError(`${filePath}:${line}:${column}: ${reason}`, {
      hint: 'Fix the YAML syntax and run again.',
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  if (format === 'json') {
    // Older V8 names the offset ("… at position N"); Node 22 dropped it for the
    // quoted token, so fall back to locating that token in the source.
    const positionMatch = /at position (\d+)/.exec(message);
    const tokenMatch = /Unexpected token '(.+?)'/.exec(message);
    const token = tokenMatch?.[1];
    const offset = positionMatch
      ? Number(positionMatch[1])
      : token !== undefined
        ? text.indexOf(token)
        : -1;
    if (offset >= 0) {
      const at = lineColumnAt(text, offset);
      const reason =
        token !== undefined ? `unexpected token ${JSON.stringify(token)}` : message.trim();
      return new SafetyError(`${filePath}:${at.line}:${at.column}: ${reason}`, {
        hint: 'Fix the JSON syntax and run again.',
      });
    }
  }
  return new SafetyError(`${filePath}: ${message}`, { hint: 'Fix the file and run again.' });
}

export async function loadConfig<T = unknown>(filePath: string): Promise<T> {
  return (await loadDocument(filePath)).value as T;
}
