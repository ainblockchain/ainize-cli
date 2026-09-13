/**
 * `ainize login` from a machine that is not the node's — the whole round trip.
 *
 * A command line cannot open a wallet prompt, and it must not hold the person's wallet key: copying a key that
 * owns real money onto every laptop that runs a command is the thing wallets exist to stop. So the CLI keeps a
 * key of its own, and asks a person to vouch for it: it prints a URL, they approve it in a browser with one
 * wallet signature, and from then on this machine signs in with its own key alone.
 *
 * The browser half is driven here by calling the same HTTP routes the page calls, with a signature made the way
 * MetaMask makes one. What that leaves real is everything that matters: the CLI's key, the node's verification,
 * the binding, and the session that comes back belonging to the PERSON rather than to the laptop.
 *
 *   node --test --import tsx test/device-login.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as secp from '@noble/secp256k1';
import { createIdentity, defaultConfig, hashEip191, saveConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '@ainize/node';
import { buildContext, readState } from '../src/context.js';
import { bindings, login, logout, whoami } from '../src/commands/auth.js';
import { cliKeyPath, readCliKey } from '../src/cli-key.js';

secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  Uint8Array.from(createHmac('sha256', k).update(Buffer.concat(m.map((x) => Buffer.from(x)))).digest());
/** What MetaMask returns for personal_sign: one keccak over the EIP-191 prefix, a bare 65-byte r‖s‖v. */
const personalSign = (message: string, priv: string): string => {
  const sig = secp.sign(hashEip191(message), priv.replace(/^0x/, ''));
  return `0x${Buffer.concat([Buffer.from(sig.toCompactRawBytes()), Buffer.from([27 + sig.recovery])]).toString('hex')}`;
};

const tmp = mkdtempSync(join(tmpdir(), 'ainize-device-'));
const nodeHome = join(tmp, 'node');
const HUMAN = createIdentity();   // the address in someone's MetaMask
let node: RunningNode;
let url = '';

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});
const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(`${url}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
/** The browser: connect a wallet, sign the readable challenge, hold a session. */
const browserSignIn = async (id = HUMAN) => {
  const ch = (await call('POST', '/api/auth/challenge', { scheme: 'eip191' })).body as { nonce: string; message: string };
  return (await call('POST', '/api/auth/wallet', { address: id.address, nonce: ch.nonce, signature: personalSign(ch.message, id.privateKey) })).body.token as string;
};
/** The page at /authorize: read what is being asked, sign those exact bytes, approve. */
const approveInBrowser = async (code: string, token: string, id = HUMAN) => {
  const shown = (await call('GET', `/api/auth/device/${encodeURIComponent(code)}`)).body as { message: string; delegate: string; label: string };
  const r = await call('POST', `/api/auth/device/${encodeURIComponent(code)}/approve`, { signature: personalSign(shown.message, id.privateKey) }, token);
  return { shown, status: r.status, body: r.body };
};
/** Watch for the code the CLI asks for, so the "browser" can approve while `login` is still waiting. */
const codeFor = async (delegate: string, timeoutMs = 8000): Promise<string> => {
  const t0 = Date.now();
  for (;;) {
    const row = node.store.db.prepare('SELECT code FROM device_grants WHERE delegate = ? AND approved_at IS NULL ORDER BY created_at DESC LIMIT 1')
      .get(delegate.toLowerCase()) as { code: string } | undefined;
    if (row) return row.code;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no device request for ${delegate}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

before(async () => {
  const port = await freePort();
  const cfg: NodeConfig = defaultConfig({ home: nodeHome, name: 'cli-device-node', port, ledger: 'local', roles: ['seller'] });
  cfg.host = '127.0.0.1';
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };
  cfg.operatorAddresses = [HUMAN.address];
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  saveConfig(cfg, nodeHome);
  node = await startNode(cfg, { home: nodeHome, quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${port}`;
});
after(async () => { await node?.stop(); rmSync(tmp, { recursive: true, force: true }); });

/** A laptop: its own AINIZE_HOME, no node config in it, pointed at the node over the network. */
const laptop = () => {
  const home = mkdtempSync(join(tmp, 'laptop-'));
  return { home, ctx: buildContext({ home, node: url, quiet: true }) };
};

test('the CLI prints a link, a person approves it, and the session is theirs', async () => {
  const { home, ctx } = laptop();
  const browser = await browserSignIn();

  // Both halves run at once, which is what actually happens: the CLI is waiting while the person clicks.
  const signingIn = login(ctx, {});
  const key = await (async () => { await codeFor((await waitForKey(home)).address); return readCliKey(home)!; })();
  const approved = await approveInBrowser(await codeFor(key.address), browser);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const r = await signingIn;
  // The session belongs to the PERSON. That is the entire point: the laptop's key is a means, not an identity.
  assert.equal(r.address.toLowerCase(), HUMAN.address.toLowerCase());
  assert.equal(readState(home).token, r.token);

  const who = await whoami({ ...ctx, token: r.token });
  assert.equal(who.subject, HUMAN.address.toLowerCase());
  assert.equal(who.via_key, key.address.toLowerCase(), 'and it records which machine stood in for them');
  assert.equal(who.isOwner, true, 'HUMAN is in operatorAddresses, so the laptop inherits that');

  // What the person was asked to approve named the key and what the machine calls itself — in the signed bytes,
  // not only on the page, so nothing could have been varied around a reassuring prompt.
  assert.ok(approved.shown.message.includes(key.address));
  assert.equal(approved.shown.delegate, key.address.toLowerCase());
});

test('the next time, there is no browser at all', async () => {
  // The whole reason the binding is written down rather than re-signed: `ainize login` is something you do once.
  const { home, ctx } = laptop();
  const browser = await browserSignIn();
  const first = login(ctx, {});
  const key = await waitForKey(home);
  await approveInBrowser(await codeFor(key.address), browser);
  await first;

  // Nobody is watching a browser now. If this needed one it would sit here until the timeout and fail.
  const again = await login({ ...ctx, token: null }, { timeoutMs: 1 });
  assert.equal(again.address.toLowerCase(), HUMAN.address.toLowerCase());
  assert.equal((await whoami({ ...ctx, token: again.token })).via_key, key.address.toLowerCase());
});

test("the key stays on the machine: only its address is ever sent", async () => {
  const { home, ctx } = laptop();
  const browser = await browserSignIn();
  const started = login(ctx, {});
  const key = await waitForKey(home);
  await approveInBrowser(await codeFor(key.address), browser);
  await started;

  // 0600, like an ssh key, because that is exactly what it is worth: whoever reads it can act as its owner until
  // the binding is revoked.
  assert.equal(statSync(cliKeyPath(home)).mode & 0o777, 0o600);
  // Nothing the node stores is the key itself — not the grant, not the binding, not the session.
  const stored = JSON.stringify([
    node.store.db.prepare('SELECT * FROM device_grants').all(),
    node.store.db.prepare('SELECT * FROM bindings').all(),
    node.store.db.prepare('SELECT * FROM sessions').all(),
  ]);
  assert.ok(!stored.includes(key.privateKey), 'the private key must never reach the node');
  assert.ok(stored.includes(key.address.toLowerCase()), 'its address, and nothing more');
});

test('a person can end a machine from the CLI, and it is out immediately', async () => {
  const { home, ctx } = laptop();
  const browser = await browserSignIn();
  const started = login(ctx, {});
  const key = await waitForKey(home);
  await approveInBrowser(await codeFor(key.address), browser);
  const session = await started;

  const listed = await bindings({ ...ctx, token: session.token });
  assert.ok(listed.bindings.some((b) => b.delegate === key.address.toLowerCase()));
  assert.equal(listed.via, key.address.toLowerCase(), 'and it says which one is reading this');

  // Ended from the browser's session, which is the case that matters: a laptop you no longer have cannot end
  // itself. The session it was holding has to go with it — a 30-day token would outlive the revocation.
  await bindings({ ...ctx, token: browser }, { end: key.address });
  assert.equal(node.store.getSession(session.token), null);
  const after = await whoami({ ...ctx, token: session.token });
  assert.equal(after.signedIn, false);
});

test('`logout --forget` leaves nothing behind, and says what that costs', async () => {
  const { home, ctx } = laptop();
  const browser = await browserSignIn();
  const started = login(ctx, {});
  const key = await waitForKey(home);
  await approveInBrowser(await codeFor(key.address), browser);
  const session = await started;

  await logout({ ...ctx, token: session.token }, { forget: true });
  assert.equal(readCliKey(home), null, 'the key is gone from the machine');
  assert.equal(readState(home).token, undefined);
  // The binding is NOT gone: the node still lists a key that no longer exists, which is why the message says to
  // end it. Quietly revoking it here would need a session this command has just thrown away.
  const still = await bindings({ ...ctx, token: browser });
  assert.ok(still.bindings.some((b) => b.delegate === key.address.toLowerCase()), 'and the node still knows about it');
});

/** The CLI writes its key before it asks for anything, so this is how the "browser" learns which key to approve. */
async function waitForKey(home: string, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const k = readCliKey(home);
    if (k) return k;
    if (Date.now() - t0 > timeoutMs) throw new Error('the CLI never wrote a key');
    await new Promise((r) => setTimeout(r, 25));
  }
}
