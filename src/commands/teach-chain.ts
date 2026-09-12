import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, readFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

export interface PipelineChain {
  name: string;
  provider: string;
  reader: string;
  pathPrefix: string;
  parent?: { provider: string; reader: string; shardPath: string };
}

export interface PipelineChainConfig {
  chainId: number;
  gasPrice: number;
  signerFile: string;
  signerIndex: number;
  signerAccount?: 'owner' | 'others';
  chains: PipelineChain[];
}

export function savePipelineJson(filename: string, value: unknown): void {
  const temporary = filename + '.tmp';
  const descriptor = openSync(temporary, 'w', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, filename);
}

export function validatePipelineChainConfig(value: PipelineChainConfig): PipelineChainConfig {
  assert.ok(Number.isInteger(value.chainId) && value.chainId >= 0, 'valid chainId required');
  assert.ok(Number.isFinite(value.gasPrice) && value.gasPrice >= 0, 'nonnegative gasPrice required');
  assert.ok(typeof value.signerFile === 'string' && value.signerFile, 'signerFile required');
  assert.ok(Number.isInteger(value.signerIndex) && value.signerIndex >= 0, 'signerIndex required');
  assert.ok(value.signerAccount === undefined || ['owner', 'others'].includes(value.signerAccount), 'invalid signerAccount');
  assert.ok(Array.isArray(value.chains) && value.chains.length >= 1 && value.chains.length <= 70, '1–70 chain routes required');
  assert.equal(new Set(value.chains.map(chain => chain.name)).size, value.chains.length, 'unique chain names required');
  for (const chain of value.chains) {
    assert.match(chain.name, /^[A-Za-z0-9_-]+$/);
    for (const target of [chain.provider, chain.reader, ...(chain.parent ? [chain.parent.provider, chain.parent.reader] : [])]) {
      const url = new URL(target);
      assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'chain HTTP origin required');
    }
    assert.notEqual(new URL(chain.provider).origin, new URL(chain.reader).origin, 'independent reader endpoint required');
    assert.match(chain.pathPrefix, /^\/apps\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);
    if (chain.parent) {
      assert.match(chain.parent.shardPath, /^\/apps\/[A-Za-z0-9_-]+$/);
      assert.equal(new Set([chain.provider, chain.reader, chain.parent.provider, chain.parent.reader].map(target => new URL(target).origin)).size, 4, 'parent and child endpoints must be distinct');
    }
  }
  return value;
}

export function assertPipelineReceipt(transaction: { is_finalized?: boolean; state?: string; exec_result?: { code?: number }; number?: number }): number {
  assert.equal(transaction.is_finalized, true, 'transaction not finalized');
  assert.notEqual(transaction.state, 'REVERTED', 'transaction reverted');
  assert.equal(transaction.exec_result?.code, 0, 'final transaction execution failed');
  assert.ok(Number.isSafeInteger(transaction.number) && transaction.number! >= 0, 'final block number unavailable');
  return transaction.number!;
}

export class PipelineRecorder {
  readonly config: PipelineChainConfig;
  private readonly clients: any[];
  private readonly readers: any[];
  private readonly parents: any[][];
  private readonly Ain: any;
  private readonly directory: string;

  constructor(configFile: string, output: string) {
    this.config = validatePipelineChainConfig(JSON.parse(readFileSync(configFile, 'utf8')) as PipelineChainConfig);
    const signer = JSON.parse(readFileSync(resolve(this.config.signerFile), 'utf8')) as { owner?: { private_key: string }; others: { private_key: string }[] };
    const privateKey = this.config.signerAccount === 'owner' ? signer.owner?.private_key : signer.others?.[this.config.signerIndex]?.private_key;
    assert.match(privateKey ?? '', /^[a-fA-F0-9]{64}$/, 'signer account unavailable');
    this.Ain = (createRequire(import.meta.url)('@ainblockchain/ain-js') as { default: any }).default;
    this.clients = this.config.chains.map(chain => {
      const client = new this.Ain(chain.provider, null, this.config.chainId);
      client.wallet.addAndSetDefaultAccount(privateKey);
      return client;
    });
    this.readers = this.config.chains.map(chain => new this.Ain(chain.reader, null, this.config.chainId));
    this.parents = this.config.chains.map(chain => chain.parent ? [chain.parent.provider, chain.parent.reader].map(endpoint => new this.Ain(endpoint, null, this.config.chainId)) : []);
    this.directory = join(output, 'chain');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  async preflight(): Promise<unknown[]> {
    return Promise.all(this.config.chains.map(async chain => {
      const snapshots = await Promise.all([chain.provider, chain.reader, ...(chain.parent ? [chain.parent.provider, chain.parent.reader] : [])].map(async endpoint => {
        const response = await fetch(`${endpoint}/node_status`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
        assert.equal(response.status, 200);
        const body = await response.json() as { code: number; result: { state: string; health: boolean; address: string } };
        assert.equal(body.code, 0);
        assert.equal(body.result.state, 'SERVING');
        assert.equal(body.result.health, true, `unhealthy chain endpoint ${endpoint}`);
        return { endpoint, address: body.result.address, health: body.result.health };
      }));
      assert.notEqual(snapshots[0].address, snapshots[1].address, 'reader must be a distinct validator');
      assert.equal(new Set(snapshots.map(node => node.address)).size, snapshots.length, 'parent and child validators must be distinct');
      return { name: chain.name, nodes: snapshots };
    }));
  }

  async record(index: number, runId: string, jobId: string, sequence: number, value: unknown): Promise<{ chain: string; path: string; txHash: string; block: number; valueSha256: string; parentProof?: { path: string; stateProofHash: string; endpoints: string[] } }> {
    assert.match(runId, /^[A-Za-z0-9_-]{1,40}$/);
    assert.match(jobId, /^[a-f0-9-]{36}$/i);
    assert.ok(Number.isInteger(sequence) && sequence >= 0);
    const route = index % this.config.chains.length;
    const chain = this.config.chains[route];
    const client = this.clients[route];
    const reader = this.readers[route];
    const reference = `${chain.pathPrefix}/${runId}/jobs/${jobId}/states/${sequence}`;
    const prefix = join(this.directory, `${jobId}-${sequence}`);
    const operation = { type: 'SET_VALUE', ref: reference, value };
    let intent: { body: unknown; signature: string; hash: string };
    if (existsSync(prefix + '-intent.json')) {
      intent = JSON.parse(readFileSync(prefix + '-intent.json', 'utf8'));
      assert.deepEqual((intent.body as { operation: unknown }).operation, operation, 'uncertain transaction intent cannot change');
    } else {
      assert.equal(await reader.db.ref(reference).getValue(undefined, { is_final: true }), null, 'chain path is already occupied');
      const body = { operation, nonce: -1, timestamp: Date.now(), gas_price: this.config.gasPrice };
      const signature = client.wallet.signTransaction(body) as string;
      intent = { body, signature, hash: `0x${this.Ain.utils.hashTransaction(body).toString('hex')}` };
      assert.ok(signature.startsWith(intent.hash));
      savePipelineJson(prefix + '-intent.json', intent);
      try { savePipelineJson(prefix + '-response.json', await client.sendSignedTransaction(signature, body)); }
      catch (error) { savePipelineJson(prefix + '-response.json', { transportError: (error as Error).message }); }
    }
    const deadline = Date.now() + 180_000;
    let lastError = 'not finalized';
    while (Date.now() < deadline) {
      let transaction;
      try { transaction = await client.getTransactionByHash(intent.hash); }
      catch (error) { lastError = (error as Error).message; }
      if (transaction?.is_finalized) {
        savePipelineJson(prefix + '-receipt.json', transaction);
        const blockNumber = assertPipelineReceipt(transaction);
        try {
          const remoteValue = await reader.db.ref(reference).getValue(undefined, { is_final: true });
          assert.deepEqual(remoteValue, value, 'independent final state differs');
          const response = await fetch(`${chain.reader}/get_block_by_number?number=${blockNumber}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
          assert.equal(response.status, 200);
          const blockResponse = await response.json() as { code: number; result: { number: number; hash: string; state_proof_hash: string; transactions: (string | { hash: string })[] } };
          assert.equal(blockResponse.code, 0);
          assert.equal(blockResponse.result.number, blockNumber);
          assert.ok(blockResponse.result.transactions.some(item => (typeof item === 'string' ? item : item.hash) === intent.hash), 'transaction absent from independent block');
          let parentProof;
          if (chain.parent) {
            const proofPath = `${chain.parent.shardPath}/.shard/proof_hash_map/${blockNumber}/proof_hash`;
            const proofs = await Promise.all(this.parents[route].map(parent => parent.db.ref(proofPath).getValue(undefined, { is_final: true })));
            assert.match(blockResponse.result.state_proof_hash, /^0x[a-f0-9]{64}$/);
            assert.ok(proofs.every(proof => proof === blockResponse.result.state_proof_hash), 'parent final proofs do not match the child block');
            parentProof = { path: proofPath, stateProofHash: blockResponse.result.state_proof_hash, endpoints: [chain.parent.provider, chain.parent.reader] };
          }
          const result = { chain: chain.name, path: reference, txHash: intent.hash, block: blockNumber, valueSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), ...(parentProof ? { parentProof } : {}) };
          savePipelineJson(prefix + '-verified.json', { ...result, independentBlockHash: blockResponse.result.hash, value: remoteValue });
          return result;
        } catch (error) { lastError = (error as Error).message; }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error(`chain observation expired for ${reference}: ${lastError}; keep the saved transaction hash`);
  }
}
