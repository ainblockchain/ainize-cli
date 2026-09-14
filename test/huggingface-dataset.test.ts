import '../src/quiet.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { defaultConfig, teachConfig } from '@ainize/core';
import { startNode } from '@ainize/node';
import { buildContext } from '../src/context.js';
import { datasetImportHuggingFace, mapHuggingFaceColumns, parseHuggingFaceUrl, readHuggingFaceDataset } from '../src/commands/huggingface-dataset.js';
import { datasetUpload } from '../src/commands/teach-dataset.js';

const revision = '1234567890abcdef1234567890abcdef12345678';
const repository = 'owner/questions';
const hubUrl = `https://huggingface.co/datasets/${repository}`;
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'x-revision': revision, ...headers } });

function fixture(totalRows = 205) {
  const calls: { url: URL; options: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    assert.equal(options?.method ?? 'GET', 'GET');
    if (url.pathname.startsWith('/api/datasets/')) return json({ id: repository, sha: revision, cardData: { license: 'fixture-license' } });
    if (url.pathname === '/splits') return json({ splits: [{ dataset: repository, config: 'default', split: 'train' }], pending: [], failed: [] });
    if (url.pathname === '/rows') {
      const offset = Number(url.searchParams.get('offset'));
      const length = Math.min(Number(url.searchParams.get('length')), Math.max(0, totalRows - offset));
      return json({ partial: false, num_rows_total: totalRows, rows: Array.from({ length }, (_, index) => ({ row_idx: offset + index, row: { prompt: `Question ${offset + index}?`, answer: `${offset + index}`, note: '1937-07-10' }, truncated_cells: [] })) });
    }
    if (url.pathname.includes('/resolve/')) return new Response('{"prompt":"대표자?","answer":"조원국","alt_prompt":"대표자 이름?","note":"DART"}\n');
    throw new Error(`unexpected endpoint ${url.pathname}`);
  };
  return { calls, fetcher };
}

test('repository, viewer and raw file URLs parse; non-HF URLs and embedded credentials are refused', () => {
  assert.deepEqual(parseHuggingFaceUrl(hubUrl), { repository });
  assert.deepEqual(parseHuggingFaceUrl(`${hubUrl}/viewer/default/train`), { repository, config: 'default', split: 'train' });
  assert.deepEqual(parseHuggingFaceUrl(`${hubUrl}/resolve/main/data/train.jsonl`), { repository, revision: 'main', file: 'data/train.jsonl' });
  for (const url of ['http://huggingface.co/datasets/owner/questions', 'https://localhost/datasets/owner/questions', 'https://huggingface.co.evil.invalid/datasets/owner/questions', 'https://secret@huggingface.co/datasets/owner/questions', `${hubUrl}?token=secret`, 'https://huggingface.co/owner/model']) assert.throws(() => parseHuggingFaceUrl(url));
});

test('repository URL paginates the complete split and preserves strings without publishing anything', async () => {
  const data = fixture();
  const result = await readHuggingFaceDataset(hubUrl, {}, data.fetcher);
  assert.equal(result.source.importedRows, 205);
  assert.equal(result.source.sampled, false);
  assert.equal(result.source.revision, revision);
  assert.equal(result.source.sha256, createHash('sha256').update(result.bytes).digest('hex'));
  const rows = result.bytes.toString().trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 205);
  assert.equal(rows[204].answer, '204');
  assert.equal(rows[0].note, '1937-07-10');
  assert.deepEqual(data.calls.filter(call => call.url.pathname === '/rows').map(call => call.url.searchParams.get('offset')), ['0', '100', '200']);
});

test('an explicit row selection reports offset, total and sampling instead of claiming the whole dataset', async () => {
  const data = fixture();
  const result = await readHuggingFaceDataset(hubUrl, { limit: 8, offset: 100 }, data.fetcher);
  assert.equal(result.source.offset, 100);
  assert.equal(result.source.importedRows, 8);
  assert.equal(result.source.totalRows, 205);
  assert.equal(result.source.sampled, true);
});

test('JSON columns map before upload, preserve numeric zero and reject missing or nested answers', () => {
  const columns = JSON.stringify({ prompt: 'review', answer: 'star' });
  const mapped = mapHuggingFaceColumns(Buffer.from('{"review":"great","star":0}\n'), 'jsonl', columns);
  assert.deepEqual(JSON.parse(mapped.toString()), { prompt: 'great', answer: '0' });
  assert.throws(() => mapHuggingFaceColumns(Buffer.from('{"review":"great"}\n'), 'jsonl', columns), /missing column/);
  assert.throws(() => mapHuggingFaceColumns(Buffer.from('{"review":"great","star":[1]}\n'), 'jsonl', columns), /scalar/);
});

test('large datasets require an explicit limit and never silently truncate', async () => {
  await assert.rejects(readHuggingFaceDataset(hubUrl, {}, fixture(10001).fetcher), /explicit --limit/);
  for (const options of [{ limit: 0 }, { limit: 10001 }, { offset: -1 }, { limit: 1.5 }]) await assert.rejects(readHuggingFaceDataset(hubUrl, options, fixture().fetcher), /integer|limit/);
});

test('revision changes, gaps, truncation and partial viewer data fail closed', async () => {
  for (const defect of ['revision', 'gap', 'truncated', 'partial', 'total']) {
    const data = fixture();
    const fetcher: typeof fetch = async (input, options) => {
      const response = await data.fetcher(input, options);
      const url = new URL(String(input));
      if (url.pathname !== '/rows' || url.searchParams.get('offset') === '0') return response;
      const body = await response.json();
      if (defect === 'gap') body.rows[0].row_idx++;
      if (defect === 'truncated') body.rows[0].truncated_cells = ['answer'];
      if (defect === 'partial') body.partial = true;
      if (defect === 'total') body.num_rows_total++;
      return json(body, defect === 'revision' ? { 'x-revision': '0'.repeat(40) } : {});
    };
    await assert.rejects(readHuggingFaceDataset(hubUrl, {}, fetcher), /revision|row|incomplete/);
  }
});

test('multiple configs require selection; an unready viewer points to file import', async () => {
  for (const splits of [[], [{ config: 'first', split: 'train' }, { config: 'second', split: 'train' }]]) {
    const data = fixture();
    const fetcher: typeof fetch = async (input, options) => new URL(String(input)).pathname === '/splits' ? json({ splits }) : data.fetcher(input, options);
    await assert.rejects(readHuggingFaceDataset(hubUrl, {}, fetcher), /choose --config/);
  }
});

test('file imports resolve an immutable revision and retain exact bytes without a viewer', async () => {
  const data = fixture();
  const result = await readHuggingFaceDataset(`${hubUrl}/resolve/main/data/qa.jsonl`, {}, data.fetcher);
  assert.equal(result.source.file, 'data/qa.jsonl');
  assert.equal(result.source.format, 'jsonl');
  assert.equal(data.calls.length, 2);
  assert.equal(data.calls[1].url.pathname, `/datasets/${repository}/resolve/${revision}/data/qa.jsonl`);
  assert.equal(JSON.parse(result.bytes.toString()).answer, '조원국');
  await assert.rejects(readHuggingFaceDataset(hubUrl, { file: '../private.jsonl' }, fixture().fetcher), /file path/);
  await assert.rejects(readHuggingFaceDataset(hubUrl, { file: 'train.jsonl', limit: 8 }, fixture().fetcher), /cannot be combined/);
});

test('HF authentication stays on approved API origins and is never recorded in provenance', async context => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-hf-token-'));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const tokenFile = join(home, 'token');
  writeFileSync(tokenFile, 'fixture-token-not-a-real-credential', { mode: 0o600 });
  const data = fixture();
  const headers: { host: string; auth: string | null }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    headers.push({ host: url.hostname, auth: new Headers(options?.headers).get('authorization') });
    if (url.pathname.includes('/resolve/')) return new Response(null, { status: 302, headers: { location: 'https://cdn-lfs.hf.co/data.jsonl' } });
    if (url.hostname === 'cdn-lfs.hf.co') return new Response('{"prompt":"Q","answer":"A"}\n');
    return data.fetcher(input, options);
  };
  const result = await readHuggingFaceDataset(hubUrl, { file: 'data.jsonl', hfTokenFile: tokenFile }, fetcher);
  assert.ok(headers.filter(header => header.host === 'huggingface.co').every(header => header.auth === 'Bearer fixture-token-not-a-real-credential'));
  assert.equal(headers.find(header => header.host === 'cdn-lfs.hf.co')?.auth, null);
  assert.ok(!JSON.stringify(result.source).includes('fixture-token'));
  chmodSync(tokenFile, 0o644);
  await assert.rejects(readHuggingFaceDataset(hubUrl, { hfTokenFile: tokenFile }, data.fetcher), /private file/);
});

test('redirects to unrelated hosts and oversized responses are rejected', async () => {
  const data = fixture();
  for (const response of [new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }), new Response('small body', { headers: { 'content-length': String(33 * 1024 * 1024) } })]) {
    const fetcher: typeof fetch = async (input, options) => new URL(String(input)).pathname.includes('/resolve/') ? response : data.fetcher(input, options);
    await assert.rejects(readHuggingFaceDataset(hubUrl, { file: 'data.jsonl' }, fetcher), /unsupported host|32 MiB/);
  }
});

test('HF import binds real dataset uploads and queued jobs without public listing, retaining receipts on training refusal', async context => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-hf-node-'));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const config = defaultConfig({ home, name: 'hf-import-test', port, ledger: 'local', roles: ['serving'] });
  config.host = '127.0.0.1';
  config.runtime = { api: 'http://127.0.0.1:1' };
  config.teach = { ...teachConfig(config), enabled: true, backend: 'stub', stubOffline: true };
  const node = await startNode(config, { home, quiet: true, serveWeb: false });
  context.after(async () => { await node.stop(); rmSync(home, { recursive: true, force: true }); });
  const client = buildContext({ home, node: `http://127.0.0.1:${port}`, json: true, quiet: true });
  const data = fixture();
  const realFetch = globalThis.fetch;
  let rejectTraining = false;
  let trainingRequests = 0;
  const mockedFetch = mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (String(input).endsWith('/api/teach/jobs') && options?.method === 'POST') trainingRequests++;
    if (rejectTraining && String(input).endsWith('/api/teach/jobs') && options?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ error: 'fixture training refusal' }), { status: 503, headers: { 'content-type': 'application/json' } }));
    }
    return String(input).startsWith('https://') ? data.fetcher(input, options) : realFetch(input, options);
  });
  const chunks: string[] = [];
  const nodeConsole = mock.method(console, 'log', () => undefined);
  const originalWrite = process.stdout.write;
  const stdout = mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk !== 'string') return Reflect.apply(originalWrite, process.stdout, [chunk, ...args]);
    chunks.push(chunk);
    return true;
  });
  try {
    const imported = await datasetImportHuggingFace(client, hubUrl, { file: 'data.jsonl' });
    assert.equal(imported.created, true);
    assert.equal(imported.dataset.rows, 1);
    assert.equal(imported.job, undefined);
    assert.equal(JSON.parse(chunks.join('')).dataset_id, imported.dataset.id);
    assert.equal(statSync(imported.provenance).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(imported.provenance, 'utf8')).revision, revision);
    const receipt = JSON.parse(readFileSync(imported.import_receipt, 'utf8'));
    assert.equal(statSync(imported.import_receipt).mode & 0o777, 0o600);
    assert.equal(receipt.dataset_id, imported.dataset.id);
    assert.equal(receipt.dataset_sha256, imported.dataset.sha256);
    assert.equal(receipt.source_file_sha256, createHash('sha256').update(readFileSync(imported.provenance)).digest('hex'));
    assert.equal(receipt.job, null);
    chunks.length = 0;
    const duplicate = await datasetImportHuggingFace(client, hubUrl, { file: 'data.jsonl' });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.dataset.id, imported.dataset.id);
    assert.equal((await node.market.catalog()).length, 0);
    const mapped = await datasetImportHuggingFace(client, hubUrl, { limit: 2, columns: '{"prompt":"prompt","answer":"note"}' });
    assert.equal(mapped.dataset.rows, 2);
    assert.notEqual(mapped.source.inputSha256, mapped.source.sha256);
    const mappedReceipt = JSON.parse(readFileSync(mapped.import_receipt, 'utf8'));
    assert.equal(mappedReceipt.input_sha256, mapped.source.inputSha256);
    assert.equal(mappedReceipt.upload_sha256, mapped.source.sha256);
    assert.equal(mappedReceipt.dataset_sha256, mapped.dataset.sha256);
    const trained = await datasetImportHuggingFace(client, hubUrl, { file: 'data.jsonl', train: true });
    assert.ok(trained.training_receipt);
    const acceptedReceipt = JSON.parse(readFileSync(trained.import_receipt, 'utf8'));
    const trainingReceipt = JSON.parse(readFileSync(trained.training_receipt!, 'utf8'));
    assert.equal(acceptedReceipt.job, null);
    assert.equal(trainingReceipt.job.id, trained.job!.job.id);
    assert.equal(trainingReceipt.job.dataset_sha256, acceptedReceipt.dataset_sha256);
    const foldersBefore = new Set(readdirSync(join(client.home, 'hf-imports')));
    rejectTraining = true;
    await assert.rejects(datasetImportHuggingFace(client, hubUrl, { file: 'data.jsonl', train: true }));
    const failedFolder = readdirSync(join(client.home, 'hf-imports')).find(folder => !foldersBefore.has(folder))!;
    assert.ok(failedFolder);
    const failedPath = join(client.home, 'hf-imports', failedFolder);
    assert.equal(JSON.parse(readFileSync(join(failedPath, 'import-receipt.json'), 'utf8')).dataset_id, imported.dataset.id);
    assert.equal(existsSync(join(failedPath, 'training-receipt.json')), false);
    const requestsBefore = trainingRequests;
    await assert.rejects(datasetUpload(client, imported.file, { train: true, onUploaded: () => { throw new Error('fixture persistence failure'); } }), /fixture persistence failure/);
    assert.equal(trainingRequests, requestsBefore);
  } finally { stdout.mock.restore(); nodeConsole.mock.restore(); mockedFetch.mock.restore(); }
});
