import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertPipelineReceipt, validatePipelineChainConfig } from '../src/commands/teach-chain.js';
import { parallelMap, validateParallelManifest } from '../src/commands/teach-parallel.js';

test('70 parallel submitters reach a barrier without serializing the workload', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let running = 0;
  let peak = 0;
  const seen = new Set<number>();
  const timer = setTimeout(() => release(), 1000);
  try {
    await parallelMap(Array.from({ length: 70 }, (_, index) => index), 70, async index => {
      running++;
      peak = Math.max(peak, running);
      seen.add(index);
      if (running === 70) release();
      await barrier;
      running--;
    });
    assert.equal(peak, 70);
    assert.equal(seen.size, 70);
  } finally { clearTimeout(timer); }
});

test('duplicate dataset bindings and missing fingerprints cannot inflate a pipeline count', () => {
  const dataset = { datasetId: randomUUID(), sha256: 'a'.repeat(64), rows: 8 };
  assert.deepEqual(validateParallelManifest([dataset]), [dataset]);
  assert.throws(() => validateParallelManifest([dataset, dataset]), /unique/);
  assert.throws(() => validateParallelManifest([{ ...dataset, sha256: '' }]));
  assert.throws(() => validateParallelManifest([{ ...dataset, rows: 0 }]));
});

test('chain routes need distinct reader endpoints and paths within an app', () => {
  const config = { chainId: 0, gasPrice: 0, signerFile: '/private/accounts.json', signerIndex: 0,
    chains: [{ name: 'chain', provider: 'http://127.0.0.1:18082', reader: 'http://127.0.0.1:18086', pathPrefix: '/apps/teach/pipelines' }] };
  assert.equal(validatePipelineChainConfig(config), config);
  assert.throws(() => validatePipelineChainConfig({ ...config, chains: [{ ...config.chains[0], reader: config.chains[0].provider }] }), /independent/);
  assert.throws(() => validatePipelineChainConfig({ ...config, chains: [{ ...config.chains[0], pathPrefix: '/manage_app/teach' }] }));
});

test('RPC acceptance and finalized revert never count as an on-chain training record', () => {
  assert.throws(() => assertPipelineReceipt({ is_finalized: false, exec_result: { code: 0 }, number: 1 }), /not finalized/);
  assert.throws(() => assertPipelineReceipt({ is_finalized: true, state: 'REVERTED', exec_result: { code: 0 }, number: 1 }), /reverted/);
  assert.throws(() => assertPipelineReceipt({ is_finalized: true, exec_result: { code: 12103 }, number: 1 }), /execution failed/);
  assert.equal(assertPipelineReceipt({ is_finalized: true, state: 'FINALIZED', exec_result: { code: 0 }, number: 123 }), 123);
});
