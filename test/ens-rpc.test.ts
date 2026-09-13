import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeAbiParameters, decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, toHex, type Hex } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { normalize, packetToBytes } from 'viem/ens';
import { looksLikeEnsName, namehash, NODE_KEY, PATCH_KEY, resolveName } from '../src/ens.js';

const universalAbi = parseAbi([
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes result, address resolver)',
  'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)',
]);
const resolverAbi = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function resolver(bytes32 node) view returns (address)',
]);
const registry = '0x1111111111111111111111111111111111111111';
const resolver = '0x2222222222222222222222222222222222222222';
const fixtureName = 'café.eth';
const fixtureRecords: Record<string, string> = { [NODE_KEY]: 'https://seller.example', [PATCH_KEY]: 'test-patch-id' };

async function rpcFixture(context: TestContext, options: {
  chainId?: number; legacy?: boolean; offchain?: boolean; empty?: string; fail?: boolean; malformed?: boolean; noResolver?: boolean;
} = {}) {
  const calls: { to: string; data: Hex }[] = [];
  let gatewayCalls = 0;
  let callbackCalls = 0;
  const failures: unknown[] = [];
  let endpoint = '';
  const chain = options.chainId === 1 ? mainnet : sepolia;
  const encodeRecord = (key: string) => encodeFunctionResult({
    abi: resolverAbi, functionName: 'text', result: options.empty === key ? '' : fixtureRecords[key],
  });
  const encodeResolution = (key: string) => encodeFunctionResult({
    abi: universalAbi, functionName: 'resolveWithGateways', result: [encodeRecord(key), resolver],
  });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/gateway') {
        gatewayCalls++;
        assert.equal(body.sender.toLowerCase(), chain.contracts.ensUniversalResolver.address);
        response.end(JSON.stringify({ data: '0x1234' }));
        return;
      }
      if (body.method === 'eth_chainId') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: toHex(options.chainId ?? sepolia.id) }));
        return;
      }
      assert.equal(body.method, 'eth_call');
      const call = body.params[0] as { to: string; data: Hex };
      calls.push(call);
      if (options.fail) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'secret-from-provider' } }));
        return;
      }
      let result: Hex;
      if (options.legacy) {
        const decoded = decodeFunctionData({ abi: resolverAbi, data: call.data });
        assert.equal(decoded.args[0], namehash(fixtureName));
        if (decoded.functionName === 'resolver') {
          assert.equal(call.to, registry);
          result = encodeFunctionResult({ abi: resolverAbi, functionName: 'resolver', result: options.noResolver ? `0x${'0'.repeat(40)}` : resolver });
        } else {
          assert.equal(call.to, resolver);
          result = encodeRecord(decoded.args[1]);
        }
      } else {
        assert.equal(call.to.toLowerCase(), chain.contracts.ensUniversalResolver.address);
        if (call.data.startsWith('0x12345678')) {
          callbackCalls++;
          const [gatewayData, extraData] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], `0x${call.data.slice(10)}`);
          assert.equal(gatewayData, '0x1234');
          const record = decodeFunctionData({ abi: resolverAbi, data: extraData });
          assert.equal(record.functionName, 'text');
          result = encodeResolution(record.args[1]!);
        } else {
          const decoded = decodeFunctionData({ abi: universalAbi, data: call.data });
          assert.equal(decoded.functionName, 'resolveWithGateways');
          assert.equal(decoded.args[0], toHex(packetToBytes(normalize(fixtureName))));
          const record = decodeFunctionData({ abi: resolverAbi, data: decoded.args[1] });
          assert.equal(record.functionName, 'text');
          assert.equal(record.args[0], namehash(fixtureName));
          assert.ok([NODE_KEY, PATCH_KEY].includes(record.args[1]!));
          if (options.offchain) {
            response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: {
              code: 3, message: 'execution reverted', data: encodeErrorResult({
                abi: universalAbi, errorName: 'OffchainLookup',
                args: [chain.contracts.ensUniversalResolver.address, [`${endpoint}/gateway`], '0xabcd', '0x12345678', decoded.args[1]],
              }),
            } }));
            return;
          }
          result = encodeResolution(record.args[1]!);
        }
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: options.malformed ? '0x12' : result }));
    } catch (error) {
      failures.push(error);
      response.statusCode = 500;
      response.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  context.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(failures, []);
  });
  return { endpoint, calls, counts: () => ({ gatewayCalls, callbackCalls }) };
}

test('Universal Resolver reads both text records with normalized DNS wire name on Sepolia', async context => {
  const rpc = await rpcFixture(context);
  const result = await resolveName('CAFE\u0301.ETH', { rpc: rpc.endpoint });
  assert.equal(result.node, fixtureRecords[NODE_KEY]);
  assert.equal(result.patch, fixtureRecords[PATCH_KEY]);
  assert.equal(result.source, 'on-chain');
  assert.match(result.where, /Universal Resolver .*sepolia \(11155111\)/);
  assert.equal(rpc.calls.length, 2);
});

test('viem follows OffchainLookup to a gateway and validates through the onchain callback', async context => {
  const rpc = await rpcFixture(context, { offchain: true });
  const result = await resolveName(fixtureName, { rpc: rpc.endpoint });
  assert.equal(result.patch, fixtureRecords[PATCH_KEY]);
  assert.deepEqual(rpc.counts(), { gatewayCalls: 2, callbackCalls: 2 });
});

test('explicit legacy registry mode still discovers the resolver and reads text directly', async context => {
  const rpc = await rpcFixture(context, { legacy: true });
  const result = await resolveName(fixtureName, { rpc: rpc.endpoint, registry });
  assert.equal(result.patch, fixtureRecords[PATCH_KEY]);
  assert.match(result.where, /legacy ENSv1 registry/);
  assert.equal(rpc.calls.length, 3);
});

for (const key of [NODE_KEY, PATCH_KEY]) {
  test(`missing ${key} fails instead of returning a partial answer`, async context => {
    const rpc = await rpcFixture(context, { empty: key });
    await assert.rejects(resolveName(fixtureName, { rpc: rpc.endpoint }), new RegExp(`empty or missing ${key}`));
  });
}

for (const options of [{ fail: true }, { malformed: true }, { legacy: true, noResolver: true }]) {
  test(`RPC failure is actionable and excludes provider secrets: ${JSON.stringify(options)}`, async context => {
    const rpc = await rpcFixture(context, options);
    await assert.rejects(resolveName(fixtureName, { rpc: `${rpc.endpoint}/private-token`, registry: options.legacy ? registry : undefined }), (error: Error) => {
      assert.match(error.message, /lookup failed/);
      assert.doesNotMatch(error.message, /private-token|secret-from-provider/);
      return true;
    });
  });
}

test('chain mismatch fails before any resolution calls', async context => {
  const rpc = await rpcFixture(context, { chainId: 1 });
  await assert.rejects(resolveName(fixtureName, { rpc: rpc.endpoint }), /chain mismatch.*11155111.*received 1/);
  assert.equal(rpc.calls.length, 0);
});

test('config can select mainnet and explicit options override it', async context => {
  const rpc = await rpcFixture(context, { chainId: 1 });
  const result = await resolveName(fixtureName, { config: { rpc: rpc.endpoint, chain: 'mainnet' } });
  assert.match(result.where, /mainnet \(1\)/);
  await assert.rejects(resolveName(fixtureName, { rpc: rpc.endpoint, chain: 'sepolia', config: { chain: 'mainnet' } }), /chain mismatch/);
});

test('local names retain priority and never access RPC', async context => {
  const directory = mkdtempSync(join(process.cwd(), '.ens-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const namesFile = join(directory, 'names.json');
  writeFileSync(namesFile, JSON.stringify({ [fixtureName]: { node: fixtureRecords[NODE_KEY], patch: fixtureRecords[PATCH_KEY] } }));
  const result = await resolveName(fixtureName, { namesFile, rpc: 'http://127.0.0.1:1', registry: 'invalid' });
  assert.equal(result.source, 'names-file');
});

test('DNS and Unicode names are accepted, malformed names and URLs are rejected', () => {
  for (const name of ['ensfairy.xyz', 'café.eth', '🦄.eth']) assert.equal(looksLikeEnsName(name), true);
  for (const name of ['a..eth', '.eth', 'https://example.eth', 'id-no-dot', 'a/b.eth']) assert.equal(looksLikeEnsName(name), false);
  assert.throws(() => namehash('a..eth'));
});

test('CLI forwards --ens-chain and --rpc and resolve-only stops after resolution', async context => {
  const rpc = await rpcFixture(context, { chainId: 1 });
  const directory = mkdtempSync(join(process.cwd(), '.ens-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.ENS_RPC_URL;
  delete env.ENS_REGISTRY;
  delete env.ENS_CHAIN;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', 'tsx', 'src/bin.ts', 'patch', fixtureName, '--ens-chain', 'mainnet', '--rpc', rpc.endpoint,
    '--resolve-only', '--json', '--home', directory,
  ], { env });
  const output = JSON.parse(stdout);
  assert.equal(output.resolved.patch, fixtureRecords[PATCH_KEY]);
  assert.match(output.resolved.where, /mainnet/);
  assert.equal(rpc.calls.length, 2);
});
