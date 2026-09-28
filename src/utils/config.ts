/** Load JSON/YAML config files (login flows, action scripts). */

import { readFile } from 'node:fs/promises';
import { load as loadYaml } from 'js-yaml';

export async function loadConfig<T = unknown>(filePath: string): Promise<T> {
  const text = await readFile(filePath, 'utf8');
  if (/\.ya?ml$/i.test(filePath)) {
    return loadYaml(text) as T;
  }
  return JSON.parse(text) as T;
}
