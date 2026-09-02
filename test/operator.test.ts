/**
 * Operator-facing truthfulness: the hints name the binary that was invoked, `start -d` / `stop` / `status`
 * report what actually happened, and `config set` refuses what the node cannot boot on.
 * Pure unit tests — no node is started here (the CLI↔node integration lives in cli.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TEACH_CONFIG, buildStamp, defaultConfig, loadConfig, saveConfig } from '@ngram/core';
import { buildContext, requireNodeTarget, type CliError } from '../src/context.js';
import { nodeVersion, start, stop } from '../src/commands/node.js';
import { configGet, configSet, configShow, configUnset, init, keysBackup, readKeyBackup } from '../src/commands/init.js';

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
  // a child that HANDLES SIGTERM, exactly like the node (`start` installs a cleanup handler): a handled signal stays
  // pending while the process is stopped, so SIGTERM alone can never end it — the finding's node, reproduced
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((res) => child.stdout!.once('data', () => res()));
    saveConfig(defaultConfig({ home: h, name: 'stubborn', port: 3999, ledger: 'local' }), h);
    writeFileSync(join(h, 'node.pid'), String(child.pid));
    process.kill(child.pid!, 'SIGSTOP');
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

test('status reports the build that is running, and names the config version only when it differs (item 141)', () => {
  const base = { address: '0x1', name: 'n', endpoint: 'http://x', roles: [], ledger: 'local', branches: [], blobs: [] };
  assert.equal(nodeVersion({ ...base, version: '0.1.0' }), '0.1.0');
  assert.equal(nodeVersion({ ...base, version: '0.1.0', config_version: '0.1.0' }), '0.1.0');
  assert.match(nodeVersion({ ...base, version: '0.2.0', config_version: '0.1.0' }), /^0\.2\.0 {2}\(config\.json written by 0\.1\.0\)$/);
  assert.match(nodeVersion({ ...base, version: '0.1.0', build: '2026-09-02T08:36:54.000Z' }), /^0\.1\.0 · built 2026-09-02 \d\d:36:54$/);
  // the build stamp is measured from the running code, never a string in a file
  assert.match(buildStamp()!, /^\d{4}-\d\d-\d\dT/);
});

test('`init --force` carries the identity and the operator password forward (item 120)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-force-'));
  try {
    const ctx = buildContext({ home: h, quiet: true });
    const first = await init(ctx, { name: 'critic-n1', port: 3577, ledger: 'local' });
    writeFileSync(join(h, 'config.json'), JSON.stringify({ ...loadConfig(h), operatorPasswordHash: 'HASH-KEEP-ME' }, null, 2));

    await assert.rejects(() => init(ctx, { name: 'x' }), (e: CliError) => {
      assert.match(e.message, /^config already exists at .* — change one setting with `ainize config set <key> <value>`; `--force` rewrites the file \(keeping this node's identity\)$/);
      return true;
    });

    const forced = await init(ctx, { name: 'renamed', force: true });
    assert.equal(forced.identity.address, first.identity.address, 'the identity is not re-minted');
    assert.equal(forced.identity.privateKey, first.identity.privateKey);
    assert.equal(loadConfig(h)!.operatorPasswordHash, 'HASH-KEEP-ME', 'the operator password survives');
    assert.equal(loadConfig(h)!.name, 'renamed');
    const backups = readdirSync(h).filter((f) => f.startsWith('config.json.bak-'));
    assert.equal(backups.length, 1, 'the previous config was copied aside');
    assert.equal(JSON.parse(readFileSync(join(h, backups[0]), 'utf8')).name, 'critic-n1');

    // --new-identity needs the current address typed, and means nothing without a config
    await assert.rejects(() => init(buildContext({ home: mkdtempSync(join(tmpdir(), 'ngram-empty-')), quiet: true }), { newIdentity: true }),
      /--new-identity only means something when a config already exists/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('keys backup / import round-trip, encrypted and in the clear (item 122)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-keys-'));
  try {
    const ctx = buildContext({ home: h, quiet: true });
    const cfg = await init(ctx, { name: 'k', port: 3598, ledger: 'local' });
    const enc = join(h, 'backup-enc.json');
    const plain = join(h, 'backup-plain.json');

    const b = await keysBackup(ctx, enc, { passphrase: 'hunter2' });
    assert.equal(b.privateKey, undefined, 'an encrypted backup never carries the key in the clear');
    assert.equal(b.cipher!.alg, 'aes-256-gcm');
    assert.equal(b.address, cfg.identity.address);
    assert.equal(statSync(enc).mode & 0o777, 0o600);
    assert.equal((await readKeyBackup(ctx, enc, 'hunter2')).privateKey, cfg.identity.privateKey);
    await assert.rejects(() => readKeyBackup(ctx, enc, 'wrong'), /wrong passphrase for this backup/);
    await assert.rejects(() => keysBackup(ctx, enc, { passphrase: 'x' }), /already exists — pick another name/);

    const p = await keysBackup(ctx, plain);
    assert.equal(p.privateKey, cfg.identity.privateKey);
    assert.equal((await readKeyBackup(ctx, plain)).privateKey, cfg.identity.privateKey);
    await assert.rejects(() => readKeyBackup(ctx, join(h, 'nope.json')), /no such file/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('a config whose port is not a number is named as such, and never locks the operator out of the fix (item 123)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-badport-'));
  try {
    const cfg = defaultConfig({ home: h, name: 'p', port: 3999, ledger: 'local' });
    writeFileSync(join(h, 'config.json'), JSON.stringify({ ...cfg, port: 'notanumber' }, null, 2));
    // every command — `config set port …`, the fix, included — used to die here with
    // "--node must be a full URL — did you mean http://localhost:notanumber?": a flag nobody passed
    const ctx = buildContext({ home: h, quiet: true });
    assert.equal(ctx.nodeSource, 'config');
    assert.equal(ctx.nodeUrlProblem, `port in ${join(h, 'config.json')} is "notanumber", not a port number — fix it with \`ainize config set port <1-65535>\``);
    assert.throws(() => requireNodeTarget(ctx), (e: CliError) => e.exitCode === 2 && /not a port number/.test(e.message));
    // the local commands work, and so does the fix
    assert.equal(configShow(ctx).name, 'p');
    await assert.rejects(() => start(ctx, {}), /this node's config is not usable:\n  port must be a number/);
    await configSet(ctx, 'port', '3999');
    assert.equal(buildContext({ home: h, quiet: true }).nodeUrlProblem, null);
    // a typed URL is still checked as one
    assert.throws(() => buildContext({ home: h, node: 'localhost:3999' }), /--node must be a full URL — did you mean http:\/\/localhost:3999\?$/);
    process.env.NGRAM_PORT = 'abc';
    try { assert.throws(() => buildContext({ home: h }), /NGRAM_PORT must be a port number \(1–65535\) — got "abc"$/); }
    finally { delete process.env.NGRAM_PORT; }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('`start -d` refuses an unusable config itself, before spawning anything (item 123)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'ngram-badcfg-'));
  try {
    const cfg = defaultConfig({ home: h, name: 'r', port: 3999, ledger: 'local' });
    writeFileSync(join(h, 'config.json'), JSON.stringify({ ...cfg, roles: ['admin'], verifier: { ...cfg.verifier, quorum: -3 } }, null, 2));
    const ctx = buildContext({ home: h, quiet: true });
    await assert.rejects(() => start(ctx, { detach: true }), (e: CliError) => {
      assert.match(e.message, /^this node's config is not usable:\n/);
      assert.match(e.message, /\n  roles\.0 must be a comma list of 'seller', 'verifier', 'serving', 'gateway'\n/);
      assert.match(e.message, /\n  verifier\.quorum must be at least 1\n/);
      assert.ok(e.message.endsWith(`(or \`ainize config unset <key>\` for the default) in ${join(h, 'config.json')}`), e.message);
      return true;
    });
    assert.equal(existsSync(join(h, 'node.pid')), false, 'nothing was spawned');
    assert.equal(existsSync(join(h, 'node.log')), false, 'the reason is on the terminal, not in a log the operator has to find');
  } finally { rmSync(h, { recursive: true, force: true }); }
});
