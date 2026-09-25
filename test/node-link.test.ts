import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, saveConfig, createIdentity, verifyAuth } from '@ainize/core';
import { buildContext, readState, writeState } from '../src/context.js';
import { login } from '../src/commands/auth.js';
import { nodeHeartbeat, readNodeLink } from '../src/node-link.js';

test('default login links each node identity and preserves the local CLI session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ainize-cli-link-'));
  const owner = createIdentity().address;
  let active: ReturnType<typeof defaultConfig>;
  const proofs = new Map<string, string>();
  const grants: { address: string; token: string }[] = [];
  let beats = 0, revoked = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const answer = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/api/auth/challenge') return answer({ nonce: 'nonce', message: 'prove this node key' });
    if (req.url === '/api/auth/wallet') {
      assert.ok(verifyAuth('ain', 'prove this node key', body.signature, body.address));
      const token = 'proof-' + body.address; proofs.set(token, body.address); return answer({ token });
    }
    if (req.url === '/api/auth/logout') return answer({ ok: true });
    if (req.url === '/api/auth/device') {
      assert.equal(body.kind, 'node'); assert.equal(proofs.get(String(req.headers.authorization).replace('Bearer ', '')), body.delegate);
      grants.push({ address: body.delegate, token: 'status-' + body.delegate });
      return answer({ code: String(grants.length - 1), poll_secret: 'poll', interval_ms: 1, expires_at: Date.now() + 10000 });
    }
    if (req.url?.endsWith('/claim')) {
      const g = grants[Number(req.url.split('/')[4])]; assert.equal(body.poll_secret, 'poll');
      return answer({ status: 'approved', node_link_token: g.token, owner, expires: Date.now() + 100000 });
    }
    if (req.url === '/api/info') return answer({ node: { address: active.identity.address, name: active.name, roles: active.roles, version: 'test' } });
    if (req.url === '/api/my/nodes/heartbeat') {
      assert.equal(body.address, active.identity.address); beats++; return answer({ ok: !revoked }, revoked ? 401 : 200);
    }
    return answer({}, 404);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    for (const name of ['node-a', 'node-b']) {
      const home = join(root, name); active = defaultConfig({ home, name, port, ledger: 'local' }); saveConfig(active, home);
      writeState(home, { token: 'local-session', nodeUrl: `http://localhost:${port}` });
      const ctx = buildContext({ home, node: `http://127.0.0.1:${port}`, quiet: true });
      const result = await login(ctx, { open: false });
      assert.equal(result.address, owner); assert.equal(result.token, '');
      assert.equal(readNodeLink(home)?.address, active.identity.address);
      assert.equal(statSync(join(home, 'node-link.json')).mode & 0o777, 0o600);
      assert.equal(readState(home).token, 'local-session');
      assert.equal(readState(home).nodeUrl, `http://localhost:${port}`);
      assert.equal(await nodeHeartbeat(home, active), true);
    }
    assert.equal(grants.length, 2); assert.notEqual(grants[0].address, grants[1].address); assert.equal(beats, 4);
    revoked = true; assert.equal(await nodeHeartbeat(join(root, 'node-b'), active!), false);
  } finally { await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});
