import { test } from 'node:test';
import assert from 'node:assert/strict';
import { huggingFaceImportReceipt } from '../src/commands/huggingface-import-receipt.js';
import type { HuggingFaceSource } from '../src/commands/huggingface-dataset.js';
import type { DatasetUploadResult } from '../src/commands/teach-dataset.js';

const source = { repository: 'owner/dataset', revision: 'a'.repeat(40), inputSha256: '1'.repeat(64), sha256: '2'.repeat(64), bytes: 100 } as HuggingFaceSource;
const accepted = { node: 'http://localhost:3402', bytes: 100, sha256: source.sha256, created: true,
  dataset: { id: '00000000-0000-4000-8000-000000000001', sha256: '3'.repeat(64), revision: 1, rows: 1 } } as DatasetUploadResult;

test('import receipts distinguish upstream, mapped upload and node canonical hashes', () => {
  const receipt = huggingFaceImportReceipt(source, JSON.stringify(source), accepted);
  assert.equal(receipt.input_sha256, source.inputSha256);
  assert.equal(receipt.upload_sha256, source.sha256);
  assert.equal(receipt.dataset_sha256, accepted.dataset.sha256);
  assert.equal(receipt.job, null);
  assert.equal(receipt.node_url, accepted.node);
  assert.equal('owner_address' in receipt, false);
});

test('changed uploads, invalid revisions, credential URLs and different training snapshots are refused', () => {
  for (const change of [
    { sha256: '4'.repeat(64) }, { bytes: 99 }, { node: 'https://token@node.example' },
    { job: { job: { id: '00000000-0000-4000-8000-000000000002', status: 'TRAINING', dataset: { id: accepted.dataset.id, sha256: '5'.repeat(64) } } } },
  ]) assert.throws(() => huggingFaceImportReceipt(source, '{}', { ...accepted, ...change } as DatasetUploadResult));
  assert.throws(() => huggingFaceImportReceipt({ ...source, revision: 'main' }, '{}', accepted));
});
