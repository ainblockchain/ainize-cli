/**
 * `ainize branch …`, `ainize route`, `ainize wallet`
 */
import type { BranchInfo, CatalogEntry, PeerInfo } from '@ngram/core';
import { NodeClient, query } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, confirm, emit, fmtTime, info, kv, ok, shortAddr, table } from '../output.js';

/** `current` = what a subscriber really loads; `patch_ids` is the track's whole history (item 257). */
export type BranchRow = BranchInfo & { subscribers: Partial<PeerInfo>[]; current?: string[] };

export function parseContext(pairs: string[] = []): Record<string, string> {
  const ctxObj: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new CliError(`context must be key=value, got "${p}"`);
    ctxObj[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return ctxObj;
}

/** What a track's members are, one by one — the catalogue read once and keyed by id (items 263, 264). */
async function trackStatuses(ctx: CliContext): Promise<Map<string, CatalogEntry>> {
  // Every status by name: an omitted `status` hides RETIRED, and a track keeps its withdrawn members.
  const all = 'LISTED,SUPERSEDED,ANNOUNCED,VERIFYING,CHALLENGED,REJECTED,RETIRED,DRAFT';
  const d = await new NodeClient(ctx).get<{ items: CatalogEntry[] }>(`/api/catalog?status=${all}&limit=200&include_drafts=1`).catch(() => null);
  return new Map((d?.items ?? []).map((e) => [e.anchor.id, e]));
}

/** A track member's own state, in three characters and a colour. */
function memberChip(e: CatalogEntry | undefined, id: string): string {
  if (!e) return `${id} ${c.dim('(unknown here)')}`;
  if (e.status === 'REJECTED') return `${id} ${c.err('(failed verification)')}`;
  if (e.status === 'CHALLENGED') return `${id} ${c.err('(challenged)')}`;
  if (e.status === 'RETIRED') return `${id} ${c.dim('(withdrawn)')}`;
  if (e.status === 'SUPERSEDED') return `${id} ${c.dim('(older version)')}`;
  if (e.status !== 'LISTED') return `${id} ${c.warn(`(${e.passed}/${e.quorum} verified)`)}`;
  return c.ok(id);
}

/**
 * `ainize branch ls` — every track, and what each of its members actually is (item 263).
 *
 * A track is an append-only list, so a bake that FAILED verification stayed on it looking exactly like the one that
 * passed: subscribers could not tell "no bake today" from "today's bake failed" from "I am behind". Each member now
 * carries its own state, and a track whose newest bake failed says so, with what is being served instead.
 */
export async function branchLs(ctx: CliContext): Promise<{ branches: BranchRow[]; mine: string[] }> {
  const d = await new NodeClient(ctx).get<{ branches: BranchRow[]; mine: string[] }>('/api/branches');
  const cat = await trackStatuses(ctx);
  const newest = (b: BranchRow) => b.patch_ids.map((id) => cat.get(id)).filter((e): e is CatalogEntry => !!e)
    .sort((p, q) => q.anchor.created_at - p.anchor.created_at)[0];
  const failing = d.branches.map((b) => ({ b, last: newest(b) })).filter((x) => x.last && ['REJECTED', 'CHALLENGED'].includes(x.last.status));
  emit(ctx, d, (x) => table(x.branches, [
    { key: 'n', title: 'BRANCH', get: (b) => (x.mine.includes(b.name) ? c.ok(b.name + ' ✓') : b.name) },
    { key: 'c', title: 'CONTEXT', get: (b) => Object.entries(b.context).map(([k, v]) => `${k}=${v}`).join(' ') || '-' },
    { key: 'p', title: 'KNOWLEDGE', get: (b) => {
      const shown = b.current ?? b.patch_ids;
      const rest = b.patch_ids.filter((id) => !shown.includes(id));
      return `${shown.map((id) => memberChip(cat.get(id), id)).join(', ') || c.dim('none current')}`
        + (rest.length ? c.dim(`  (+${rest.length} not loaded: ${rest.map((id) => cat.get(id)?.status.toLowerCase() ?? 'unknown').join(', ')})`) : '');
    } },
    { key: 's', title: 'SUBSCRIBERS', get: (b) => b.subscribers.map((s) => s.name ?? shortAddr(s.address, 4)).join(', ') || '-' },
    { key: 'o', title: 'OWNER', get: (b) => shortAddr(b.owner, 6) },
    { key: 't', title: 'CREATED', get: (b) => fmtTime(b.created_at) },
  ], `no branches yet — \`${PROG} branch create law/KR --context jurisdiction=KR --patch <id>\``)
    + failing.map(({ b, last }) => `\n${c.warn('! ')}${b.name}: the newest knowledge on this track, ${last!.anchor.id}, ${last!.status === 'REJECTED' ? 'failed verification' : 'is challenged by a verifier'} — subscribers keep serving ${(b.current ?? []).join(', ') || 'nothing from this track'}`).join('')
    + (x.mine.length ? `\n${c.dim('✓ = this node subscribes')}` : ''));
  return d;
}

/**
 * `ainize branch rm <name> <id>` — take a knowledge off a track you own (item 264).
 *
 * A track was append-only: an unverified or rejected bake could be added and never removed, and `/api/route` handed
 * the whole list — retired, rejected and current alike — to every gateway. A track record is the owner's to rewrite
 * (the node accepts a `branch` record only from the address that first wrote the name), so removal is a new record
 * with the id left out; the ledger keeps both, which is what a public record is for.
 */
export async function branchRemove(ctx: CliContext, name: string, patchId: string, opts: { yes?: boolean } = {}): Promise<BranchInfo> {
  const client = new NodeClient(ctx);
  const d = await client.get<{ branches: BranchRow[] }>('/api/branches');
  const b = d.branches.find((x) => x.name === name);
  if (!b) throw new CliError(`no track called ${name} on this node — \`${PROG} branch ls\` lists them`, 1);
  if (!b.patch_ids.includes(patchId)) {
    throw new CliError(`${patchId} is not on ${name} (it has ${b.patch_ids.length ? b.patch_ids.join(', ') : 'nothing on it'})`, 1);
  }
  const subs = b.subscribers.length;
  info(ctx, [
    `${c.id(patchId)} will be taken off the track ${c.id(name)} (${b.patch_ids.length} → ${b.patch_ids.length - 1} knowledge).`,
    c.dim(`  this writes a new public track record; ${subs ? `${subs} subscribing node(s) stop buying and loading it on their next sync` : 'no node subscribes to it yet'}.`),
    c.dim('  nobody is refunded and nothing already bought is taken away — the knowledge itself stays published.'),
  ].join('\n'));
  await confirm(ctx, `Remove ${patchId} from ${name}? [y/N]`, { yes: opts.yes });
  const r = await client.post<{ branch: BranchInfo }>('/api/branches', {
    name, description: b.description, context: b.context, patch_ids: b.patch_ids.filter((id) => id !== patchId),
  });
  ok(ctx, `${patchId} removed from ${name} — ${r.branch.patch_ids.length} knowledge left on the track`);
  return r.branch;
}

export async function branchCreate(ctx: CliContext, name: string, a: { description?: string; context?: string[]; patch?: string[] }): Promise<BranchInfo> {
  const r = await new NodeClient(ctx).post<{ branch: BranchInfo }>('/api/branches', { name, description: a.description ?? '', context: parseContext(a.context), patch_ids: a.patch ?? [] });
  ok(ctx, `branch ${c.id(name)} created ${c.dim(JSON.stringify(r.branch.context))} with ${r.branch.patch_ids.length} patch(es)`);
  return r.branch;
}

export async function branchAdd(ctx: CliContext, name: string, patchId: string, opts: { force?: boolean } = {}): Promise<BranchInfo> {
  const r = await new NodeClient(ctx).post<{ branch: BranchInfo }>(`/api/branches/${encodeURIComponent(name)}/patches`, { patch_id: patchId, force: !!opts.force });
  ok(ctx, `${patchId} added to ${name} (${r.branch.patch_ids.length} patches)${opts.force ? c.warn('  — added with --force: subscribers will buy and load it even though it is not verified') : ''}`);
  return r.branch;
}

/** One item of a track as the node resolves it (`POST /api/branches/:name/quote`). */
export interface TrackItem {
  patch_id: string; name: string | null; author: string | null; author_name: string | null;
  price: string; currency: string; status: string | null;
  plan: 'buy' | 'held' | 'own' | 'retired' | 'blocked' | 'wrong_model' | 'unknown';
  reason: string; superseded_by: string[];
}
export interface TrackQuote {
  branch: string; owner: string; description: string; subscribed: boolean;
  items: TrackItem[]; current: string[]; retired: string[]; buy: string[];
  total: { currency: string; amount: string }[]; currency: string; balance: number | null;
  runtime_available: boolean; runtime_error: string | null;
}
export interface SubscribeResult {
  ok: true; branch: string; action: 'subscribe' | 'unsubscribe' | 'sync';
  acquired: string[]; failed: { patch_id: string; error: string }[]; applied: string[];
  skipped: { patch_id: string; reason: string }[]; removed: string[]; spent: { currency: string; amount: string }[];
}

const money = (t: { currency: string; amount: string }[]) => (t.length ? t.map((x) => `${x.amount} ${x.currency}`).join(' + ') : '0');

/** `ainize branch quote <name>` — what subscribing would spend, item by item, before anything is spent (item 357). */
export async function branchQuote(ctx: CliContext, name: string): Promise<TrackQuote> {
  const q = await fetchQuote(ctx, name);
  emit(ctx, q, () => renderQuote(q));
  return q;
}

async function fetchQuote(ctx: CliContext, name: string): Promise<TrackQuote> {
  const r = await new NodeClient(ctx).post<{ quote: TrackQuote }>(`/api/branches/${encodeURIComponent(name)}/quote`, {}, { timeoutMs: 120_000 });
  return r.quote;
}

const planLabel: Record<TrackItem['plan'], string> = {
  buy: 'BUY', held: 'held', own: 'yours', retired: 'retired', blocked: 'not verified', wrong_model: 'wrong model', unknown: 'unknown',
};

function renderQuote(q: TrackQuote): string {
  const lines = [
    kv([['track', q.branch], ['owner', shortAddr(q.owner, 8)], ['items', `${q.items.length} on the track · ${q.current.length} current${q.retired.length ? ` · ${q.retired.length} retired version(s) skipped` : ''}`]]),
    '',
    table(q.items, [
      { key: 'p', title: 'KNOWLEDGE', get: (i) => `${i.patch_id}${i.name ? c.dim(` — ${i.name}`) : ''}` },
      { key: 'l', title: 'PLAN', get: (i) => (i.plan === 'buy' ? c.warn(planLabel[i.plan]) : i.plan === 'held' || i.plan === 'own' ? c.ok(planLabel[i.plan]) : c.dim(planLabel[i.plan])) },
      { key: 'a', title: 'PRICE', get: (i) => (i.plan === 'buy' ? `${i.price} ${i.currency}` : '-'), align: 'right' },
      { key: 'w', title: 'WHY', get: (i) => c.dim(i.reason) },
    ], 'this track has no knowledge on it yet'),
    '',
    kv([
      ['to pay now', q.buy.length ? c.warn(money(q.total)) : c.dim('nothing')],
      ['balance', q.balance === null ? c.dim('(chain wallet — not read here)') : `${q.balance} ${q.currency}`],
      ['model', q.runtime_available ? 'available — the current items are loaded after they are bought' : c.warn(`${q.runtime_error ?? 'unreachable'} — the items are bought but nothing is loaded until it is back`)],
    ]),
  ];
  return lines.join('\n');
}

/**
 * `ainize branch subscribe <name>` (item 357). The quote is printed and answered BEFORE anything is spent, the node
 * buys everything before it announces the subscription, and a partial acquisition is an error with a non-zero exit —
 * it used to print `✓ subscribed` after spending the last credits on the first cheap item.
 */
export async function branchSubscribe(ctx: CliContext, name: string, action: 'subscribe' | 'unsubscribe', opts: { yes?: boolean } = {}): Promise<SubscribeResult> {
  const client = new NodeClient(ctx);
  if (action === 'subscribe') {
    const q = await fetchQuote(ctx, name);
    info(ctx, renderQuote(q));
    info(ctx, c.dim(`this node will also buy and load what ${name} adds later, and unload what it retires (\`${PROG} branch unsubscribe ${name}\` stops that; nothing is refunded)`));
    /*
     * Item 237 — subscribing is a PUBLIC act. It appends a `subscribe` record naming this node and the track to the
     * shared ledger, which every peer can read for good (unsubscribing appends a second record; it removes nothing),
     * while `use` / `patch apply` leave no trace anywhere but this node. An operator who treats tracks as a private
     * convenience was never told, before or after.
     */
    const me = await client.get<{ node?: { name?: string; address?: string }; name?: string }>('/api/info', { auth: false }).catch(() => null);
    const who = me?.node?.name ?? me?.name ?? ctx.nodeUrl;
    info(ctx, c.warn('! ') + `this writes a public record on the shared ledger: "${who} serves ${name}". Every peer can read it, and it stays on the record for good — unsubscribing appends another record, it does not remove this one.`);
    info(ctx, c.dim(`  loading the same knowledge by hand (\`${PROG} use <id>\`) leaves no trace outside this node.`));
    await confirm(ctx, q.buy.length
      ? `subscribe to ${name}, announce it publicly and spend ${money(q.total)} now? [y/N]`
      : `subscribe to ${name} and announce it publicly? [y/N]`, { yes: opts.yes });
  }
  const r = await client.post<SubscribeResult>(`/api/branches/${encodeURIComponent(name)}/${action}`, {}, { timeoutMs: 30 * 60_000 });
  emit(ctx, r, (x) => renderSubscribe(x, name));
  return r;
}

/** `ainize branch sync <name>` — bring a subscribed track up to date now (item 255). */
export async function branchSync(ctx: CliContext, name: string): Promise<SubscribeResult> {
  const r = await new NodeClient(ctx).post<SubscribeResult>(`/api/branches/${encodeURIComponent(name)}/sync`, {}, { timeoutMs: 30 * 60_000 });
  emit(ctx, r, (x) => (x.acquired.length || x.applied.length || x.removed.length || x.failed.length
    ? renderSubscribe(x, name)
    : c.dim(`${name} is up to date — nothing to buy, load or unload`)));
  // A track this node is subscribed to that it cannot keep up with is not a success: the caller has to hear about it
  // in the exit code, not only in the log (item 357's other half — a sync spends money and can fail item by item).
  if (r.failed.length) {
    throw new CliError(`${name}: ${r.failed.length} item(s) could not be acquired — this node is subscribed but behind:\n${r.failed.map((f) => `  ${f.patch_id}: ${f.error}`).join('\n')}`, 5);
  }
  return r;
}

function renderSubscribe(x: SubscribeResult, name: string): string {
  const out: string[] = [];
  if (x.action === 'unsubscribe') {
    out.push(c.ok('✓ ') + `unsubscribed ${name}${x.removed.length ? ` — unloaded ${x.removed.join(', ')}` : ''}`);
    out.push(c.dim('  the bodies stay on this node and nothing is refunded'));
    return out.join('\n');
  }
  out.push(x.failed.length
    ? c.warn('! ') + `${x.action === 'sync' ? 'synced' : 'subscribed'} ${name} — ${x.failed.length} item(s) could not be acquired`
    : c.ok('✓ ') + `${x.action === 'sync' ? 'synced' : 'subscribed'} ${name}`);
  if (x.acquired.length) out.push(`  bought   ${x.acquired.join(', ')}${x.spent.length ? c.dim(`  (${money(x.spent)})`) : ''}`);
  if (x.applied.length) out.push(`  loaded   ${x.applied.join(' → ')}`);
  if (x.removed.length) out.push(`  unloaded ${x.removed.join(', ')} ${c.dim('(retired by a newer version on this track)')}`);
  for (const s of x.skipped) out.push(c.dim(`  skipped  ${s.patch_id}: ${s.reason}`));
  for (const f of x.failed) out.push(c.err(`  FAILED   ${f.patch_id}: ${f.error}`));
  if (!x.applied.length && !x.acquired.length && !x.failed.length) out.push(c.dim('  nothing new to buy or load'));
  return out.join('\n');
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
/**
 * One creator-share line on THIS node's wallet. `state` is the difference between a promise and a payment (item
 * 311): `credited` = local play money already in the balance below; `paid` / `pending` / `failed` = what the seller's
 * own node answered when asked about that settlement; `unconfirmed` = nobody has confirmed anything and the only
 * evidence is the record the seller wrote.
 */
export interface RoyaltyRow { patch_id: string; amount: string; created_at: number;
  kind?: 'lineage' | 'verification'; state?: 'credited' | 'paid' | 'pending' | 'failed' | 'unconfirmed';
  seller?: string; seller_name?: string | null; currency?: string; tx_hash?: string | null; days?: number; last_error?: string | null }
export interface WalletResponse { kind: string; address: string; balance: number | null; sales: { patch_id: string; amount: string; currency: string; buyer: string; created_at: number }[]; royalties: RoyaltyRow[]; purchases: number; network: string;
  /** owed / credited / paid / unconfirmed across every royalty line (pre-311 nodes omit it). */
  royalty_totals?: { owed: string; credited: string; paid: string; unconfirmed: string };
  /** The royalty lines this node earned by VERIFYING other people's knowledge (item 325). */
  verification?: RoyaltyRow[];
  verification_total?: string;
  verifier_share?: number;
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

/** `credited` and `paid` are money; `unconfirmed` is a claim by the party that owes it (item 311). */
const royaltyState = (r: RoyaltyRow) => r.state === 'credited' ? c.ok('credited') : r.state === 'paid' ? c.ok('paid')
  : r.state === 'failed' ? c.err('transfer failed') : r.state === 'pending' ? c.warn('seller says pending')
  : c.warn(`unconfirmed${r.days ? ` (${r.days}d)` : ''}`);

export async function wallet(ctx: CliContext): Promise<WalletResponse> {
  const d = await new NodeClient(ctx).get<WalletResponse>('/api/me/wallet');
  emit(ctx, d, (x) => [
    kv([['address', x.address], ['ledger', `${x.kind} · ${x.network}`], ['balance', x.balance === null ? c.warn('unknown (chain unreachable)') : `${x.balance} ${x.kind === 'ain' ? 'AIN' : 'CREDIT'}`],
      ['sales', x.sales.length], ['royalties received', x.royalties.length], ['purchases', x.purchases]]),
    // The three totals a creator has to be able to reconcile: what the records promise, what is actually in the
    // balance or on the chain, and what nobody has confirmed (item 311).
    ...(x.royalty_totals ? [kv([
      ['creator share owed to you', `${x.royalty_totals.owed} ${x.kind === 'ain' ? 'AIN' : 'CREDIT'} ${c.dim('(what the settle records promise)')}`],
      ['of that, in your balance', c.ok(x.royalty_totals.credited)],
      ['of that, transferred', `${x.royalty_totals.paid} ${c.dim("(the seller's node reports the transfer)")}`],
      ['of that, unconfirmed', (Number(x.royalty_totals.unconfirmed) > 0 ? c.warn : c.dim)(`${x.royalty_totals.unconfirmed} ${c.dim('(promised on the record, nobody has confirmed a transfer)')}`)],
    ])] : []),
    // Verifying used to earn nothing anywhere in this product (item 325).
    ...(x.verification ? [kv([['earned from verifying', x.verification.length
      ? `${x.verification_total} ${x.kind === 'ain' ? 'AIN' : 'CREDIT'} ${c.dim(`over ${x.verification.length} sale(s) of knowledge you verified`)}`
      : c.dim(`nothing yet${x.verifier_share ? ` — you are paid ${Math.round(x.verifier_share * 100)}% of the seller's side of every sale of a knowledge your attestation keeps on sale` : ''}`)]])] : []),
    ...renderPayoutSummary(x),
    x.sales.length ? '\n' + c.head('recent sales') + '\n' + table(x.sales.slice(-10), [
      { key: 'p', title: 'PATCH', get: (s) => s.patch_id }, { key: 'a', title: 'AMOUNT', get: (s) => `${s.amount} ${s.currency}`, align: 'right' },
      { key: 'b', title: 'BUYER', get: (s) => shortAddr(s.buyer, 8) }, { key: 't', title: 'AT', get: (s) => fmtTime(s.created_at) },
    ]) : '',
    x.royalties.length ? '\n' + c.head('creator share (what each sale owes you, and whether it moved)') + '\n' + table(x.royalties.slice(-10), [
      { key: 'p', title: 'PATCH', get: (s) => s.patch_id }, { key: 'a', title: 'AMOUNT', get: (s) => s.amount, align: 'right' },
      { key: 'k', title: 'FOR', get: (s) => (s.kind === 'verification' ? 'verifying' : 'lineage') },
      { key: 'f', title: 'FROM', get: (s) => s.seller_name ?? (s.seller ? shortAddr(s.seller, 8) : '-') },
      { key: 'st', title: 'STATE', get: (s) => (s.state ? royaltyState(s) : c.dim('—')) },
      { key: 'x', title: 'TX', get: (s) => (s.tx_hash ? s.tx_hash.slice(0, 14) + '…' : '') },
      { key: 't', title: 'AT', get: (s) => fmtTime(s.created_at) },
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
