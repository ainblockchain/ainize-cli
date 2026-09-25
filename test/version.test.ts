import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('version belongs to the CLI even when invoked inside another npm project', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ainize-version-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer', version: '99.0.0' }));
    const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), '--version'], { cwd, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
