/**
 * Resolve an ENS name to the knowledge it points at.
 *
 * `ainize patch vaults.defi.engram.eth` replaces three commands and a copied id:
 *
 *   ainize patch ls --node http://their-node:3402 --status LISTED -q "<topic>"
 *   ainize login && ainize use <id>
 *
 * The reason a name can do that is that it carries BOTH halves of what those commands supply by hand — which
 * node to talk to and which knowledge to ask for. `ainize.node` and `ainize.patch` are ENSIP-5 text records,
 * so a publisher sets them once and every buyer's command line collapses to the name.
 *
 * TWO RESOLUTION PATHS, and the honest status of each:
 *
 *   local     A names file — `ens.names` in the node config, or ~/.ainize/names.json, or --names <file>.
 *             Verified: it is a file this CLI reads and this repository tests. It is also what makes the
 *             command work offline, in a demo, and before any name is registered.
 *
 *   on-chain  registry.resolver(namehash) then resolver.text(namehash, key), over JSON-RPC with no new
 *             dependency. `text(bytes32,string)` is ENSIP-5 and stable; the REGISTRY address is not something
 *             this file guesses — it must be given with --registry or `ens.registry`, because ENSv2's own
 *             documentation says its contracts "are not yet final and may change prior to mainnet
 *             deployment", and a hard-coded address that silently resolves against the wrong registry is the
 *             kind of confident wrong answer this project has spent its time removing.
 *             NOT YET EXERCISED against a live ENSv2 deployment. It is written from the ENSIP-5 interface and
 *             it will say so if it fails.
 *
 * Local wins when both are available, deliberately: a name you have pinned locally is a name you have
 * checked, and a lookup that silently prefers the network can change under you between two runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { keccak } from '@ainblockchain/ain-util';

/** Where the answer came from, so a caller can say it rather than imply it. */
export type ResolveSource = 'names-file' | 'config' | 'on-chain';

export interface ResolvedName {
  name: string;
  /** The node that holds the knowledge — what `--node` would have been. */
  node: string;
  /** The knowledge id on that node — what `use <id>` would have been. */
  patch: string;
  source: ResolveSource;
  /** Where exactly, so an operator can go and edit it. */
  where: string;
}

export const NODE_KEY = 'ainize.node';
export const PATCH_KEY = 'ainize.patch';

/** A name this CLI will try to resolve rather than treat as a subcommand or an id. */
export function looksLikeEnsName(s: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) && /\.(eth|test)$/i.test(s);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * ENSIP-1 namehash. Reverse label order, each step hashing the parent node with the label hash.
 * `keccak` comes from ain-util, which this workspace already depends on — node's `sha3-256` is NOT keccak256
 * (different padding) and using it here would produce plausible, wrong nodes.
 */
export function namehash(name: string): string {
  let node = Buffer.alloc(32);
  if (name) {
    for (const label of name.toLowerCase().split('.').reverse()) {
      if (!label) continue;
      const labelHash = Buffer.from(keccak(Buffer.from(label, 'utf8')));
      node = Buffer.from(keccak(Buffer.concat([node, labelHash])));
    }
  }
  return `0x${node.toString('hex')}`;
}

const selector = (sig: string) => `0x${hex(keccak(Buffer.from(sig, 'utf8'))).slice(0, 8)}`;
const padWord = (h: string) => h.replace(/^0x/, '').padStart(64, '0');

/** ABI-encode `text(bytes32 node, string key)` — one static word, then an offset and the string tail. */
function encodeText(node: string, key: string): string {
  const keyBytes = Buffer.from(key, 'utf8');
  const len = keyBytes.length.toString(16).padStart(64, '0');
  const body = Buffer.concat([keyBytes, Buffer.alloc((32 - (keyBytes.length % 32)) % 32)]).toString('hex');
  return selector('text(bytes32,string)') + padWord(node) + (64).toString(16).padStart(64, '0') + len + body;
}

/** Decode a single ABI-encoded string return value. Returns '' for an empty or absent record. */
function decodeString(data: string): string {
  const raw = data.replace(/^0x/, '');
  if (raw.length < 128) return '';
  const len = parseInt(raw.slice(64, 128), 16);
  if (!Number.isFinite(len) || len === 0) return '';
  return Buffer.from(raw.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  const j = await r.json() as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result ?? '0x';
}

export interface ResolveOptions {
  /** JSON-RPC endpoint. `--rpc`, then ENS_RPC_URL, then `ens.rpc` in the node config. */
  rpc?: string;
  /** ENS registry address. Never defaulted — see the note at the top of this file. */
  registry?: string;
  /** Explicit names file, overriding the search order. */
  namesFile?: string;
  /** `ens` block from the node config, when there is one. */
  config?: { rpc?: string; registry?: string; names?: Record<string, { node: string; patch: string }> } | null;
  home?: string;
}

type NameEntry = { node: string; patch: string };

function readNamesFile(path: string): Record<string, NameEntry> | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, NameEntry> | { names?: Record<string, NameEntry> };
    return ('names' in j && j.names ? j.names : j) as Record<string, NameEntry>;
  } catch { return null; }
}

/** The places a names file may live, in the order they are consulted. */
export function namesFileCandidates(opts: ResolveOptions = {}): string[] {
  const out: string[] = [];
  if (opts.namesFile) out.push(opts.namesFile);
  if (opts.home) out.push(join(opts.home, 'names.json'));
  out.push(join(homedir(), '.ainize', 'names.json'));
  return out;
}

/**
 * Resolve `name` to the node and knowledge id it points at.
 *
 * Throws with BOTH paths named when neither works, because "cannot resolve" without saying what was tried is
 * the error message that sends someone to the wrong place.
 */
export async function resolveName(name: string, opts: ResolveOptions = {}): Promise<ResolvedName> {
  const tried: string[] = [];

  // 1. Local, in order: an explicit file, this home's names.json, ~/.ainize/names.json, then node config.
  for (const path of namesFileCandidates(opts)) {
    const names = readNamesFile(path);
    tried.push(path);
    const hit = names?.[name.toLowerCase()];
    if (hit?.node && hit?.patch) return { name, node: hit.node, patch: hit.patch, source: 'names-file', where: path };
  }
  const fromCfg = opts.config?.names?.[name.toLowerCase()];
  if (fromCfg?.node && fromCfg?.patch) return { name, node: fromCfg.node, patch: fromCfg.patch, source: 'config', where: 'config.json ens.names' };
  tried.push('config.json ens.names');

  // 2. On-chain. Both the RPC and the registry must be supplied; neither is guessed.
  const rpc = opts.rpc ?? process.env.ENS_RPC_URL ?? opts.config?.rpc;
  const registry = opts.registry ?? process.env.ENS_REGISTRY ?? opts.config?.registry;
  if (rpc && registry) {
    const node = namehash(name);
    const resolverWord = await ethCall(rpc, registry, selector('resolver(bytes32)') + padWord(node));
    const resolver = `0x${resolverWord.replace(/^0x/, '').slice(-40)}`;
    if (/^0x0{40}$/.test(resolver)) throw new Error(`${name} has no resolver on the registry at ${registry}`);
    const [nodeUrl, patchId] = await Promise.all([
      ethCall(rpc, resolver, encodeText(node, NODE_KEY)).then(decodeString),
      ethCall(rpc, resolver, encodeText(node, PATCH_KEY)).then(decodeString),
    ]);
    if (!nodeUrl || !patchId) {
      throw new Error(`${name} resolves, but its ${!nodeUrl ? NODE_KEY : PATCH_KEY} text record is empty — the publisher has not pointed it at a knowledge yet`);
    }
    return { name, node: nodeUrl, patch: patchId, source: 'on-chain', where: `${resolver} via ${rpc}` };
  }
  tried.push(rpc ? 'on-chain (no registry address given)' : 'on-chain (no RPC given)');

  throw new Error(
    `cannot resolve ${name}. Tried: ${tried.join(', ')}.\n` +
    `Either add it to a names file — {"${name.toLowerCase()}": {"node": "http://host:3402", "patch": "<id>"}} — ` +
    `or give both --rpc and --registry (ENSv2's contracts are not final, so the registry address is never assumed).`,
  );
}
