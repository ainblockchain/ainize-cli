import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { huggingFaceModelId } from '../src/commands/chat.js';

test('model URL parsing rejects datasets, Spaces, credentials and ambiguous revisions', () => {
  assert.equal(huggingFaceModelId('https://huggingface.co/owner/model/'), 'owner/model');
  for (const url of ['http://huggingface.co/owner/model', 'https://huggingface.co/datasets/model', 'https://huggingface.co/spaces/model',
    'https://example.com/owner/model', 'https://secret@huggingface.co/owner/model', 'https://huggingface.co/owner/model/tree/main',
    'https://huggingface.co/owner/model?revision=main', 'https://huggingface.co/owner/model#revision']) {
    assert.throws(() => huggingFaceModelId(url));
  }
});

test('CLI model URL routes to base chat with an exact model constraint and refuses mismatched answers', { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-model-chat-'));
  let model = 'owner/model';
  let received: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/api/chat');
    let bytes = '';
    for await (const part of request) bytes += part;
    received = JSON.parse(bytes);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ mode: 'base', model, base: { model, content: 'Model answer', latency_ms: 1 }, patched: null, patch_ids: [] }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const args = ['--import', 'tsx', 'src/bin.ts', '--home', home, '--node', `http://127.0.0.1:${port}`, 'chat', 'https://huggingface.co/owner/model', 'Question', '--json'];
    const result = await promisify(execFile)(process.execPath, args, { timeout: 15000 });
    assert.equal(JSON.parse(result.stdout).base.content, 'Model answer');
    assert.equal(received?.model, 'owner/model');
    assert.equal(received?.mode, 'base');
    assert.deepEqual(received?.patch_ids, []);
    model = 'different/model';
    await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 15000 }), error => String(error).includes('different model'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
