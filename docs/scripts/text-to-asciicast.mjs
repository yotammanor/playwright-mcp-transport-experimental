#!/usr/bin/env node
/**
 * Convert plain terminal output into an asciinema v2 cast for `agg` GIF rendering.
 * Usage: node docs/scripts/text-to-asciicast.mjs <input.txt> <output.cast> [--cols N]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath, ...rest] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('usage: text-to-asciicast.mjs <input.txt> <output.cast> [--cols N]');
  process.exit(1);
}

const colsArg = rest.indexOf('--cols');
const cols = colsArg >= 0 ? Number(rest[colsArg + 1] ?? 100) : 100;
const raw = readFileSync(inputPath, 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n');

const header = {
  version: 2,
  width: cols,
  height: Math.min(36, Math.max(18, lines.length + 2)),
  timestamp: Math.floor(Date.now() / 1000),
  env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
  title: 'playwright-mcp-transport-experimental',
};

const events = [];
let t = 0;
events.push([t, 'o', '$ ']);
for (const line of lines) {
  t += line.length > 80 ? 0.04 : 0.06;
  events.push([t, 'o', `${line}\r\n`]);
}
t += 0.4;
events.push([t, 'o', '']);

const body = `${JSON.stringify(header)}\n${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
writeFileSync(outputPath, body);
console.log(`wrote ${outputPath} (${lines.length} lines, ${t.toFixed(1)}s)`);
