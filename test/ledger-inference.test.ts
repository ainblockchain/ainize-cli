import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ledger inference CLI uses only the native read endpoint and preserves submission paths', { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-ledger-inference-'));
  const batchId = 'ea4fd88e-0114-429b-bf34-4dbe67636749';
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    const url = new URL(request.url!, 'http://localhost');
    requests.push(url);
    assert.equal(url.pathname, '/api/ledger/inference');
    assert.ok([...url.searchParams.keys()].every(key => ['id', 'receipts', 'offset', 'limit'].includes(key)));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ enabled: true, total: 1, offset: 0, limit: 50, unbatched_receipts: 0,
      scope: 'Submitted is not included.', entries: [{ id: batchId, state: 'submitted', tx_hash: 'test-transaction',
        path: '/apps/knowledge/market/inference_batches/test/batch', batch: { model_id: 'owner/model', request_count: 1 },
        ...(url.searchParams.get('receipts') === 'true' ? { receipts: [], receipt_commitment_valid: false } : {}),
      }] }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const args = ['--import', 'tsx', 'src/bin.ts', '--home', home, '--node', `http://127.0.0.1:${(server.address() as { port: number }).port}`, 'ledger', 'inference'];
    const list = await promisify(execFile)(process.execPath, [...args, '--json'], { timeout: 15000 });
    assert.equal(JSON.parse(list.stdout).entries[0].path, '/apps/knowledge/market/inference_batches/test/batch');
    const detail = await promisify(execFile)(process.execPath, [...args, batchId, '--receipts', '--json'], { timeout: 15000 });
    assert.equal(JSON.parse(detail.stdout).entries[0].receipt_commitment_valid, false);
    assert.equal(requests[1].searchParams.get('id'), batchId);
    await assert.rejects(promisify(execFile)(process.execPath, [...args, '--receipts', '--json'], { timeout: 15000 }), /requires a batch ID/);
    assert.equal(requests.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
