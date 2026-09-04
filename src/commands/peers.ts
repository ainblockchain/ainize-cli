/** `ainize peers ls|add|rm` */
import { NodeClient } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { emit, fmtTime, info, ok, shortAddr, table, warn, c } from '../output.js';

export interface PeerRow {
  endpoint: string; address: string | null; last_seen: number; failures: number;
  info: { name?: string; roles?: string[]; ledger?: string } | null;
  /** `/api/nodes` (this build): the last gossip round succeeded, and the peer's ledger is one this node can read. */
  reachable?: boolean; ledger?: string | null; ledger_mismatch?: boolean;
  /** Where the peer came from (item 136): the operator's config, or an endpoint another peer advertised. */
  source?: 'configured' | 'learned'; learned_from?: string | null;
  /** Why the last round failed and when it was tried (item 138) — absent on nodes older than this CLI. */
  last_error?: string | null; last_attempt?: number;
}

/** An endpoint `peers rm` took out; gossip may not put it back until `peers add` re-admits it (item 137). */
export interface BlockedPeer { endpoint: string; blocked_at: number; reason: string | null }

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

/** `4h 12m` / `3m` / `18s` — how long ago, for a column that has to fit. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

/**
 * `ok` / `unreachable since 12m — connect ECONNREFUSED` (item 138). A dead peer used to be a raw integer in a
 * FAILURES column, with no error text anywhere in the product and no event in the log an operator watches.
 */
export function peerState(p: PeerRow): string {
  if (!p.failures) return p.last_seen ? c.ok('ok') : c.dim('not tried yet');
  const since = p.last_seen ? ` since ${ago(Date.now() - p.last_seen)}` : ' (never reached)';
  const why = p.last_error ? c.dim(` — ${p.last_error.slice(0, 60)}`) : '';
  return c.warn(`unreachable${since}`) + c.dim(` ×${p.failures}`) + why;
}

/** `configured` (config.json / `peers add`) or `learned` (another peer advertised it) — item 136. */
export const peerSource = (p: PeerRow): string => (p.source === 'learned' ? c.warn('learned') : p.source ? 'configured' : c.dim('-'));

/** The columns every peer table in the CLI prints, so `peers ls` and `nodes` can never disagree. */
export const peerColumns = [
  { key: 'ep', title: 'ENDPOINT', get: (p: PeerRow) => p.endpoint },
  { key: 'name', title: 'NAME', get: (p: PeerRow) => p.info?.name ?? c.dim('(unreached)') },
  { key: 'src', title: 'SOURCE', get: peerSource },
  { key: 'addr', title: 'ADDRESS', get: (p: PeerRow) => shortAddr(p.address, 8) },
  { key: 'ledger', title: 'LEDGER', get: (p: PeerRow) => (p.ledger ? (p.ledger_mismatch ? c.warn(`${p.ledger} ≠ ours`) : p.ledger) : '-') },
  { key: 'seen', title: 'LAST SEEN', get: (p: PeerRow) => fmtTime(p.last_seen) },
  { key: 'state', title: 'STATE', get: peerState },
];

/** What `peers rm` took out of the gossip network, under the table it is missing from. */
export function blockedLines(blocked: BlockedPeer[] | undefined): string[] {
  if (!blocked?.length) return [];
  return [
    '',
    c.dim(`blocked from re-discovery (${blocked.length}) — gossip may not add these back:`),
    ...blocked.map((b) => c.dim(`  ${b.endpoint}  removed ${fmtTime(b.blocked_at)}${b.reason ? ` (${b.reason})` : ''}`)),
    c.dim(`  \`${PROG} peers add <url>\` re-admits one.`),
  ];
}

export async function peersLs(ctx: CliContext): Promise<PeerRow[]> {
  const d = await new NodeClient(ctx).get<{ peers: PeerRow[]; blocked?: BlockedPeer[]; peer_status?: PeerStatus }>('/api/nodes', { auth: false });
  // `--json` stays the plain peer array every existing script reads; the blocked list is rendered below the table.
  emit(ctx, d.peers, () => [
    table(d.peers, [
      ...peerColumns.slice(0, 3),
      { key: 'roles', title: 'ROLES', get: (p: PeerRow) => p.info?.roles?.join(',') ?? '-' },
      ...peerColumns.slice(3),
    ], `no peers — \`${PROG} peers add http://host:port\``),
    ...(d.peers.some((p) => p.source === 'learned')
      ? [c.dim(`learned peers were advertised by another peer, not configured here; \`${PROG} peers rm <url>\` removes one and keeps it out.`)] : []),
    ...blockedLines(d.blocked),
    ...ledgerMismatchLines(d.peer_status),
  ].join('\n'));
  return d.peers;
}

export async function peersAdd(ctx: CliContext, endpoint: string): Promise<void> {
  if (!/^https?:\/\//.test(endpoint)) throw new CliError('endpoint must be an http(s) URL');
  const ep = endpoint.replace(/\/+$/, '');
  const client = new NodeClient(ctx);
  const r = await client.post<{ ok: boolean; unblocked?: boolean }>('/api/peers', { endpoint: ep });
  ok(ctx, r.unblocked ? `peer added: ${endpoint} (it was blocked from re-discovery; that block is lifted)` : `peer added: ${endpoint}`);
  const own = ctx.cfg?.ledger.kind
    ?? (await client.get<{ ledger: { kind: 'local' | 'ain' } }>('/api/info', { auth: false }).catch(() => null))?.ledger.kind;
  if (own) await warnLedgerMismatch(ctx, ep, own);
}

/**
 * Remove a peer — and mean it (items 137, 138). The DELETE used to be fire-and-forget: `✓ peer removed` for an
 * endpoint that was never there, and the peer itself was back within one 4-second gossip round because any third
 * node that still listed it taught it straight back.
 */
export async function peersRm(ctx: CliContext, endpoint: string): Promise<void> {
  const ep = endpoint.replace(/\/+$/, '');
  const r = await new NodeClient(ctx).delete<{ ok: boolean; removed?: boolean; blocked?: boolean }>('/api/peers', { endpoint: ep });
  if (r.removed === false) {
    throw new CliError(`no such peer: ${ep} — \`${PROG} peers ls\` lists the ones this node has (nothing was changed)`);
  }
  ok(ctx, r.blocked === false ? `peer removed: ${ep}` : `peer removed and blocked from re-discovery: ${ep}\n  ${c.dim(`gossip will not add it back; \`${PROG} peers add ${ep}\` re-admits it.`)}`);
}
