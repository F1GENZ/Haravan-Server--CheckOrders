'use strict';

// Reads KEY=value lines on stdin and writes them into ./.env, replacing existing
// entries and appending missing ones. Values are restricted to characters that a
// double-quoted dotenv value carries verbatim, so nothing is expanded or cut.
const fs = require('fs');

const ENV_PATH = '.env';
const KEY = /^[A-Z][A-Z0-9_]*$/;
const SAFE_VALUE = /^[A-Za-z0-9:_./@%?=&+-]+$/;

const updates = new Map();
for (const line of fs.readFileSync(0, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const at = line.indexOf('=');
  const key = at > 0 ? line.slice(0, at) : '';
  const value = at > 0 ? line.slice(at + 1) : '';
  if (!KEY.test(key) || !SAFE_VALUE.test(value)) {
    console.error(`Refusing input for ${KEY.test(key) ? key : 'an invalid key'}`);
    process.exit(1);
  }
  updates.set(key, value);
}
if (updates.size === 0) {
  console.error('No KEY=value lines on stdin');
  process.exit(1);
}

const lines = fs.existsSync(ENV_PATH)
  ? fs.readFileSync(ENV_PATH, 'utf8').replace(/(\r?\n)+$/, '').split(/\r?\n/)
  : [];
const written = new Set();
const output = lines.map((line) => {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
  if (!match || !updates.has(match[1])) return line;
  written.add(match[1]);
  return `${match[1]}="${updates.get(match[1])}"`;
});
for (const [key, value] of updates) {
  if (!written.has(key)) output.push(`${key}="${value}"`);
}

const tmp = `${ENV_PATH}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${output.join('\n').replace(/\n+$/, '')}\n`, {
  mode: 0o600,
});
fs.renameSync(tmp, ENV_PATH);
console.log(`Updated ${[...updates.keys()].join(', ')}`);
