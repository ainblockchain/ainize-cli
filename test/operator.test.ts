/**
 * Operator-facing truthfulness: the hints name the binary that was invoked, `start -d` / `stop` / `status`
 * report what actually happened, and `config set` refuses what the node cannot boot on.
 * Pure unit tests — no node is started here (the CLI↔node integration lives in cli.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

test('no user-facing hint hardcodes `ngram` — every one interpolates PROG (item 110)', () => {
  const offenders: string[] = [];
  for (const f of sources(SRC)) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;                     // doc comments name the historical command deliberately
      if (/(['"`])[^'"`]*\bngram [a-z]/.test(line)) offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `hints must use \`\${PROG} …\`, not the literal \`ngram …\`:\n${offenders.join('\n')}`);
});
