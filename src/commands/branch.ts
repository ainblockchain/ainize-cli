/**
 * `ngram branch …`, `ngram route`, `ngram wallet`
 */
import type { BranchInfo, PeerInfo } from '@ngram/core';
import { NodeClient, query } from '../client.js';
import { CliError, type CliContext } from '../context.js';
import { c, emit, fmtTime, kv, ok, shortAddr, table } from '../output.js';

export type BranchRow = BranchInfo & { subscribers: Partial<PeerInfo>[] };

export function parseContext(pairs: string[] = []): Record<string, string> {
  const ctxObj: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new CliError(`context must be key=value, got "${p}"`);
    ctxObj[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return ctxObj;
}

export async function branchLs(ctx: CliContext): Promise<{ branches: BranchRow[]; mine: string[] }> {
  const d = await new NodeClient(ctx).get<{ branches: BranchRow[]; mine: string[] }>('/api/branches');
  emit(ctx, d, (x) => table(x.branches, [
    { key: 'n', title: 'BRANCH', get: (b) => (x.mine.includes(b.name) ? c.ok(b.name + ' ✓') : b.name) },
    { key: 'c', title: 'CONTEXT', get: (b) => Object.entries(b.context).map(([k, v]) => `${k}=${v}`).join(' ') || '-' },
    { key: 'p', title: 'PATCHES', get: (b) => b.patch_ids.join(', ') || '-' },
    { key: 's', title: 'SUBSCRIBERS', get: (b) => b.subscribers.map((s) => s.name ?? shortAddr(s.address, 4)).join(', ') || '-' },
    { key: 'o', title: 'OWNER', get: (b) => shortAddr(b.owner, 6) },
    { key: 't', title: 'CREATED', get: (b) => fmtTime(b.created_at) },
  ], 'no branches yet — `ngram branch create law/KR --context jurisdiction=KR --patch <id>`') + (x.mine.length ? `\n${c.dim('✓ = this node subscribes')}` : ''));
  return d;
}

export async function branchCreate(ctx: CliContext, name: string, a: { description?: string; context?: string[]; patch?: string[] }): Promise<BranchInfo> {
  const r = await new NodeClient(ctx).post<{ branch: BranchInfo }>('/api/branches', { name, description: a.description ?? '', context: parseContext(a.context), patch_ids: a.patch ?? [] });
  ok(ctx, `branch ${c.id(name)} created ${c.dim(JSON.stringify(r.branch.context))} with ${r.branch.patch_ids.length} patch(es)`);
  return r.branch;
}

export async function branchAdd(ctx: CliContext, name: string, patchId: string): Promise<BranchInfo> {
  const r = await new NodeClient(ctx).post<{ branch: BranchInfo }>(`/api/branches/${encodeURIComponent(name)}/patches`, { patch_id: patchId });
  ok(ctx, `${patchId} added to ${name} (${r.branch.patch_ids.length} patches)`);
  return r.branch;
}

export async function branchSubscribe(ctx: CliContext, name: string, action: 'subscribe' | 'unsubscribe'): Promise<void> {
  await new NodeClient(ctx).post(`/api/branches/${encodeURIComponent(name)}/${action}`, {}, { timeoutMs: 30 * 60_000 });
  ok(ctx, `${action}d ${name}${action === 'subscribe' ? c.dim('  (patches acquired and applied when a runtime is available)') : ''}`);
}

export async function route(ctx: CliContext, pairs: string[]): Promise<{ branch: BranchInfo | null; nodes: PeerInfo[] }> {
  const q = parseContext(pairs);
  const d = await new NodeClient(ctx).get<{ branch: BranchInfo | null; nodes: PeerInfo[] }>(`/api/route${query(q)}`);
  emit(ctx, d, (x) => (!x.branch ? c.warn(`no branch matches ${JSON.stringify(q)}`) : [
    `context ${c.dim(JSON.stringify(q))} → branch ${c.id(x.branch.name)} ${c.dim(JSON.stringify(x.branch.context))}`,
    table(x.nodes, [
      { key: 'n', title: 'SERVING NODE', get: (n) => n.name }, { key: 'e', title: 'ENDPOINT', get: (n) => n.endpoint },
      { key: 'm', title: 'MODEL', get: (n) => n.model ?? '-' }, { key: 'a', title: 'ADDRESS', get: (n) => shortAddr(n.address, 8) },
    ], 'no node currently subscribes to that branch'),
  ].join('\n')));
  return d;
}

/** One royalty transfer this node owes (node `payouts` table): pending → paid (tx_hash) | failed (last_error, retried every 60 s up to 20 times). */
export interface PayoutRow { id: number; patch_id: string; settle_hash: string; address: string; amount: string; currency: string; status: 'pending' | 'paid' | 'failed'; tx_hash: string | null; attempts: number; last_error: string | null; created_at: number; updated_at: number }
export interface PayoutSummary { pending: number; failed: number; paid: number }
export interface WalletResponse { kind: string; address: string; balance: number | null; sales: { patch_id: string; amount: string; currency: string; buyer: string; created_at: number }[]; royalties: { patch_id: string; amount: string; created_at: number }[]; purchases: number; network: string;
  /** Unpaid royalty transfers (pre-payouts nodes omit the field). */
  payouts?: PayoutSummary & { items: PayoutRow[] } }
export interface PayoutsResponse { items: PayoutRow[]; summary: PayoutSummary; max_attempts: number; retry_ms: number; wallet: boolean }

const payoutStatus = (p: PayoutRow, maxAttempts = 20) => p.status === 'paid' ? c.ok('paid') : p.status === 'failed' ? (p.attempts >= maxAttempts ? c.err('failed (gave up)') : c.warn(`failed · retrying`)) : c.warn('pending');
const payoutTable = (rows: PayoutRow[], maxAttempts = 20) => table(rows, [
  { key: 'i', title: 'ID', get: (p) => String(p.id), align: 'right' }, { key: 'p', title: 'PATCH', get: (p) => p.patch_id }, { key: 'to', title: 'TO', get: (p) => shortAddr(p.address, 8) },
  { key: 'a', title: 'AMOUNT', get: (p) => `${p.amount} ${p.currency}`, align: 'right' }, { key: 's', title: 'STATUS', get: (p) => payoutStatus(p, maxAttempts) }, { key: 'n', title: 'TRIES', get: (p) => String(p.attempts), align: 'right' },
  { key: 't', title: 'AT', get: (p) => fmtTime(p.updated_at) }, { key: 'e', title: 'TX / ERROR', get: (p) => p.tx_hash ? p.tx_hash.slice(0, 14) + '…' : (p.last_error ?? '').slice(0, 48) },
]);

/** The wallet's payout lines (exported so the test can render a fixture). */
export function renderPayoutSummary(x: WalletResponse): string[] {
  if (!x.payouts) return [];
  const unpaid = x.payouts.items.filter((p) => p.status !== 'paid');
  const head = x.payouts.pending + x.payouts.failed === 0 ? c.ok('none pending') : `${c.warn(String(x.payouts.pending))} pending · ${(x.payouts.failed ? c.err : c.dim)(String(x.payouts.failed))} failed · ${x.payouts.paid} paid`;
  return [kv([['royalty payouts owed', head]]), ...(unpaid.length ? ['\n' + c.head('unpaid payouts (retry: ainize payouts retry <id>)') + '\n' + payoutTable(unpaid.slice(0, 10))] : [])];
}

export async function wallet(ctx: CliContext): Promise<WalletResponse> {
  const d = await new NodeClient(ctx).get<WalletResponse>('/api/me/wallet');
  emit(ctx, d, (x) => [
    kv([['address', x.address], ['ledger', `${x.kind} · ${x.network}`], ['balance', x.balance === null ? c.warn('unknown (chain unreachable)') : `${x.balance} ${x.kind === 'ain' ? 'AIN' : 'CREDIT'}`],
      ['sales', x.sales.length], ['royalties received', x.royalties.length], ['purchases', x.purchases]]),
    ...renderPayoutSummary(x),
    x.sales.length ? '\n' + c.head('recent sales') + '\n' + table(x.sales.slice(-10), [
      { key: 'p', title: 'PATCH', get: (s) => s.patch_id }, { key: 'a', title: 'AMOUNT', get: (s) => `${s.amount} ${s.currency}`, align: 'right' },
      { key: 'b', title: 'BUYER', get: (s) => shortAddr(s.buyer, 8) }, { key: 't', title: 'AT', get: (s) => fmtTime(s.created_at) },
    ]) : '',
    x.royalties.length ? '\n' + c.head('royalties') + '\n' + table(x.royalties.slice(-10), [
      { key: 'p', title: 'PATCH', get: (s) => s.patch_id }, { key: 'a', title: 'AMOUNT', get: (s) => s.amount, align: 'right' }, { key: 't', title: 'AT', get: (s) => fmtTime(s.created_at) },
    ]) : '',
  ].filter(Boolean).join('\n'));
  return d;
}

/** `ainize payouts ls [--status]` — royalty transfers this node owes creators and data providers (AIN ledger). */
export async function payoutsLs(ctx: CliContext, opts: { status?: string; address?: string; limit?: number } = {}): Promise<PayoutsResponse> {
  const d = await new NodeClient(ctx).get<PayoutsResponse>(`/api/me/payouts${query({ status: opts.status, address: opts.address, limit: opts.limit })}`);
  emit(ctx, d, (x) => [
    kv([['pending', x.summary.pending], ['failed', x.summary.failed], ['paid', x.summary.paid], ['retry', `every ${Math.round(x.retry_ms / 1000)} s, up to ${x.max_attempts} attempts`], ['chain wallet', x.wallet ? 'yes' : c.warn('no (local ledger — rows cannot be paid from this node)')]]),
    '', payoutTable(x.items, x.max_attempts),
  ].join('\n'));
  return d;
}

/** `ainize payouts retry <id>` — one immediate transfer attempt (allowed after the automatic attempts are exhausted). */
export async function payoutRetry(ctx: CliContext, id: number): Promise<{ payout: PayoutRow }> {
  const d = await new NodeClient(ctx).post<{ payout: PayoutRow }>(`/api/me/payouts/${id}/retry`, {});
  emit(ctx, d, ({ payout: p }) => p.status === 'paid'
    ? `${c.ok('✓')} payout #${p.id} paid: ${p.amount} ${p.currency} → ${shortAddr(p.address, 8)} (${p.tx_hash})`
    : `${c.err('✗')} payout #${p.id} still ${p.status} after ${p.attempts} attempt(s): ${p.last_error ?? ''}`);
  return d;
}
