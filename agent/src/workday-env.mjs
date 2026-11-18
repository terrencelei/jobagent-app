// the user's one Workday password, used with his email on every tenant. It lives in
// private/workday.env (gitignored, mode 600) as WORKDAY_PASSWORD=..., written by him; nothing here
// ever prints it.
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const WORKDAY_ENV = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'private/workday.env');

export function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export async function sharedWorkdayPassword(path = WORKDAY_ENV) {
  if (process.env.WORKDAY_PASSWORD) return process.env.WORKDAY_PASSWORD;
  try { return parseEnv(await readFile(path, 'utf8')).WORKDAY_PASSWORD || null; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
