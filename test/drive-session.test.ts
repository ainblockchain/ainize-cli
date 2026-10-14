import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '@ainize/core';
import type { CliContext } from '../src/context.js';
import { driveLogin, driveAction } from '../src/commands/drive.js';

test('Drive login reuses AinCode and refuses failed actions without starting another pairing flow', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-drive-session-'));
  const requests: string[] = [];
  let failed = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ backend: 'aincode', configured: true, running: true, files: [] })); return; }
    assert.equal(req.headers.authorization, 'Bearer fixture');
    let body = ''; req.on('data', b => body += b); req.on('end', () => {
      assert.equal(JSON.parse(body).action, 'up');
      res.end(JSON.stringify(failed ? { ok: false, message: 'repository mismatch' } : { ok: true, message: 'Existing Drive connected' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
    const ctx: CliContext = { home, cfg: defaultConfig({ home, name: 'drive test', port: 3799, roles: ['seller'], ledger: 'local', peers: [] }), nodeUrl: `http://127.0.0.1:${addr.port}`, nodeSource: 'flag', nodeUrlProblem: null, token: 'fixture', json: true, quiet: true };
    assert.equal(await driveLogin(ctx), 0);
    assert.deepEqual(requests, ['GET /api/drive', 'POST /api/drive']);
    assert.equal(existsSync(join(ctx.cfg!.dataDir, 'drive')), false);
    failed = true;
    await assert.rejects(driveAction(ctx, 'up'), /repository mismatch/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});
