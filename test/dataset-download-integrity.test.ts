import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const digest = (body: string) => createHash('sha256').update(body).digest('hex');

test('dataset downloads fail before writing unverified bytes and CLI returns nonzero', { timeout: 120000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-download-integrity-'));
  const body = '{"prompt":"Fixture question","answer":"Fixture answer"}\n';
  const canonicalHash = digest(body);
  let responseBody = body;
  let datasetHash: unknown = canonicalHash;
  let headerHash: string | undefined;
  const id = '12345678-1234-4234-8234-123456789012';
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    if (path === '/api/auth/me') response.end(JSON.stringify({ address: `0x${'1'.repeat(40)}` }));
    else if (path === `/api/teach/datasets/${id}`) response.end(JSON.stringify({ dataset: { id, sha256: datasetHash } }));
    else if (path.endsWith('/rows')) response.end(JSON.stringify({ items: [], total: 1 }));
    else if (path.endsWith('/download')) {
      if (headerHash !== undefined) response.setHeader('x-content-sha256', headerHash);
      response.end(responseBody);
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const invoke = (output: string, format = 'jsonl') => promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'src/bin.ts', 'teach', 'dataset', 'get', id, '--out', output,
      '--format', format, '--node', `http://127.0.0.1:${port}`, '--home', home, '--json'],
    { timeout: 20000 });
  try {
    const fresh = join(home, 'fresh.jsonl');
    const existing = join(home, 'existing.jsonl');
    writeFileSync(existing, 'original evidence');
    responseBody = 'changed bytes';
    for (const output of [fresh, existing]) {
      await assert.rejects(invoke(output), (error: unknown) => {
        const failure = error as { code: number; stderr: string; stdout: string };
        assert.notEqual(failure.code, 0);
        assert.match(failure.stderr, /fingerprint missing or mismatched/);
        assert.ok(!failure.stdout.includes('"saved"'));
        return true;
      });
    }
    assert.equal(existsSync(fresh), false);
    assert.equal(readFileSync(existing, 'utf8'), 'original evidence');
    responseBody = body;
    for (const invalid of [null, 'invalid']) {
      datasetHash = invalid;
      await assert.rejects(invoke(fresh), /fingerprint missing or mismatched/);
      assert.equal(existsSync(fresh), false);
    }
    datasetHash = canonicalHash.toUpperCase();
    const valid = JSON.parse((await invoke(fresh)).stdout);
    assert.equal(valid.saved.verified, true);
    assert.equal(valid.saved.sha256, canonicalHash);
    assert.equal(readFileSync(fresh, 'utf8'), body);
    assert.equal(statSync(fresh).mode & 0o777, 0o600);
    const csv = join(home, 'questions.csv');
    responseBody = 'prompt,answer\nFixture question,Fixture answer\n';
    for (const invalid of [undefined, canonicalHash]) {
      headerHash = invalid;
      await assert.rejects(invoke(csv, 'csv'), /fingerprint missing or mismatched/);
      assert.equal(existsSync(csv), false);
    }
    headerHash = digest(responseBody);
    const exported = JSON.parse((await invoke(csv, 'csv')).stdout);
    assert.equal(exported.saved.sha256, headerHash);
    assert.equal(exported.saved.verified, true);
    assert.notEqual(exported.saved.sha256, canonicalHash);
    assert.equal(readFileSync(csv, 'utf8'), responseBody);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
