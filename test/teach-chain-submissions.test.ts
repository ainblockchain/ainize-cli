import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTeachStatus, type TeachStatusResult } from '../src/commands/teach.js';

test('owner status renders the original training submission separately from the ready transaction', () => {
  const result: TeachStatusResult = { kind: 'job', node: 'http://localhost:3400', owner: true, job: { id: 'job', status: 'READY',
    chain_submissions: [
      { status: 'TRAINING', submittedAt: 1000, acknowledgedAt: 1010, path: '/apps/knowledge/market/lessons/node/job', txHash: 'training-tx', outcome: 'submitted' },
      { status: 'READY', submittedAt: 2000, acknowledgedAt: 2010, path: '/apps/knowledge/market/lessons/node/job', txHash: 'ready-tx', outcome: 'submitted' },
    ] } };
  const text = renderTeachStatus(result);
  for (const expected of ['training-tx', 'ready-tx', 'TRAINING', '1000', 'not inclusion confirmations']) assert.ok(text.includes(expected), expected);
  assert.ok(!renderTeachStatus({ ...result, owner: false }).includes('training-tx'));
});

test('older node responses do not invent chain submission metadata', () => {
  assert.ok(!renderTeachStatus({ kind: 'job', node: 'http://localhost:3400', owner: true, job: { id: 'job', status: 'QUEUED' } }).includes('blockchain submissions'));
});
