import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { huggingFaceDatasetFetch } from '../src/commands/huggingface-dataset.js';

test('AinCode dataset fetch uses its local relay without changing the source URL or revision metadata', async () => {
  const previous = process.env.AINIZE_HF_PROXY_URL;
  const target = 'https://huggingface.co/api/datasets/owner/qa/revision/main';
  const server = createServer((req, res) => {
    assert.equal(new URL(req.url!, 'http://relay').searchParams.get('url'), target);
    assert.equal(req.headers.authorization, 'Bearer own-hf-fixture');
    res.writeHead(200, { 'x-revision': 'a'.repeat(40) }); res.end('dataset-bytes');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing relay address');
  try {
    process.env.AINIZE_HF_PROXY_URL = `http://127.0.0.1:${address.port}/_practice/huggingface`;
    const response = await huggingFaceDatasetFetch(target, { headers: { authorization: 'Bearer own-hf-fixture' }, redirect: 'manual' });
    assert.equal(await response.text(), 'dataset-bytes');
    assert.equal(response.headers.get('x-revision'), 'a'.repeat(40));
    process.env.AINIZE_HF_PROXY_URL = 'https://example.com/_practice/huggingface';
    assert.throws(() => huggingFaceDatasetFetch(target), /local AinCode dataset gateway/);
  } finally {
    if (previous === undefined) delete process.env.AINIZE_HF_PROXY_URL;
    else process.env.AINIZE_HF_PROXY_URL = previous;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
