/** `ainize peers ls|add|rm` */
import { NodeClient } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { emit, fmtTime, info, ok, shortAddr, table, warn, c } from '../output.js';

export interface PeerRow {
  endpoint: string; address: string | null; last_seen: number; failures: number;
  info: { name?: string; roles?: string[]; ledger?: string } | null;
  /** `/api/nodes` (this build): the last gossip round succeeded, and the peer's ledger is one this node can read. */
  reachable?: boolean; ledger?: string | null; ledger_mismatch?: boolean;
}

/**
 * What this node knows about its peers beyond "peers: 3" (item 170): how many answered, how many of those verify,
 * and which publish on a ledger this node cannot read. `/api/info.peer_status` and `/api/nodes.peer_status`.
 */
export interface PeerStatus {
  known: number; reachable: number; unreachable: number; verifiers: number;
  ledger_mismatch: number; ledger: 'local' | 'ain';
  mismatched: { endpoint: string; name: string | null; ledger: string }[];
}

const ledgerName = (k: string) => (k === 'ain' ? 'the AIN ledger' : 'the local record DAG');

/**
 * The paragraph an operator needed the first time they pointed their own node at a marketplace on another ledger:
 * every health indicator is green, the catalogue is empty, and nothing said why (item 170).
 */
export function ledgerMismatchLines(st: PeerStatus | undefined | null): string[] {
  if (!st?.mismatched?.length) return [];
  const out: string[] = [];
  for (const m of st.mismatched) {
    out.push(c.warn('! ') + `${m.name ?? m.endpoint} publishes on ${ledgerName(m.ledger)}; this node reads ${ledgerName(st.ledger)}, so its knowledge will never appear here.`);
    out.push(c.dim(`    trade with it directly:  ${PROG} patch ls --node ${m.endpoint}`));
    out.push(c.dim(`    or move this node over:  ${PROG} stop && ${PROG} init --force --ledger ${m.ledger}${m.ledger === 'ain' ? ' --ain-provider <url>' : ''} && ${PROG} start -d`));
  }
  return out;
}

/** Ask an endpoint what it is before this node commits to peering with it (`/p2p/info` is public). */
export async function probePeer(endpoint: string, timeoutMs = 4000): Promise<{ name: string; address: string; ledger: string; roles: string[] } | null> {
  try {
    const r = await fetch(`${endpoint.replace(/\/+$/, '')}/p2p/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const d = (await r.json()) as { name?: string; address?: string; ledger?: string; roles?: string[] };
    if (!d?.address || !d.ledger) return null;
    return { name: d.name ?? endpoint, address: d.address, ledger: d.ledger, roles: d.roles ?? [] };
  } catch { return null; }
}

/**
 * Warn — at the moment the mistake is made, not an hour later — when the peer being added publishes on a ledger this
 * node cannot read. Used by `peers add` and by `init --peer` (item 170).
 */
export async function warnLedgerMismatch(ctx: CliContext, endpoint: string, ownLedger: 'local' | 'ain'): Promise<boolean> {
  const p = await probePeer(endpoint);
  if (!p) { info(ctx, c.dim(`(${endpoint} did not answer /p2p/info yet — its ledger will be checked on the next gossip round)`)); return false; }
  if (p.ledger === ownLedger) return false;
  warn(ctx, [
    `${p.name} (${endpoint}) publishes on ${ledgerName(p.ledger)}; this node reads ${ledgerName(ownLedger)}.`,
    c.dim('  It will answer every peer request and serve an empty record set forever: its knowledge can never appear in this'),
    c.dim('  node\'s catalogue, and `patch ls` will stay empty however healthy the peer looks.'),
    c.dim(`    trade with it directly:  ${PROG} patch ls --node ${endpoint}`),
    c.dim(`    or move this node over:  ${PROG} init --force --ledger ${p.ledger}${p.ledger === 'ain' ? ' --ain-provider <url>' : ''}`),
  ].join('\n'));
  return true;
}

export async function peersLs(ctx: CliContext): Promise<PeerRow[]> {
  const d = await new NodeClient(ctx).get<{ peers: PeerRow[]; peer_status?: PeerStatus }>('/api/nodes', { auth: false });
  emit(ctx, d.peers, (rows) => [
    table(rows, [
      { key: 'ep', title: 'ENDPOINT', get: (p) => p.endpoint },
      { key: 'name', title: 'NAME', get: (p) => p.info?.name ?? c.dim('(unreached)') },
      { key: 'addr', title: 'ADDRESS', get: (p) => shortAddr(p.address, 8) },
      { key: 'roles', title: 'ROLES', get: (p) => p.info?.roles?.join(',') ?? '-' },
      { key: 'ledger', title: 'LEDGER', get: (p) => (p.ledger ? (p.ledger_mismatch ? c.warn(`${p.ledger} ≠ ours`) : p.ledger) : '-') },
      { key: 'seen', title: 'LAST SEEN', get: (p) => fmtTime(p.last_seen) },
      { key: 'fail', title: 'FAILURES', get: (p) => (p.failures ? c.warn(String(p.failures)) : '0'), align: 'right' },
    ], `no peers configured — \`${PROG} peers add http://host:port\``),
    ...ledgerMismatchLines(d.peer_status),
  ].join('\n'));
  return d.peers;
}

export async function peersAdd(ctx: CliContext, endpoint: string): Promise<void> {
  if (!/^https?:\/\//.test(endpoint)) throw new CliError('endpoint must be an http(s) URL');
  const ep = endpoint.replace(/\/+$/, '');
  const client = new NodeClient(ctx);
  await client.post('/api/peers', { endpoint: ep });
  ok(ctx, `peer added: ${endpoint}`);
  const own = ctx.cfg?.ledger.kind
    ?? (await client.get<{ ledger: { kind: 'local' | 'ain' } }>('/api/info', { auth: false }).catch(() => null))?.ledger.kind;
  if (own) await warnLedgerMismatch(ctx, ep, own);
}

export async function peersRm(ctx: CliContext, endpoint: string): Promise<void> {
  await new NodeClient(ctx).delete('/api/peers', { endpoint: endpoint.replace(/\/+$/, '') });
  ok(ctx, `peer removed: ${endpoint}`);
}
