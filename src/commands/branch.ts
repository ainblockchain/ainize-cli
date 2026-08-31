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

export interface WalletResponse { kind: string; address: string; balance: number | null; sales: { patch_id: string; amount: string; currency: string; buyer: string; created_at: number }[]; royalties: { patch_id: string; amount: string; created_at: number }[]; purchases: number; network: string; }

export async function wallet(ctx: CliContext): Promise<WalletResponse> {
  const d = await new NodeClient(ctx).get<WalletResponse>('/api/me/wallet');
  emit(ctx, d, (x) => [
    kv([['address', x.address], ['ledger', `${x.kind} · ${x.network}`], ['balance', x.balance === null ? c.warn('unknown (chain unreachable)') : `${x.balance} ${x.kind === 'ain' ? 'AIN' : 'CREDIT'}`],
      ['sales', x.sales.length], ['royalties received', x.royalties.length], ['purchases', x.purchases]]),
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
