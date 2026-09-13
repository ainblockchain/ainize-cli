import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createPublicClient, http, isAddress, parseAbi, zeroAddress } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { namehash as ensNamehash, normalize } from 'viem/ens';

export type ResolveSource = 'names-file' | 'config' | 'on-chain';

export interface ResolvedName {
  name: string;
  node: string;
  patch: string;
  source: ResolveSource;
  where: string;
}

export const NODE_KEY = 'ainize.node';
export const PATCH_KEY = 'ainize.patch';

export function looksLikeEnsName(name: string): boolean {
  if (!name.includes('.') || /[\s/:\\]/u.test(name)) return false;
  try { normalize(name); return true; } catch { return false; }
}

export function namehash(name: string): string {
  return ensNamehash(name ? normalize(name) : '');
}

export interface ResolveOptions {
  rpc?: string;
  registry?: string;
  chain?: string;
  namesFile?: string;
  config?: { rpc?: string; registry?: string; chain?: string; names?: Record<string, { node: string; patch: string }> } | null;
  home?: string;
}

type NameEntry = { node: string; patch: string };

const registryAbi = parseAbi(['function resolver(bytes32 node) view returns (address)']);
const textAbi = parseAbi(['function text(bytes32 node, string key) view returns (string)']);

function readNamesFile(path: string): Record<string, NameEntry> | null {
  if (!existsSync(path)) return null;
  try {
    const entries = JSON.parse(readFileSync(path, 'utf8')) as Record<string, NameEntry> | { names?: Record<string, NameEntry> };
    return ('names' in entries && entries.names ? entries.names : entries) as Record<string, NameEntry>;
  } catch { return null; }
}

export function namesFileCandidates(opts: ResolveOptions = {}): string[] {
  const out: string[] = [];
  if (opts.namesFile) out.push(opts.namesFile);
  if (opts.home) out.push(join(opts.home, 'names.json'));
  out.push(join(homedir(), '.ainize', 'names.json'));
  return out;
}

export async function resolveName(name: string, opts: ResolveOptions = {}): Promise<ResolvedName> {
  const normalizedName = normalize(name);
  const tried: string[] = [];
  for (const path of namesFileCandidates(opts)) {
    const names = readNamesFile(path);
    tried.push(path);
    const hit = names?.[normalizedName];
    if (hit?.node && hit?.patch) return { name, node: hit.node, patch: hit.patch, source: 'names-file', where: path };
  }
  const fromCfg = opts.config?.names?.[normalizedName];
  if (fromCfg?.node && fromCfg?.patch) return { name, node: fromCfg.node, patch: fromCfg.patch, source: 'config', where: 'config.json ens.names' };
  tried.push('config.json ens.names');

  const rpc = opts.rpc ?? process.env.ENS_RPC_URL ?? opts.config?.rpc;
  const registry = opts.registry ?? process.env.ENS_REGISTRY ?? opts.config?.registry;
  if (!rpc) {
    tried.push('on-chain (no RPC given)');
    throw new Error(
      `cannot resolve ${name}. Tried: ${tried.join(', ')}.\n` +
      'Add it to a names file or give --rpc (or ENS_RPC_URL) for Universal Resolver resolution on Sepolia. ' +
      'Use --ens-chain mainnet for mainnet; --registry selects legacy ENSv1 registry mode.',
    );
  }

  const chainName = opts.chain ?? process.env.ENS_CHAIN ?? opts.config?.chain ?? 'sepolia';
  if (chainName !== 'sepolia' && chainName !== 'mainnet') {
    throw new Error(`Unsupported ENS chain: ${chainName}. Use sepolia or mainnet.`);
  }
  if (registry !== undefined && !isAddress(registry)) throw new Error('Invalid legacy ENS registry address.');
  const chain = chainName === 'mainnet' ? mainnet : sepolia;
  const client = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000, retryCount: 0 }) });
  const mode = registry ? 'legacy ENSv1 registry' : 'Universal Resolver';
  let actualChain: number;
  try { actualChain = await client.getChainId(); } catch {
    throw new Error(`ENS ${mode} RPC chain check failed on ${chainName}; check the endpoint and connection.`);
  }
  if (actualChain !== chain.id) {
    throw new Error(`ENS RPC chain mismatch: expected ${chainName} (${chain.id}), received ${actualChain}. Check --ens-chain and --rpc.`);
  }

  let records: (string | null)[];
  let where: string;
  try {
    if (registry && isAddress(registry)) {
      const node = ensNamehash(normalizedName);
      const resolver = await client.readContract({ address: registry, abi: registryAbi, functionName: 'resolver', args: [node] });
      if (resolver === zeroAddress) throw new Error('No resolver');
      records = await Promise.all([NODE_KEY, PATCH_KEY].map(key =>
        client.readContract({ address: resolver, abi: textAbi, functionName: 'text', args: [node, key] })));
      where = `legacy ENSv1 registry ${registry}, resolver ${resolver} on ${chainName} (${chain.id})`;
    } else {
      records = await Promise.all([NODE_KEY, PATCH_KEY].map(key =>
        client.getEnsText({ name: normalizedName, key })));
      where = `Universal Resolver ${chain.contracts.ensUniversalResolver.address} on ${chainName} (${chain.id})`;
    }
  } catch {
    throw new Error(`ENS ${mode} lookup failed for ${normalizedName} on ${chainName}; check the name, resolver, RPC and CCIP-Read gateway availability.`);
  }
  const [nodeUrl, patchId] = records;
  if (!nodeUrl || !patchId) {
    throw new Error(`${name} has an empty or missing ${!nodeUrl ? NODE_KEY : PATCH_KEY} text record on ${chainName}; the publisher must set both records.`);
  }
  return { name, node: nodeUrl, patch: patchId, source: 'on-chain', where };
}
