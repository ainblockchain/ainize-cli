/**
 * Operator-facing truthfulness: the hints name the binary that was invoked, `start -d` / `stop` / `status`
 * report what actually happened, and `config set` refuses what the node cannot boot on.
 * Pure unit tests — no node is started here (the CLI↔node integration lives in cli.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TEACH_CONFIG, defaultConfig, loadConfig, saveConfig } from '@ngram/core';
import { buildContext, requireNodeTarget, type CliError } from '../src/context.js';
import { start, stop } from '../src/commands/node.js';
import { configGet, configSet, configUnset } from '../src/commands/init.js';

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

test('`start -d` waits for the child to answer, and reports node.log when it dies (item 118)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-start-'));
  const busy = createServer(() => undefined);
  try {
    const port = await new Promise<number>((res) => busy.listen(0, '127.0.0.1', () => res((busy.address() as { port: number }).port)));
    saveConfig(defaultConfig({ home: h, name: 'busy', port, ledger: 'local' }), h);
    const ctx = buildContext({ home: h, quiet: true });
    process.env.NGRAM_START_TIMEOUT_MS = '15000';
    await assert.rejects(() => start(ctx, { detach: true }), (e: CliError) => {
      assert.match(e.message, /node exited while starting \(exit code 1\)/);
      assert.match(e.message, /EADDRINUSE/);                                  // the reason, from node.log
      assert.match(e.message, /node\.log \(last \d+ lines\)/);
      return true;
    });
    assert.equal(existsSync(join(h, 'node.pid')), false, 'no pid file for a node that never started');
  } finally {
    busy.close();
    rmSync(h, { recursive: true, force: true });
    delete process.env.NGRAM_START_TIMEOUT_MS;
  }
});

test('`stop` escalates to SIGKILL and only reports success on a confirmed exit (item 119)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-stop-'));
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  try {
    saveConfig(defaultConfig({ home: h, name: 'stubborn', port: 3999, ledger: 'local' }), h);
    writeFileSync(join(h, 'node.pid'), String(child.pid));
    process.kill(child.pid!, 'SIGSTOP');                                       // ignores SIGTERM, like the finding's node
    process.env.NGRAM_STOP_GRACE_MS = '1000';
    const t0 = Date.now();
    const r = await stop(buildContext({ home: h, quiet: true }));
    assert.equal(r.stopped, true);
    assert.equal(r.killed, true);
    assert.ok(Date.now() - t0 >= 1000, 'it waited out the grace period before SIGKILL');
    assert.throws(() => process.kill(child.pid!, 0), /ESRCH/, 'the process is really gone');
    assert.equal(existsSync(join(h, 'node.pid')), false, 'the pid file goes only after a confirmed exit');
  } finally {
    try { process.kill(child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(h, { recursive: true, force: true });
    delete process.env.NGRAM_STOP_GRACE_MS;
  }
});

test('`config set` refuses an unknown key, a wrong type and an out-of-range value (item 123)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-cset-'));
  try {
    const cfg = defaultConfig({ home: h, name: 'c', port: 3999, ledger: 'local' });
    saveConfig(cfg, h);
    const ctx = buildContext({ home: h, quiet: true });
    const refused: [string, string, RegExp][] = [
      ['port', 'notanumber', /^port must be a number — got "notanumber"$/],
      ['verifier.stak', '5', /^unknown config key 'verifier\.stak' — did you mean 'verifier\.stake'\?$/],
      ['market.defaultprice', '0.5', /did you mean 'market\.defaultPrice'\?$/],
      ['typo.that.does.not.exist', 'hello', /lists every key this node has$/],
      ['host', '999.999.999.999', /^host must be an interface to bind/],
      ['roles', 'admin', /^roles must be a comma list of 'seller', 'verifier', 'serving', 'gateway'/],
      ['verifier.quorum', '-3', /^verifier\.quorum must be at least 1/],
      ['market.royaltyShare', '47', /must be a fraction between 0 and 1/],
      ['ledger.knid', 'ain', /did you mean 'ledger\.kind'\?$/],
      ['identity.privateKey', 'dead', /^refusing to set identity\.privateKey/],
      ['market', '{}', /^market is a group of keys, not a value — set one of: market\.currency, market\.defaultPrice/],
    ];
    for (const [key, value, re] of refused) {
      await assert.rejects(() => configSet(ctx, key, value), (e: CliError) => { assert.match(e.message, re); return true; }, `${key}=${value}`);
    }
    // nothing was written by any of them
    assert.deepEqual(loadConfig(h), JSON.parse(JSON.stringify(cfg)));
    // and the value the schema does want is stored in the type the product uses: a price is a string, a port a number
    await configSet(ctx, 'market.defaultPrice', '9.99');
    await configSet(ctx, 'port', '3123');
    const after = loadConfig(h)!;
    assert.equal(after.market.defaultPrice, '9.99');
    assert.equal(after.port, 3123);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('`config get` prints one key and `config unset` restores the default (item 123)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-cunset-'));
  try {
    saveConfig(defaultConfig({ home: h, name: 'c', port: 3999, ledger: 'local' }), h);
    const ctx = buildContext({ home: h, quiet: true });
    assert.equal(configGet(ctx, 'market.defaultPrice'), '0.1');
    assert.equal(configGet(ctx, 'identity.privateKey'), '<hidden — `ainize keys show --reveal`>');   // never the key itself
    assert.throws(() => configGet(ctx, 'nosuch.key'), /unknown config key 'nosuch\.key'/);

    await configSet(ctx, 'teach.trainer.gpus', '0,1');
    assert.equal(loadConfig(h)!.teach!.trainer.gpus, '0,1');
    configUnset(ctx, 'teach.trainer.gpus');
    assert.equal(loadConfig(h)!.teach!.trainer.gpus, DEFAULT_TEACH_CONFIG.trainer.gpus);            // required → reset, not deleted
    await configSet(ctx, 'publicUrl', 'http://example.test:3999');
    configUnset(ctx, 'publicUrl');
    assert.equal('publicUrl' in (loadConfig(h) as object), false);                                   // optional → really gone
    assert.throws(() => configUnset(ctx, 'publicUrl'), /is not set in/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('a scheme-less --node is a typo, not a dead node (item 116)', () => {
  assert.throws(() => buildContext({ node: 'localhost:3402' }), (e: CliError) => {
    assert.equal(e.exitCode, 2);
    assert.equal(e.message, '--node must be a full URL — did you mean http://localhost:3402?');
    return true;
  });
  assert.throws(() => buildContext({ node: 'ftp://x/y' }), /did you mean http:\/\/x\/y\?$/);
  assert.equal(buildContext({ node: 'http://localhost:3402/' }).nodeUrl, 'http://localhost:3402');
});
