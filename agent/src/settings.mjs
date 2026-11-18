// His dashboard settings (JobAgent's Settings panel). JobAgent publishes the effective value of
// every setting in its data/settings.json; the application agent reads the ones it uses from there,
// falling back to the defaults written here when JobAgent is not installed alongside.
import {readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const SETTINGS_PATH = process.env.JOBAGENT_SETTINGS || join(homedir(), 'jobagent/data/settings.json');
let cache = {stamp: null, data: {}};

function load(path = SETTINGS_PATH) {
  try {
    const stamp = statSync(path).mtimeMs;
    if (cache.stamp !== stamp) cache = {stamp, data: JSON.parse(readFileSync(path, 'utf8'))};
  } catch { cache = {stamp: null, data: {}}; }
  return cache.data;
}

export function setting(key, fallback, path) {
  const value = load(path).effective?.[key];
  return value === undefined || value === null ? fallback : value;
}

// A model setting ("haiku", "sonnet", "opus") as the CLI's --model value.
export function modelSetting(key, fallback, path) {
  const name = setting(key, fallback, path);
  return load(path).models?.[name] || name;
}
