/**
 * Operator-facing truthfulness: the hints name the binary that was invoked, `start -d` / `stop` / `status`
 * report what actually happened, and `config set` refuses what the node cannot boot on.
 * Pure unit tests — no node is started here (the CLI↔node integration lives in cli.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, saveConfig } from '@ngram/core';
import { buildContext, requireNodeTarget, type CliError } from '../src/context.js';

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

test('buildContext records where the node URL came from, and unconfigured homes have no target (item 101)', () => {
  const empty = join(tmpdir(), `ngram-nohome-${process.pid}-${Date.now()}`);
  const bare = buildContext({ home: empty });
  assert.equal(bare.cfg, null);
  assert.equal(bare.nodeUrl, 'http://localhost:3402');
  assert.equal(bare.nodeSource, 'default');
  assert.throws(() => requireNodeTarget(bare), (e: CliError) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, new RegExp(`^no node configured in ${empty} — run \`ainize init\``));
    assert.match(e.message, /pass --node <url> to talk to an existing node$/);
    return true;
  });
  // an explicit --node is a target the user aimed
  const flagged = buildContext({ home: empty, node: 'http://localhost:9999' });
  assert.equal(flagged.nodeSource, 'flag');
  assert.doesNotThrow(() => requireNodeTarget(flagged));
});

test('a home with a config is its own target: nodeSource "config", no refusal (item 101)', () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-cfg-'));
  try {
    saveConfig(defaultConfig({ home: h, name: 'n', port: 3999, ledger: 'local' }), h);
    const ctx = buildContext({ home: h });
    assert.equal(ctx.nodeSource, 'config');
    assert.equal(ctx.nodeUrl, 'http://localhost:3999');
    assert.doesNotThrow(() => requireNodeTarget(ctx));
  } finally { rmSync(h, { recursive: true, force: true }); }
});
