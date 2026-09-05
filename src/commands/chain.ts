/**
 * `ainize chain up|down|status|fund|setup` — local AIN blockchain (docker) for the `ain` ledger mode.
 *
 * The local chain is the 1-node genesis network shipped with ainblockchain/ain-blockchain; the genesis
 * validator key below is public test material from that repository (blockchain-configs/base/genesis_accounts.json).
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { AinLedger, applyEnv } from '@ngram/core';
import { NodeClient } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, kv, ok, warn } from '../output.js';
import { requireConfig } from './init.js';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);

export const CHAIN_CONTAINER = 'ngram-ain';
export const CHAIN_IMAGE = 'ainblockchain/ain-blockchain:latest';
export const CHAIN_PORT = 8081;
export const GENESIS = { address: '0x00ADEc28B6a845a085e03591bE7550dd68673C1C', privateKey: 'b22c95ffc4a5c096f7d7d0487ba963ce6ac945bdc91c79b64ce209de289bec96' };

export const CHAIN_ENV: Record<string, string> = {
  BLOCKCHAIN_CONFIGS_DIR: 'blockchain-configs/1-node', ACCOUNT_INJECTION_OPTION: 'private_key', PRIVATE_KEY: GENESIS.privateKey,
  PORT: String(CHAIN_PORT), P2P_PORT: '5001', EVENT_HANDLER_PORT: '5101', STAKE: '10000000', HOSTING_ENV: 'local', SYNC_MODE: 'full',
  ENABLE_GAS_FEE_WORKAROUND: 'true', ENABLE_TX_SIG_VERIF_WORKAROUND: 'true', ENABLE_EXPRESS_RATE_LIMIT: 'false', ENABLE_REST_FUNCTION_CALL: 'true',
  ENABLE_STATUS_REPORT_TO_TRACKER: 'false', CONSOLE_LOG: 'false', TX_POOL_SIZE_LIMIT_PER_ACCOUNT: '1000', ENABLE_EVENT_HANDLER: 'true',
};

async function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  try { const { stdout } = await execFileP('docker', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }); return stdout.trim(); }
  catch (e) { const err = e as Error & { stderr?: string; code?: string }; if (err.code === 'ENOENT') throw new CliError('docker is not installed or not on PATH'); throw new CliError(`docker ${args[0]} failed: ${(err.stderr || err.message).trim()}`); }
}

export interface ChainHealth { reachable: boolean; health?: boolean; state?: string; address?: string; blockNumber?: number; provider: string; }

export async function chainHealth(provider = `http://localhost:${CHAIN_PORT}`): Promise<ChainHealth> {
  try {
    const r = await fetch(`${provider}/node_status`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { reachable: false, provider };
    const j = (await r.json()) as { result?: { health?: boolean; state?: string; address?: string } };
    let blockNumber: number | undefined;
    try {
      const Ain = (require('@ainblockchain/ain-js') as { default: any }).default;
      const ain = new Ain(provider, null, 0);
      blockNumber = Number(await ain.getLastBlockNumber());
    } catch { blockNumber = undefined; }
    return { reachable: true, health: j.result?.health, state: j.result?.state, address: j.result?.address, blockNumber, provider };
  } catch { return { reachable: false, provider }; }
}

async function containerState(name: string): Promise<'running' | 'stopped' | 'missing'> {
  const out = await docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}|{{.State}}']);
  const line = out.split('\n').find((l) => l.startsWith(`${name}|`));
  if (!line) return 'missing';
  return line.endsWith('|running') ? 'running' : 'stopped';
}

export async function chainUp(ctx: CliContext, a: { wait?: number } = {}): Promise<ChainHealth> {
  const pre = await chainHealth();
  if (pre.reachable && pre.state === 'SERVING') {
    ok(ctx, `a local AIN chain is already SERVING on :${CHAIN_PORT} (validator ${pre.address}, block ${pre.blockNumber ?? '?'}) — nothing to do`);
    return pre;
  }
  const state = await containerState(CHAIN_CONTAINER);
  if (state === 'running') warn(ctx, `${CHAIN_CONTAINER} is running but not serving yet — waiting`);
  else if (state === 'stopped') { await docker(['start', CHAIN_CONTAINER]); ok(ctx, `started existing container ${CHAIN_CONTAINER}`); }
  else {
    const args = ['run', '-d', '--name', CHAIN_CONTAINER, '--network', 'host'];
    for (const [k, v] of Object.entries(CHAIN_ENV)) args.push('-e', `${k}=${v}`);
    args.push(CHAIN_IMAGE);
    const id = await docker(args, 10 * 60_000);
    ok(ctx, `container ${CHAIN_CONTAINER} created (${id.slice(0, 12)}) — booting the 1-node chain`);
  }
  const deadline = Date.now() + (a.wait ?? 90) * 1000;
  let h = await chainHealth();
  while (!(h.reachable && h.state === 'SERVING') && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 2000)); h = await chainHealth(); }
  if (!(h.reachable && h.state === 'SERVING')) throw new CliError(`chain did not reach SERVING within ${a.wait ?? 90}s (state: ${h.state ?? 'unreachable'}) — check \`docker logs ${CHAIN_CONTAINER}\``);
  emit(ctx, h, (x) => c.ok('✓ ') + `local AIN chain SERVING at ${x.provider}  block ${x.blockNumber ?? '?'}  validator ${x.address}\n` + c.dim('  next: \`${PROG} init --ledger ain\` (or \`${PROG} config set ledger.kind ain\`), \`${PROG} chain setup\`, \`${PROG} start\`'));
  return h;
}

export async function chainDown(ctx: CliContext): Promise<void> {
  const state = await containerState(CHAIN_CONTAINER);
  if (state === 'missing') { ok(ctx, `no ${CHAIN_CONTAINER} container`); return; }
  await docker(['rm', '-f', CHAIN_CONTAINER]);
  ok(ctx, `removed container ${CHAIN_CONTAINER} (chain data discarded)`);
}

/** Is this provider URL the local chain `ainize chain up` runs — this host, this port? (item 142) */
export function isLocalChainUrl(provider: string): boolean {
  try {
    const u = new URL(provider);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(u.hostname) && port === CHAIN_PORT;
  } catch { return false; }
}

/**
 * `chain status` reported the health of the CONFIGURED provider beside the container state of the hard-coded
 * `ngram-ain` name, so a node pointed at another chain was told `container ngram-ain: running` next to
 * `reachable no` — two confident signals about two different chains (item 142). The container is only this
 * provider's when the provider IS the local chain.
 */
export async function chainStatus(ctx: CliContext, provider?: string): Promise<ChainHealth & { container: string | null; local: boolean }> {
  const cfg = ctx.cfg;
  const url = provider ?? cfg?.ledger.ain?.providerUrl ?? `http://localhost:${CHAIN_PORT}`;
  const local = isLocalChainUrl(url);
  const [h, container] = await Promise.all([
    chainHealth(url),
    local ? containerState(CHAIN_CONTAINER).catch(() => 'missing' as const) : Promise.resolve(null),
  ]);
  const out = { ...h, container, local };
  emit(ctx, out, (x) => [
    kv([
      ['provider', x.provider],
      ['reachable', x.reachable ? c.ok('yes') : c.err('no')], ['state', x.state ?? '-'], ['health', x.health === undefined ? '-' : x.health ? c.ok('true') : c.err('false')],
      ['validator', x.address ?? '-'], ['last block', x.blockNumber ?? '-'],
      ['container', x.container === null ? c.dim(`n/a — ${x.provider} is not this machine's \`${PROG} chain up\` chain (:${CHAIN_PORT})`) : `${CHAIN_CONTAINER}: ${x.container}`],
    ]),
    ...(x.reachable ? [] : [chainUnreachableHint(x.provider, local)]),
  ].join('\n'));
  return out;
}

/** What to do about a provider that does not answer, naming the key the URL came from (item 142). */
function chainUnreachableHint(provider: string, local: boolean): string {
  return c.dim(local
    ? `the local chain is not running — \`${PROG} chain up\` starts it (docker), then \`${PROG} chain setup\``
    : `nothing answered ${provider} (from ledger.ain.providerUrl) — check the URL with \`${PROG} config set ledger.ain.providerUrl <url>\`, or run the local chain instead with \`${PROG} chain up\``);
}

/**
 * The error a driver throws when the provider is not there says `connect ECONNREFUSED 127.0.0.1:9099` and names
 * neither the config key the URL came from nor the command that starts one (item 142).
 */
function wrapProviderError(provider: string, e: unknown): Error {
  const msg = (e as Error).message ?? String(e);
  if (e instanceof CliError && !/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|ETIMEDOUT|socket hang up/i.test(msg)) return e;
  if (!/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|ETIMEDOUT|socket hang up/i.test(msg)) return e as Error;
  return new CliError(`cannot reach the AIN provider ${provider} (from ledger.ain.providerUrl): ${msg}\n  ${chainUnreachableHint(provider, isLocalChainUrl(provider))}`);
}

function assertLocal(provider: string) {
  let host = '';
  try { host = new URL(provider).hostname; } catch { throw new CliError(`invalid provider URL ${provider}`); }
  if (!['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new CliError(`refusing to use the genesis key against a non-local chain (${provider})`);
}

export async function chainFund(ctx: CliContext, address: string, amount = 1000, provider?: string): Promise<{ tx_hash: string; balance: number }> {
  const url = provider ?? ctx.cfg?.ledger.ain?.providerUrl ?? `http://localhost:${CHAIN_PORT}`;
  assertLocal(url);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new CliError('address must be a 0x-prefixed 20-byte hex address');
  const Ain = (require('@ainblockchain/ain-js') as { default: any }).default;
  const ain = new Ain(url, null, 0);
  ain.wallet.addAndSetDefaultAccount(GENESIS.privateKey);
  const res = await ain.wallet.transfer({ to: address, value: amount, nonce: -1 });
  if (res?.result?.code && res.result.code !== 0) throw new CliError(`transfer rejected: ${res.result.message ?? res.result.code}`);
  await new Promise((r) => setTimeout(r, 1500));
  const balance = await ain.wallet.getBalance(address);
  emit(ctx, { tx_hash: res.tx_hash, balance }, (x) => c.ok('✓ ') + `funded ${address} with ${amount} AIN  tx ${x.tx_hash}  balance now ${x.balance} AIN`);
  return { tx_hash: res.tx_hash, balance };
}

/** Register the knowledge app + market rules (ain-js knowledge.setupApp + our /apps/knowledge/market rules). */
export async function chainSetup(ctx: CliContext, a: { fund?: number } = {}): Promise<unknown> {
  const cfg = applyEnv(requireConfig(ctx));
  if (cfg.ledger.kind !== 'ain') throw new CliError(`node is not configured for the AIN ledger — \`${PROG} config set ledger.kind ain\` (and restart)`);
  const provider = cfg.ledger.ain!.providerUrl;
  const client = new NodeClient(ctx);
  // fund the node identity on a local chain first (setupApp needs gas-less but non-empty accounts registered)
  try {
    assertLocal(provider);
    const Ain = (require('@ainblockchain/ain-js') as { default: any }).default;
    const ain = new Ain(provider, null, 0);
    const bal = Number(await ain.wallet.getBalance(cfg.identity.address));
    if (bal <= 0 || a.fund) { await chainFund({ ...ctx, quiet: true }, cfg.identity.address, a.fund ?? 1000, provider); ok(ctx, `funded node identity ${cfg.identity.address} (${a.fund ?? 1000} AIN)`); }
  } catch (e) { if (e instanceof CliError && e.message.startsWith('refusing')) warn(ctx, 'non-local chain: make sure the node identity holds AIN before setup'); else throw wrapProviderError(provider, e); }
  if (await client.alive()) {
    const r = await client.post<{ created: boolean; tx?: string; admin?: string }>('/api/chain/setup', {}, { timeoutMs: 120_000 }).catch((e) => { throw wrapProviderError(provider, e); });
    emit(ctx, r, (x) => c.ok('✓ ') + (x.created ? `knowledge app created on-chain (tx ${x.tx}); market rules set; admin ${x.admin}` : `knowledge app already exists (admin ${x.admin ?? 'unknown'}) — rules refreshed if we are admin`));
    return r;
  }
  const ledger = new AinLedger({ providerUrl: provider, eventHandlerUrl: cfg.ledger.ain!.eventHandlerUrl, chainId: cfg.ledger.ain!.chainId }, cfg.identity);
  const r = await ledger.setupApp().catch(async (e) => { await ledger.close().catch(() => undefined); throw wrapProviderError(provider, e); });
  emit(ctx, r, (x) => c.ok('✓ ') + (x.created ? `knowledge app created on-chain (tx ${x.tx}); market rules set; admin ${x.admin}` : `knowledge app already exists (admin ${x.admin ?? 'unknown'})`));
  return r;
}
