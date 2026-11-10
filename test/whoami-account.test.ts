/** `ainize whoami` for a session whose subject is an AIN account rather than an address. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContext } from '../src/context.js';
import { whoami } from '../src/commands/auth.js';

test('an account session is signed in, and says who it is', async () => {
  const home = mkdtempSync(join(tmpdir(), 'whoami-account-'));
  let me: Record<string, unknown> = {};
  const server = createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer session'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(me)); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const ctx = { ...buildContext({ home, node: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, quiet: true }), token: 'session' };
  const base = { isOwner: false, address: '0x00000000000000000000000000000000000000aa', name: 'ainize-ai', scheme: null, via_key: null };
  try {
    me = { ...base, signedIn: false, subject: null, sso: { principal: 'google:101', sub: 'acc_1', name: 'Dev', email: 'dev@example.com', orgs: ['org_1'], activeOrg: null }, site: null };
    const account = await whoami(ctx);
    assert.equal(account.signedIn, true);
    assert.equal(account.subject, 'google:101');
    assert.deepEqual(account.account, { principal: 'google:101', name: 'Dev', email: 'dev@example.com', orgs: ['org_1'] });

    me = { ...base, signedIn: false, subject: null, sso: null, site: { principal: 'google:202' } };
    const vouched = await whoami(ctx);
    assert.equal(vouched.signedIn, true);
    assert.equal(vouched.subject, 'google:202');

    me = { ...base, signedIn: true, subject: '0x00000000000000000000000000000000000000bb', scheme: 'wallet', sso: null, site: null };
    const address = await whoami(ctx);
    assert.deepEqual([address.signedIn, address.subject, address.account], [true, '0x00000000000000000000000000000000000000bb', null]);

    me = { ...base, signedIn: false, subject: null, sso: null, site: null };
    const nobody = await whoami(ctx);
    assert.deepEqual([nobody.signedIn, nobody.subject, nobody.account], [false, null, null]);
  } finally { await new Promise<void>((done) => server.close(() => done())); rmSync(home, { recursive: true, force: true }); }
});
