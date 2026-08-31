/**
 * `ngram patch …` — publish, inspect, verify, buy and apply knowledge patches.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatalogEntry, LedgerRecord, PatchAnchor } from '@ngram/core';
import { NodeClient, query } from '../client.js';
import { CliError, type CliContext } from '../context.js';
import { c, emit, fmtBytes, fmtTime, kv, ok, shortAddr, shortHash, statusColor, table } from '../output.js';

export interface LsArgs { status?: string; model?: string; schema?: string; branch?: string; author?: string; q?: string; sort?: string; limit?: number; mine?: boolean; drafts?: boolean; }

export async function patchLs(ctx: CliContext, a: LsArgs = {}): Promise<CatalogEntry[]> {
  const client = new NodeClient(ctx);
  let items: CatalogEntry[];
  if (a.mine) {
    items = (await client.get<{ items: CatalogEntry[] }>('/api/me/patches')).items;
  } else {
    const d = await client.get<{ items: CatalogEntry[]; total: number }>(`/api/catalog${query({ status: a.status, model: a.model, schema: a.schema, branch: a.branch, author: a.author, q: a.q, sort: a.sort ?? 'latest', limit: a.limit ?? 100, include_drafts: a.drafts })}`);
    items = d.items;
  }
  emit(ctx, items, (rows) => table(rows, [
    { key: 'id', title: 'ID', get: (e) => c.id(e.anchor.id) },
    { key: 'status', title: 'STATUS', get: (e) => statusColor(e.status) },
    { key: 'author', title: 'AUTHOR', get: (e) => (!e.anchor.author.startsWith('0x') ? e.anchor.author : e.anchor.author_name ? `${e.anchor.author_name} ${c.dim(shortAddr(e.anchor.author, 4))}` : shortAddr(e.anchor.author, 6)) },
    { key: 'model', title: 'MODEL', get: (e) => e.anchor.model.id_M },
    { key: 'rows', title: 'ROWS', get: (e) => e.anchor.rows.toLocaleString('en-US'), align: 'right' },
    { key: 'size', title: 'SIZE', get: (e) => fmtBytes(e.anchor.size_bytes), align: 'right' },
    { key: 'price', title: 'PRICE', get: (e) => `${e.anchor.price} ${e.anchor.currency}`, align: 'right' },
    { key: 'att', title: 'ATTEST', get: (e) => { const s = `${e.passed}/${e.quorum}`; return e.quorum_ok ? c.ok(s) : c.warn(s); }, align: 'right' },
    { key: 'dl', title: 'SOLD', get: (e) => String(e.downloads), align: 'right' },
    { key: 'schema', title: 'BENCHMARK', get: (e) => e.anchor.benchmark.schema },
  ], 'no patches match'));
  return items;
}

export interface PatchDetail extends CatalogEntry {
  lineage: { parents: { id: string; name: string; author: string; status: string }[]; children: { id: string; name: string; author: string; status: string }[] };
  conflicts: { patch_id: string; overlap_rows: number; same_schema: boolean; status: string }[];
  branches: { name: string; context: Record<string, string> }[];
  owned: boolean; purchased: boolean; has_body: boolean; applied: boolean; gateway_url: string | null;
}

export async function patchGet(ctx: CliContext, id: string): Promise<PatchDetail> {
  const d = await new NodeClient(ctx).get<PatchDetail>(`/api/patches/${encodeURIComponent(id)}`);
  emit(ctx, d, (e) => {
    const a = e.anchor;
    const lines = [
      c.bold(a.name) + '  ' + statusColor(e.status) + (e.owned ? c.dim('  (yours)') : '') + (e.purchased ? c.ok('  purchased') : '') + (e.applied ? c.ok('  applied') : ''),
      kv([
        ['id', a.id], ['author', `${a.author_name ?? ''} ${a.author}`.trim()], ['model', `${a.model.id_M}${a.model.checkpoint_hash ? ` (${a.model.checkpoint_hash})` : ''}`],
        ['rows / size', `${a.rows.toLocaleString('en-US')} rows · ${fmtBytes(a.size_bytes)}`], ['sha256', a.patch_sha256],
        ['price', `${a.price} ${a.currency} · ${a.billing}`], ['benchmark', `${a.benchmark.schema} · ${a.benchmark.queries} queries · ${a.benchmark.format.join('/')}${a.benchmark.collateral_bound_nat ? ` · collateral ≤ ${a.benchmark.collateral_bound_nat} nat` : ''}`],
        ['benchmark hash', a.benchmark_hash], ['topic', a.topic_path], ['branch', a.branch ?? '-'], ['gateway', e.gateway_url ?? '-'],
        ['verification', `${e.passed}/${e.quorum} passed${e.quorum_ok ? c.ok(' ✓ quorum') : ''}`], ['sold', `${e.downloads} · revenue ${e.revenue} ${a.currency}`],
        ['created', fmtTime(a.created_at)], ['body on this node', e.has_body ? 'yes' : 'no'],
      ]),
      '', a.description ? a.description : c.dim('(no description)'),
    ];
    if (e.attestations.length) {
      lines.push('', c.head('attestations'), table(e.attestations, [
        { key: 'v', title: 'VERIFIER', get: (x) => `${x.verifier_name ?? ''} ${c.dim(shortAddr(x.verifier, 6))}`.trim() },
        { key: 'r', title: 'RESULT', get: (x) => (x.passed ? c.ok('PASS') : c.err('FAIL')) },
        { key: 's', title: 'SCORE', get: (x) => Object.entries(x.score).map(([k, v]) => `${k}=${v}`).join(' ') },
        { key: 'on', title: 'VERIFIED ON', get: (x) => x.verified_on },
        { key: 'rs', title: 'RESTARTS', get: (x) => String(x.restarts_detected ?? 0), align: 'right' },
        { key: 'st', title: 'STAKE', get: (x) => x.stake, align: 'right' },
        { key: 't', title: 'AT', get: (x) => fmtTime(x.created_at) },
      ]));
    }
    lines.push('', c.head('lineage'),
      `  parents : ${e.lineage.parents.map((p) => `${p.id} ${c.dim(`(${p.status})`)}`).join(', ') || c.dim('none (root)')}`,
      `  children: ${e.lineage.children.map((p) => `${p.id} ${c.dim(`(${p.status})`)}`).join(', ') || c.dim('none')}`,
      e.supersedes.length ? `  supersedes: ${e.supersedes.join(', ')}` : '', e.superseded_by.length ? c.warn(`  superseded by: ${e.superseded_by.join(', ')}`) : '');
    if (e.conflicts.length) {
      lines.push('', c.head('address-set overlaps (A₁ ∩ A₂)'), table(e.conflicts, [
        { key: 'p', title: 'PATCH', get: (x) => x.patch_id }, { key: 'o', title: 'SHARED ROWS', get: (x) => x.overlap_rows.toLocaleString('en-US'), align: 'right' },
        { key: 's', title: 'SAME SCHEMA', get: (x) => (x.same_schema ? c.warn('yes → conflicting knowledge') : 'no') }, { key: 'st', title: 'STATUS', get: (x) => statusColor(x.status) },
      ]));
    }
    if (e.branches.length) lines.push('', c.head('branches'), ...e.branches.map((b) => `  ${b.name} ${c.dim(JSON.stringify(b.context))}`));
    if (e.settlements.length) {
      lines.push('', c.head('settlements'), table(e.settlements.slice(-10), [
        { key: 'b', title: 'BUYER', get: (s) => shortAddr(s.buyer, 8) }, { key: 'a', title: 'AMOUNT', get: (s) => `${s.amount} ${s.currency}`, align: 'right' },
        { key: 'sch', title: 'SCHEME', get: (s) => s.scheme }, { key: 'tx', title: 'TX', get: (s) => shortHash(s.tx_hash, 14) },
        { key: 'r', title: 'ROYALTY', get: (s) => Object.entries(s.royalty).map(([k, v]) => `${shortAddr(k, 4)}:${v}`).join(' ') }, { key: 't', title: 'AT', get: (s) => fmtTime(s.created_at) },
      ]));
    }
    return lines.filter((l) => l !== '').join('\n');
  });
  return d;
}

export interface PublishArgs {
  file: string; name: string; model: string; benchmark: string; id?: string; price?: string; description?: string; parents?: string; branch?: string;
  topic?: string; license?: string; billing?: 'per_download' | 'per_apply_hour' | 'per_hit'; announce?: boolean;
}

export async function patchPublish(ctx: CliContext, a: PublishArgs): Promise<{ anchor: PatchAnchor; announced: boolean }> {
  const file = resolve(a.file);
  if (!existsSync(file)) throw new CliError(`file not found: ${file}`);
  if (!file.endsWith('.npz')) throw new CliError('patch body must be a .npz (addrs/before/after arrays)');
  let benchmark: unknown;
  if (existsSync(a.benchmark)) benchmark = JSON.parse(readFileSync(a.benchmark, 'utf8'));
  else { try { benchmark = JSON.parse(a.benchmark); } catch { throw new CliError('--benchmark must be a JSON file path or inline JSON'); } }
  const b = benchmark as { schema?: string; queries?: number; format?: string[] };
  if (!b.schema) throw new CliError('benchmark.schema is required (e.g. "krx-ticker-codes")');
  if (!b.queries) b.queries = 0;
  if (!b.format) b.format = ['template'];
  const client = new NodeClient(ctx);
  const r = await client.post<{ anchor: PatchAnchor }>('/api/patches', {
    id: a.id, name: a.name, model_id: a.model, benchmark: JSON.stringify(b), price: a.price, description: a.description, parents: a.parents,
    branch: a.branch, topic_path: a.topic, license: a.license, billing: a.billing, path: file,
  });
  ok(ctx, `draft created: ${c.id(r.anchor.id)}  (${r.anchor.rows.toLocaleString('en-US')} rows, sha256 ${shortHash(r.anchor.patch_sha256)})`);
  let announced = false;
  if (a.announce) { await patchAnnounce(ctx, r.anchor.id); announced = true; }
  else if (!ctx.json) ok(ctx, c.dim(`announce when ready: ngram patch announce ${r.anchor.id}`));
  if (ctx.json) emit(ctx, { anchor: r.anchor, announced }, () => '');
  return { anchor: r.anchor, announced };
}

export async function patchAnnounce(ctx: CliContext, id: string): Promise<LedgerRecord> {
  const r = await new NodeClient(ctx).post<{ record: LedgerRecord }>(`/api/patches/${encodeURIComponent(id)}/announce`);
  ok(ctx, `announced ${c.id(id)} → ledger record ${shortHash(r.record.hash, 16)} ${c.dim('(verifiers will now attest; quorum lists it)')}`);
  return r.record;
}

export async function patchVerify(ctx: CliContext, id: string): Promise<unknown> {
  const r = await new NodeClient(ctx).post<{ attestation: { passed: boolean; score: Record<string, unknown>; verified_on: string } }>(`/api/patches/${encodeURIComponent(id)}/verify`, {}, { timeoutMs: 30 * 60_000 });
  emit(ctx, r, (x) => `${x.attestation.passed ? c.ok('PASS') : c.err('FAIL')} ${id} on ${x.attestation.verified_on}  ${c.dim(JSON.stringify(x.attestation.score))}`);
  return r;
}

export async function patchChallenge(ctx: CliContext, id: string, reason: string): Promise<void> {
  await new NodeClient(ctx).post(`/api/patches/${encodeURIComponent(id)}/challenge`, { reason });
  ok(ctx, `challenge recorded for ${id}: ${reason}`);
}

export interface PurchaseResult { patch_id: string; steps: { step: string; detail: string; at: number }[]; manifest: { patch_sha256: string; size_bytes: number; rows: number }; path: string; tx_hash: string; amount: string; scheme: string; }

export async function patchBuy(ctx: CliContext, id: string, apply = false): Promise<PurchaseResult> {
  const r = await new NodeClient(ctx).post<PurchaseResult>(`/api/patches/${encodeURIComponent(id)}/buy`, { apply }, { timeoutMs: 30 * 60_000 });
  emit(ctx, r, (x) => {
    const t0 = x.steps[0]?.at ?? Date.now();
    return [
      c.ok('✓ ') + `bought ${c.id(x.patch_id)} for ${x.amount} (${x.scheme})  tx ${shortHash(x.tx_hash, 16)}`,
      ...x.steps.map((s) => `  ${c.dim(`+${String(s.at - t0).padStart(5)}ms`)}  ${c.head(s.step.padEnd(9))} ${s.detail}`),
      c.dim(`  body: ${x.path}`),
    ].join('\n');
  });
  return r;
}

export async function patchApply(ctx: CliContext, id: string): Promise<string> {
  const r = await new NodeClient(ctx).post<{ result: string }>(`/api/patches/${encodeURIComponent(id)}/apply`, {}, { timeoutMs: 10 * 60_000 });
  ok(ctx, `applied ${id}: ${r.result}`);
  return r.result;
}

export async function patchRemove(ctx: CliContext, id: string): Promise<string> {
  const r = await new NodeClient(ctx).post<{ result: string }>(`/api/patches/${encodeURIComponent(id)}/remove`, {}, { timeoutMs: 10 * 60_000 });
  ok(ctx, `removed ${id}: ${r.result}`);
  return r.result;
}

export async function patchConflicts(ctx: CliContext, id: string): Promise<PatchDetail['conflicts']> {
  const r = await new NodeClient(ctx).get<{ conflicts: PatchDetail['conflicts'] }>(`/api/patches/${encodeURIComponent(id)}/conflicts`);
  emit(ctx, r.conflicts, (rows) => table(rows, [
    { key: 'p', title: 'PATCH', get: (x) => x.patch_id }, { key: 'o', title: 'SHARED ROWS', get: (x) => x.overlap_rows.toLocaleString('en-US'), align: 'right' },
    { key: 's', title: 'SAME SCHEMA', get: (x) => (x.same_schema ? c.warn('yes') : 'no') }, { key: 'st', title: 'STATUS', get: (x) => statusColor(x.status) },
  ], 'no address-set overlap with any patch body held by this node'));
  return r.conflicts;
}

export async function patchRecords(ctx: CliContext, id: string): Promise<LedgerRecord[]> {
  const r = await new NodeClient(ctx).get<{ records: LedgerRecord[] }>(`/api/patches/${encodeURIComponent(id)}/records`);
  emit(ctx, r.records, (rows) => table(rows, [
    { key: 't', title: 'AT', get: (x) => fmtTime(x.ts) }, { key: 'k', title: 'KIND', get: (x) => c.id(x.kind) },
    { key: 'a', title: 'AUTHOR', get: (x) => shortAddr(x.author, 8) }, { key: 'h', title: 'HASH', get: (x) => shortHash(x.hash, 16) },
    { key: 's', title: 'SIG/TX', get: (x) => shortHash(x.sig, 16) },
  ], 'no ledger records for that patch'));
  return r.records;
}

export async function patchRm(ctx: CliContext, id: string): Promise<void> {
  await new NodeClient(ctx).delete(`/api/patches/${encodeURIComponent(id)}`);
  ok(ctx, `draft ${id} deleted`);
}
