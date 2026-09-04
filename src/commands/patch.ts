/**
 * `ainize patch …` — publish, inspect, verify, buy and apply knowledge patches.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { verificationCount } from '@ngram/core';
import type { BenchmarkSpec, CatalogEntry, Contributor, LedgerRecord, PatchAnchor } from '@ngram/core';
import { NodeClient, query } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
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
    // The numerator never exceeds the quorum (`3/2` is not a fraction anyone can read); extra independent
    // attestations are shown as `2/2+1`, and self-checks by the author are never in this count at all.
    { key: 'att', title: 'ATTEST', get: (e) => { const v = verificationCount(e); const s = v.extra ? `${v.fraction}+${v.extra}` : v.fraction; return e.quorum_ok ? c.ok(s) : c.warn(s); }, align: 'right' },
    { key: 'dl', title: 'SOLD', get: (e) => String(e.downloads), align: 'right' },
    { key: 'schema', title: 'BENCHMARK', get: (e) => e.anchor.benchmark.schema },
  ], 'no patches match'));
  return items;
}

/** `2/2 passed ✓ quorum` — clamped, with the extra evidence spelled out instead of an unreadable `3/2`. */
export function verificationLine(e: CatalogEntry): string {
  const v = verificationCount(e);
  const extra = v.extra ? c.dim(` (+${v.extra} more independent attestation${v.extra > 1 ? 's' : ''})`) : '';
  const self = e.self_checks ? c.warn(` · ${e.self_checks} self-check${e.self_checks > 1 ? 's' : ''} by the author (not counted)`) : '';
  return `${v.fraction} passed${e.quorum_ok ? c.ok(' ✓ quorum') : ''}${extra}${self}`;
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
        ['verification', verificationLine(e)], ['sold', `${e.downloads} · revenue ${e.revenue} ${a.currency}`],
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
        // `self_checks` is how many of the author's own attestations this node excluded (0 on a node that counts them).
        { key: 'ct', title: 'COUNTS', get: (x) => (e.self_checks > 0 && x.verifier.toLowerCase() === a.author.toLowerCase() ? c.warn('no — self-check') : 'yes') },
        { key: 't', title: 'AT', get: (x) => fmtTime(x.created_at) },
      ]));
    }
    if (e.challenges.length) {
      lines.push('', c.head('challenges'), table([...e.challenges].sort((x, y) => y.created_at - x.created_at), [
        { key: 'c', title: 'CHALLENGER', get: (x) => shortAddr(x.challenger, 8) },
        { key: 'r', title: 'REASON', get: (x) => x.reason },
        { key: 'o', title: 'OPEN', get: (x) => (e.open_challenge && x.created_at === e.open_challenge.created_at && x.challenger === e.open_challenge.challenger ? c.warn('yes — sale on hold') : c.dim('answered')) },
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
  /** hidden from public catalogs (e2e/test publishing on a shared chain) */
  test?: boolean;
  /** data providers credited on the record: `addr:name:share` (name optional: `addr:share`), up to 4, Σ share ≤ 1 */
  contributor?: string[];
  /** the training set beside the body (lineage design §12.4): a local .jsonl/.csv the node pins under its own sha */
  dataset?: string;
  datasetAccess?: 'public' | 'derivative' | 'private';
  datasetLicense?: string;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * `--contributor 0xabc…:Alice:0.7` → Contributor (role data_provider, proof declared — the operator vouches for the address;
 * a *signed* proof only comes from the browser teach flow). `0xabc…:0.7` omits the name; `0xabc…:Alice:0` is credit-only.
 */
export function parseContributors(list: string[] | undefined): Contributor[] | undefined {
  if (!list?.length) return undefined;
  const out: Contributor[] = [];
  for (const raw of list) {
    const parts = raw.split(':').map((x) => x.trim());
    if (parts.length < 2) throw new CliError(`--contributor must be addr:name:share or addr:share (got "${raw}")`);
    const address = parts[0]; const shareStr = parts[parts.length - 1]; const name = parts.slice(1, -1).join(':').trim();
    if (!ADDR_RE.test(address)) throw new CliError(`--contributor: "${address}" is not an AIN address (0x + 40 hex)`);
    const share = Number(shareStr.endsWith('%') ? Number(shareStr.slice(0, -1)) / 100 : shareStr);
    if (!Number.isFinite(share) || share < 0 || share > 1) throw new CliError(`--contributor: share must be 0..1 (or 0%..100%), got "${shareStr}"`);
    if (name.length > 40) throw new CliError('--contributor: name must be at most 40 characters');
    out.push({ address, share, role: 'data_provider', proof: 'declared', ...(name ? { name } : {}) });
  }
  if (out.length > 4) throw new CliError('at most 4 contributors per patch');
  const sum = out.reduce((a, x) => a + x.share, 0);
  if (sum > 1 + 1e-9) throw new CliError(`contributor shares add up to ${sum} (> 1)`);
  return out;
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
  const contributors = parseContributors(a.contributor);
  const client = new NodeClient(ctx);
  const datasetFile = a.dataset ? resolve(a.dataset) : undefined;
  if (datasetFile && !existsSync(datasetFile)) throw new CliError(`training set not found: ${datasetFile}`);
  const r = await client.post<{ anchor: PatchAnchor }>('/api/patches', {
    id: a.id, name: a.name, model_id: a.model, benchmark: JSON.stringify(b), price: a.price, description: a.description, parents: a.parents,
    branch: a.branch, topic_path: a.topic, license: a.license, billing: a.billing, path: file, visibility: a.test ? 'test' : undefined,
    contributors: contributors ? JSON.stringify(contributors) : undefined,
    // the questions this knowledge was made from, published under the access level the operator chose (§6.1)
    ...(datasetFile ? { dataset_file: datasetFile, dataset_access: a.datasetAccess ?? 'derivative', dataset_license: a.datasetLicense } : {}),
  });
  ok(ctx, `draft created: ${c.id(r.anchor.id)}  (${r.anchor.rows.toLocaleString('en-US')} rows, sha256 ${shortHash(r.anchor.patch_sha256)})`);
  if (r.anchor.dataset) ok(ctx, c.dim(`training set on the record: ${r.anchor.dataset.rows} questions, ${r.anchor.dataset.access ?? 'private'}${r.anchor.dataset.license ? `, ${r.anchor.dataset.license}` : ''} (sha256 ${shortHash(r.anchor.dataset.sha256)})`));
  if (r.anchor.contributors?.length) ok(ctx, c.dim(`data providers on the record: ${r.anchor.contributors.map((x) => `${x.name ?? shortAddr(x.address, 4)} ${Math.round(x.share * 100)}%`).join(', ')} (of this node's share of each sale)`));
  let announced = false;
  if (a.announce) { await patchAnnounce(ctx, r.anchor.id); announced = true; }
  else if (!ctx.json) ok(ctx, c.dim(`announce when ready: ainize patch announce ${r.anchor.id}`));
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
  // A challenge is not a comment: it takes the knowledge off sale everywhere until a verifier re-runs it.
  ok(ctx, c.dim(`${id} is off sale until a verifier re-runs the benchmark and passes it; the author is told who challenged it and why`));
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

/** One layer of the runtime stack as the node reports it (design §5.4). */
export interface StackLayer {
  patch_id: string; name: string | null; sha256: string; position: number; applied_at: number; reason: string;
  rows: number | null; export: 'delta' | 'squash' | null; base_stack: string[];
  journal: boolean; journal_path: string | null; stack_sha256: string | null; body_present: boolean;
}

export async function patchApply(ctx: CliContext, id: string, opts: { withBase?: boolean } = {}): Promise<string> {
  const r = await new NodeClient(ctx).post<{ result: string; stack: StackLayer[] }>(`/api/patches/${encodeURIComponent(id)}/apply`, { with_base: !!opts.withBase }, { timeoutMs: 10 * 60_000 });
  ok(ctx, `applied ${id}: ${r.result}`);
  return r.result;
}

export async function patchRemove(ctx: CliContext, id: string, opts: { cascade?: boolean } = {}): Promise<string> {
  const r = await new NodeClient(ctx).post<{ result: string; stack: StackLayer[] }>(`/api/patches/${encodeURIComponent(id)}/remove`, { cascade: !!opts.cascade }, { timeoutMs: 10 * 60_000 });
  ok(ctx, `removed ${id}: ${r.result}`);
  return r.result;
}

/** `ainize patch stack` — what is loaded in the serving model, bottom first, and what each layer sits on. */
export async function patchStack(ctx: CliContext): Promise<StackLayer[]> {
  const r = await new NodeClient(ctx).get<{ stack: StackLayer[]; journal_dir: string | null }>('/api/runtime/stack');
  emit(ctx, r.stack, () => {
    if (!r.stack.length) return c.dim('nothing is loaded in the serving model');
    return [
      ...r.stack.map((l, i) => [
        `${String(i).padStart(2)}  ${l.patch_id}${l.name ? c.dim(` — ${l.name}`) : ''}`,
        c.dim(`     ${l.rows !== null ? `${l.rows.toLocaleString()} rows · ` : ''}${l.export === 'delta' ? `add-on, needs ${l.base_stack.join(', ')} underneath` : l.export === 'squash' ? 'stand-alone build' : 'published before add-ons existed'}`),
        c.dim(`     ${l.journal ? 'can be unloaded without disturbing what is under it' : 'no journal — unloading it writes the model\'s own rows back'}${l.body_present ? '' : ' · body no longer on this node'}`),
      ].join('\n')),
      c.dim(`\nthe last line is on top: it wins on any row two of them share`),
    ].join('\n');
  });
  return r.stack;
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

export interface SharedBody { id: string; name: string; status: string; sales: number }
export interface ForgetResult { ok: true; patch_id: string; sha256: string; deleted_file: boolean; also_affects: SharedBody[] }

/** `ainize patch forget <id>` — stop serving the knowledge file from this node (the public record is untouched). */
/**
 * `ainize patch forget <id>` — stop serving the body from this node. The file is content-addressed, so it is also
 * the body of every other id trained from the same output: the node refuses and lists them, and `--all-sharing`
 * is the operator saying yes to the whole list (item 149).
 */
export async function patchForget(ctx: CliContext, id: string, opts: { allSharing?: boolean } = {}): Promise<ForgetResult> {
  let r: ForgetResult;
  try {
    r = await new NodeClient(ctx).post<ForgetResult>(`/api/patches/${encodeURIComponent(id)}/forget`, { all_sharing: !!opts.allSharing });
  } catch (e) {
    const shared = (e as CliError).details as { also_affects?: SharedBody[] } | undefined;
    if (!(e instanceof CliError) || !shared?.also_affects?.length) throw e;
    throw new CliError([
      e.message + ':',
      table(shared.also_affects, [
        { key: 'id', title: 'ALSO STOPS SERVING', get: (x) => c.id(x.id) },
        { key: 'name', title: 'NAME', get: (x) => x.name },
        { key: 'st', title: 'STATUS', get: (x) => statusColor(x.status) },
        { key: 'sales', title: 'SALES', get: (x) => String(x.sales), align: 'right' },
      ]),
      c.dim(`the public record is untouched either way. To stop serving all of them: \`${PROG} patch forget ${id} --all-sharing\``),
    ].join('\n'), 1, shared);
  }
  emit(ctx, r, (x) => c.ok('✓ ') + `forgot ${c.id(x.patch_id)} body ${c.dim(shortHash(x.sha256, 12))} — ${x.deleted_file ? 'file deleted' : 'file left in place'}, no longer served from this node`
    + (x.also_affects.length ? `\n${c.warn('! ')}same body as ${x.also_affects.map((a) => a.id).join(', ')} — those are no longer served from here either` : ''));
  return r;
}


/**
 * `ainize use <id>` — the one-line consumer path: check it is verified, pay automatically (x402), download,
 * verify the body hash and load it into this node's model. Falls back gracefully when the runtime is off.
 */
export async function patchUse(ctx: CliContext, id: string, opts: { apply?: boolean } = {}): Promise<PurchaseResult | { already: true }> {
  const client = new NodeClient(ctx);
  const detail = await client.get<PatchDetail & { purchased: boolean; has_body: boolean; owned: boolean; applied: boolean }>(`/api/patches/${encodeURIComponent(id)}`);
  const apply = opts.apply !== false;
  // SUPERSEDED knowledge stays valid (point-in-time versions); it just has a newer version on the same subject.
  if (detail.status === 'CHALLENGED') {
    const ch = detail.open_challenge;
    throw new CliError(`${id} is CHALLENGED — a verifier disputes it, so it is not for sale until it is re-verified${ch ? `\n  ${shortAddr(ch.challenger, 8)}: "${ch.reason}" (${fmtTime(ch.created_at)})` : ''}\n  see the dispute: ainize patch get ${id}`);
  }
  if (!detail.quorum_ok || !['LISTED', 'SUPERSEDED'].includes(detail.status)) throw new CliError(`${id} is ${detail.status} (verification ${detail.passed}/${detail.quorum}) — not verified yet; try \`ainize patch get ${id}\``);
  if (detail.status === 'SUPERSEDED' && detail.superseded_by?.length) ok(ctx, c.dim(`note: a newer version exists on the same subject → ${detail.superseded_by.join(', ')} (newer version available)`));
  if (detail.has_body && (detail.purchased || detail.owned)) {
    ok(ctx, `${c.id(id)} is already on this node ${detail.owned ? '(you published it)' : '(purchased)'}`);
    if (apply) { await patchApply(ctx, id); }
    if (!ctx.json) ok(ctx, c.dim(`try it: ainize chat ${id} "your question"`));
    return { already: true };
  }
  const r = await patchBuy(ctx, id, apply);
  if (!ctx.json) ok(ctx, c.dim(apply ? `loaded into the model — try: ainize chat ${id} "your question"` : `downloaded — load with: ainize patch apply ${id}`));
  return r;
}

// ---------------------------------------------------------------- `ainize patch import` (spec §10 Option B / §6.4)
/** `recipe.json` as served by `GET /api/teach/jobs/:id/recipe` (trainer recipe + node-side `lesson` block + `benchmark`); every field optional. */
export interface LessonRecipe {
  model_id?: string;
  model?: { id_M?: string; [k: string]: unknown };
  facts?: { prompt: string; answer: string; alt_prompt?: string }[];
  benchmark_samples?: { prompt: string; expect: string }[];
  benchmark?: Partial<BenchmarkSpec> & { schema?: string };
  lesson?: {
    job_id?: string; draft_id?: string | null; name?: string; model_id?: string; sha256?: string; rows?: number; filename?: string;
    facts?: { prompt: string; answer: string; alt_prompt?: string }[]; contributor?: { address: string; name?: string };
    context_patch_ids?: string[]; builds_on_context?: boolean; node?: { address?: string; name?: string; url?: string };
  };
  [k: string]: unknown;
}

export interface ImportArgs { file: string; recipe: string; id?: string; name?: string; model?: string; price?: string; license?: string; description?: string; }
export interface ImportResult { anchor: PatchAnchor; sha256: string; sha_matches: boolean | null; model_matches: boolean | null; first_prompt: string | null }

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** What the draft is built from — pure, so the unit test can pin the mapping without a node. */
export function draftFromRecipe(file: string, r: LessonRecipe, a: Partial<ImportArgs> = {}): { id: string; name: string; model_id: string | undefined; benchmark: BenchmarkSpec; description: string; contributors?: Contributor[]; parents: string[]; first_prompt: string | null } {
  const lesson = r.lesson ?? {};
  const facts = lesson.facts ?? r.facts ?? [];
  const first = facts[0]?.prompt ?? null;
  const base = basename(file).replace(/\.npz$/i, '').replace(/^lesson-/, '');
  const id = a.id ?? (lesson.draft_id ? lesson.draft_id : `taught-${slugify(base) || 'lesson'}`);
  const name = a.name ?? (lesson.name?.trim() || (first ? `Lesson: ${first.slice(0, 60)}` : `Lesson ${base}`));
  const model_id = a.model ?? r.model_id ?? lesson.model_id ?? (typeof r.model?.id_M === 'string' ? r.model.id_M : undefined);
  const samples = (r.benchmark?.samples ?? r.benchmark_samples ?? facts.map((f) => ({ prompt: `Q: ${f.prompt}\nA: `, expect: f.answer })));
  const seen = new Set<string>();
  const uniq = samples.filter((x) => { const k = `${x.prompt}\u0000${x.expect}`; if (seen.has(k) || !x.prompt) return false; seen.add(k); return true; });
  const benchmark: BenchmarkSpec = {
    schema: r.benchmark?.schema ?? `taught/${slugify(base) || 'lesson'}`, queries: r.benchmark?.queries ?? uniq.length,
    format: r.benchmark?.format ?? ['template', 'chat'], collateral_bound_nat: r.benchmark?.collateral_bound_nat ?? 0.08, samples: uniq,
  };
  const src = lesson.node?.url ? ` Imported from ${lesson.node.name ? `${lesson.node.name} (${lesson.node.url})` : lesson.node.url}${lesson.job_id ? `, lesson ${lesson.job_id}` : ''}.` : '';
  const description = a.description ?? `Taught lesson: ${facts.map((f) => `${f.prompt} → ${f.answer}`).join(' · ').slice(0, 400)}.${src}`.trim();
  const contributors = lesson.contributor && ADDR_RE.test(lesson.contributor.address)
    ? [{ address: lesson.contributor.address, share: 0, role: 'data_provider' as const, proof: 'declared' as const, ...(lesson.contributor.name ? { name: lesson.contributor.name.slice(0, 40) } : {}) }]
    : undefined;
  return { id, name, model_id, benchmark, description, contributors, parents: lesson.builds_on_context ? (lesson.context_patch_ids ?? []) : [], first_prompt: first };
}

/**
 * Import a downloaded lesson (`lesson-<slug>.npz` + `recipe.json`) as a PRIVATE draft on this node: the file stays where it is
 * (`keepInPlace`), the benchmark comes from the recipe, nothing is announced and no ledger record is written.
 * The data provider is kept on the draft as credit only (share 0) and the origin is `teach`, so a later `patch announce`
 * still shows "Taught by …" — raise the share with `PATCH /api/patches/:id` / the web form before announcing if you want to pay them.
 */
export async function patchImport(ctx: CliContext, a: ImportArgs): Promise<ImportResult> {
  const file = resolve(a.file);
  if (!existsSync(file)) throw new CliError(`file not found: ${file}`);
  if (!file.endsWith('.npz')) throw new CliError('a lesson body is a .npz (addrs/before/after arrays)');
  const recipePath = resolve(a.recipe);
  if (!existsSync(recipePath)) throw new CliError(`recipe not found: ${recipePath} (download recipe.json next to the lesson file)`);
  let recipe: LessonRecipe;
  try { recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as LessonRecipe; } catch { throw new CliError(`${recipePath} is not valid JSON`); }
  const d = draftFromRecipe(file, recipe, a);
  if (!d.model_id) throw new CliError('the recipe names no model — pass --model <id_M> (must be the exact model this node serves)');
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const expect = recipe.lesson?.sha256;
  const sha_matches = expect ? expect.toLowerCase() === sha256 : null;
  if (sha_matches === false) throw new CliError(`sha256 mismatch: file is ${sha256}, recipe.json expects ${expect} — download the lesson again`);
  const client = new NodeClient(ctx);
  let model_matches: boolean | null = null;
  try { const info = await client.get<{ model?: string | null }>('/api/info', { auth: false }); model_matches = info.model ? info.model === d.model_id : null; } catch { /* reported by the POST below */ }
  if (model_matches === false) warnLine(ctx, `this node serves a different model than the lesson was trained on (node: see /api/info, lesson: ${d.model_id}) — the lesson will not fire`);
  const parents: string[] = [];
  for (const pid of d.parents) { try { await client.get(`/api/patches/${encodeURIComponent(pid)}`, { auth: false }); parents.push(pid); } catch { warnLine(ctx, `parent knowledge ${pid} is not on this node — imported without that lineage link (load it first for the same behaviour)`); } }
  const r = await client.post<{ anchor: PatchAnchor }>('/api/patches', {
    id: d.id, name: d.name, model_id: d.model_id, benchmark: JSON.stringify(d.benchmark), description: d.description, price: a.price, license: a.license,
    parents: parents.join(',') || undefined, path: file, contributors: d.contributors ? JSON.stringify(d.contributors) : undefined,
  });
  let anchor = r.anchor;
  try { anchor = (await client.patch<{ anchor: PatchAnchor }>(`/api/patches/${encodeURIComponent(anchor.id)}`, { origin: 'teach' })).anchor; } catch { /* older node without origin — the draft is still usable */ }
  const out: ImportResult = { anchor, sha256, sha_matches, model_matches, first_prompt: d.first_prompt };
  emit(ctx, out, (x) => [
    c.ok('✓ ') + `imported ${c.id(x.anchor.id)} as a private draft  (${x.anchor.rows.toLocaleString('en-US')} rows, sha256 ${shortHash(x.sha256, 16)}${x.sha_matches ? c.ok(' matches recipe') : ''})`,
    c.dim(`  no ledger record was written; the file stays at ${file}`),
    c.dim(`  load it:   ainize patch apply ${x.anchor.id}`),
    c.dim(`  try it:    ainize chat ${x.anchor.id} ${JSON.stringify(x.first_prompt ?? 'your question')}`),
    c.dim(`  unload:    ainize patch remove ${x.anchor.id}`),
  ].join('\n'));
  return out;
}

function warnLine(ctx: CliContext, msg: string) { if (!ctx.quiet && !ctx.json) process.stderr.write(c.warn('warning: ') + msg + '\n'); }
