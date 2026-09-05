/**
 * `ainize patch …` — publish, inspect, verify, buy and apply knowledge patches.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { verificationCount } from '@ngram/core';
import type { BenchmarkSpec, CatalogEntry, Contributor, LedgerRecord, PatchAnchor } from '@ngram/core';
import { NodeClient, query } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { ask, c, confirm, emit, emitStep, fmtBytes, fmtTime, info, kv, ok, shortAddr, shortHash, statusColor, table, warn } from '../output.js';

export interface LsArgs { status?: string; model?: string; schema?: string; branch?: string; author?: string; q?: string; sort?: string; limit?: number; mine?: boolean; drafts?: boolean; }

/** Position in the serving model's stack, by knowledge id (`GET /api/runtime/stack`) — item 216. */
export async function loadedPositions(client: NodeClient): Promise<Map<string, number>> {
  const r = await client.get<{ stack: StackLayer[] }>('/api/runtime/stack').catch(() => null);
  return new Map((r?.stack ?? []).map((l, i) => [l.patch_id, i + 1]));
}

export async function patchLs(ctx: CliContext, a: LsArgs = {}): Promise<CatalogEntry[]> {
  const client = new NodeClient(ctx);
  let items: CatalogEntry[];
  if (a.mine) {
    items = (await client.get<{ items: CatalogEntry[] }>('/api/me/patches')).items;
  } else {
    const d = await client.get<{ items: CatalogEntry[]; total: number }>(`/api/catalog${query({ status: a.status, model: a.model, schema: a.schema, branch: a.branch, author: a.author, q: a.q, sort: a.sort ?? 'latest', limit: a.limit ?? 100, include_drafts: a.drafts })}`);
    items = d.items;
  }
  const loaded = await loadedPositions(client);
  // Item 114: `--name` is the field the publisher chooses and the web renders as the card title, and this listing —
  // the one place a publisher tells their own drafts apart — did not have it. MODEL goes when every row shares one.
  const oneModel = new Set(items.map((e) => e.anchor.model.id_M)).size <= 1;
  const filtered = !!(a.status || a.model || a.schema || a.branch || a.author || a.q);
  const empty = a.mine
    ? `you have not published anything on this node yet — \`${PROG} publish <file.npz> --name "<name>" --model <id_M> --benchmark <bench.json>\``
    : filtered ? 'no knowledge matches those filters'
      : `no knowledge on this node yet — publish one with \`${PROG} publish <file.npz> --name "<name>" --model <id_M> --benchmark <bench.json>\`, or add a peer that sells some (\`${PROG} peers add <node url>\`)`;
  emit(ctx, items, (rows) => table(rows, [
    { key: 'id', title: 'ID', get: (e) => c.id(e.anchor.id) },
    { key: 'name', title: 'NAME', get: (e) => e.anchor.name },
    { key: 'status', title: 'STATUS', get: (e) => statusColor(e.status) },
    // Item 216 — "what is loaded here, in what order" was answerable from no listing at all.
    { key: 'loaded', title: 'LOADED', get: (e) => (loaded.has(e.anchor.id) ? c.ok(`#${loaded.get(e.anchor.id)}`) : c.dim('-')), align: 'right' },
    { key: 'author', title: 'AUTHOR', get: (e) => (!e.anchor.author.startsWith('0x') ? e.anchor.author : e.anchor.author_name ? `${e.anchor.author_name} ${c.dim(shortAddr(e.anchor.author, 4))}` : shortAddr(e.anchor.author, 6)) },
    ...(oneModel ? [] : [{ key: 'model', title: 'MODEL', get: (e: CatalogEntry) => e.anchor.model.id_M }]),
    { key: 'rows', title: 'ROWS', get: (e) => e.anchor.rows.toLocaleString('en-US'), align: 'right' as const },
    { key: 'size', title: 'SIZE', get: (e) => fmtBytes(e.anchor.size_bytes), align: 'right' as const },
    { key: 'price', title: 'PRICE', get: (e) => `${e.anchor.price} ${e.anchor.currency}`, align: 'right' as const },
    // The numerator never exceeds the quorum (`3/2` is not a fraction anyone can read); extra independent
    // attestations are shown as `2/2+1`, and self-checks by the author are never in this count at all.
    { key: 'att', title: 'ATTEST', get: (e) => { const v = verificationCount(e); const s = v.extra ? `${v.fraction}+${v.extra}` : v.fraction; return e.quorum_ok ? c.ok(s) : c.warn(s); }, align: 'right' as const },
    { key: 'dl', title: 'SOLD', get: (e) => String(e.downloads), align: 'right' as const },
    { key: 'schema', title: 'BENCHMARK', get: (e) => e.anchor.benchmark.schema },
  ], empty) + (loaded.size ? '\n' + c.dim(`loaded in the serving model, in order: ${[...loaded.entries()].sort((x, y) => x[1] - y[1]).map(([id, n]) => `${n} ${id}`).join(' → ')} (${PROG} patch stack)`) : ''));
  return items;
}

/** `2/2 passed ✓ quorum` — clamped, with the extra evidence spelled out instead of an unreadable `3/2`. */
export function verificationLine(e: CatalogEntry): string {
  const v = verificationCount(e);
  const extra = v.extra ? c.dim(` (+${v.extra} more independent attestation${v.extra > 1 ? 's' : ''})`) : '';
  const self = e.self_checks ? c.warn(` · ${e.self_checks} self-check${e.self_checks > 1 ? 's' : ''} by the author (not counted)`) : '';
  return `${v.fraction} passed${e.quorum_ok ? c.ok(' ✓ quorum') : ''}${extra}${self}${executorLine(e)}`;
}

/**
 * How many distinct model servers are behind those attestations (item 329). Two verifier processes pointed at one
 * vLLM sign two attestations and are not two independent verifications; the record can now tell the difference, so
 * the line says which of the two it is instead of printing a fraction that means either.
 */
export function executorLine(e: CatalogEntry): string {
  const machines = (e.executors?.length ?? 0) + (e.executors_unknown ?? 0);
  if (e.passed < 2 || !machines) return '';
  if ((e.executors?.length ?? 0) && machines < e.passed) return c.warn(` · ${machines} model server${machines > 1 ? 's' : ''} for ${e.passed} attestations — not ${e.passed} independent runs`);
  if (e.executors_unknown) return c.dim(` · ${e.executors_unknown} attestation${e.executors_unknown > 1 ? 's' : ''} without an engine fingerprint`);
  return c.dim(` · ${machines} independent model server${machines > 1 ? 's' : ''}`);
}

/** `split` as `GET /api/patches/:id` returns it. */
export interface SaleSplitView {
  patch_id: string; amount: string; currency: string; share: number; verifier_share: number;
  lines: { address: string; amount: string; name: string | null; role: 'seller' | 'ancestor' | 'contributor' | 'verifier'; knowledge: string[] }[];
  parents: { id: string; name: string; price: string | null; currency: string; author: string | null; author_name: string | null; status: string | null }[];
  cheaper_than: { id: string; price: string; currency: string }[];
  unresolved: Record<string, string>;
}

/**
 * "Each sale of 3 CREDIT → 2.1 to you, 0.9 shared by the creators of krx-all-2761" (item 189), and the one thing a
 * publisher undercutting their own base is never told (item 318). Printed at publish, before the announce, because
 * afterwards the price is on the permanent record.
 */
export function splitLines(s: SaleSplitView): string[] {
  if (!s.parents.length && s.lines.length <= 1) return [];
  const money = (n: string) => `${n} ${s.currency}`;
  const who = (l: SaleSplitView['lines'][number]) => (l.role === 'seller' ? 'you'
    : `${l.name ?? shortAddr(l.address, 6)}${l.knowledge.length ? ` (${l.knowledge.join(', ')})` : ''}`);
  const out = [c.dim(`  each sale of ${money(s.amount)} → `) + s.lines.map((l) => `${c.id(money(l.amount))} ${c.dim(`to ${who(l)}`)}`).join(c.dim(' · '))];
  for (const p of s.parents) {
    out.push(c.dim(`  base ${p.id}${p.price !== null ? ` sells at ${p.price} ${p.currency}` : ' (price unknown here)'}${p.author_name ? ` from ${p.author_name}` : ''}${p.status ? ` · ${p.status}` : ''}`));
  }
  for (const u of s.cheaper_than) {
    out.push(c.warn(`  ! ${money(s.amount)} is below ${u.id}'s own price of ${u.price} ${u.currency} — buyers get its rows for less from you, and its creator's take drops from ${u.price} to a royalty slice.`));
  }
  const held = Object.keys(s.unresolved);
  if (held.length) out.push(c.warn(`  ! ${held.join(', ')}: no anchor here names an author, so their share is held, not paid — add the node that publishes ${held.length > 1 ? 'them' : 'it'} (${PROG} peers add <url>).`));
  return out;
}

/** A parent or child as `GET /api/patches/:id` returns it, with its price and (for the author) what it has paid. */
export interface LineageRef { id: string; name: string; author: string; status: string; price?: string; currency?: string; author_name?: string | null; sales?: number | null; earned?: string | null }

export interface PatchDetail extends CatalogEntry {
  lineage: { parents: LineageRef[]; children: LineageRef[]; earned?: { amount: string; currency: string; sales: number } };
  conflicts: { patch_id: string; overlap_rows: number; same_schema: boolean; status: string; cross_branch?: boolean; same_author?: boolean; author?: string; author_name?: string | null; created_at?: number; sales?: number; lineage?: 'parent' | 'child' | null }[];
  /** What one sale pays and to whom, by name (items 189, 318) — from the node's `royaltyPlan`. */
  split?: SaleSplitView;
  retired_at?: number | null;
  retire_reason?: string | null;
  branches: { name: string; context: Record<string, string> }[];
  /** The bases this knowledge needs underneath it, deepest first, with their prices (item 270). */
  requires?: { id: string; name: string; held: boolean; price: string | null; currency?: string; author?: string; author_name?: string | null; depth?: number; known?: boolean; purchased?: boolean; mine?: boolean }[];
  owned: boolean; purchased: boolean; has_body: boolean; applied: boolean; gateway_url: string | null;
  /** Why an announced knowledge has not been verified yet — null while it is still within its normal wait (item 154). */
  stalled?: {
    patch_id: string; since: number; waited_minutes: number; counted: number; quorum: number; hash_only: number;
    needs_benchmark: boolean; model: string;
    verifiers: { name: string | null; endpoint: string; address: string | null; model: string | null; attested: 'no' | 'hash-only' | 'executed' }[];
    reason: string;
  } | null;
}

/**
 * Holding a file is not owning the knowledge (items 173, 343).
 *
 * A verifier fetches every body it scores, so `body on this node: yes` was true on knowledge nobody had bought and
 * nobody was licensed to use, teach on, or subscribe with — and `patch buy` then charged for it and reported
 * "body already present", which reads as "nothing happened". The node has known the difference all along
 * (`licenseOf(e).source === 'verification'`); this is that fact, in the buyer's words.
 */
export function licenceLine(e: { owned: boolean; purchased: boolean; has_body: boolean }, tx?: string | null): string {
  if (e.owned) return c.ok('yours — you published it');
  if (e.purchased) return c.ok(`bought by this node${tx ? ` · tx ${shortHash(tx, 14)}` : ''}`);
  if (e.has_body) return c.warn('NOT bought — the file is here because this node verified it, and verifying is not a licence to use, teach on or subscribe with');
  return 'not bought';
}

/** Names for the addresses a settlement pays, so the ROYALTY column is not a column of hex (item 198). */
async function royaltyNames(client: NodeClient, d: PatchDetail): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const put = (addr?: string | null, name?: string | null) => { if (addr && name) names.set(addr.toLowerCase(), name); };
  put(d.anchor.author, d.anchor.author_name);
  for (const cn of d.anchor.contributors ?? []) put(cn.address, cn.name ?? null);
  for (const r of d.requires ?? []) put(r.author, r.author_name ?? null);
  const owed = new Set(d.settlements.flatMap((s) => Object.keys(s.royalty)).map((x) => x.toLowerCase()));
  if ([...owed].every((x) => names.has(x))) return names;
  // The tree endpoint resolves every recipient of the family's split, lineage and contributors alike.
  const tree = await client.get<TreeView>(`/api/patches/${encodeURIComponent(d.anchor.id)}/tree${query({ depth: 4 })}`).catch(() => null);
  for (const r of tree?.money.recipients ?? []) put(r.address, r.name);
  return names;
}

export async function patchGet(ctx: CliContext, id: string): Promise<PatchDetail> {
  const client = new NodeClient(ctx);
  const d = await client.get<PatchDetail>(`/api/patches/${encodeURIComponent(id)}`);
  // The receipt for a knowledge this node bought (operator-only; a visitor simply gets no tx hash).
  const tx = d.purchased && !d.owned
    ? (await client.get<{ items: { patch_id: string; tx_hash: string }[] }>('/api/me/purchases').catch(() => null))?.items.find((p) => p.patch_id === d.anchor.id)?.tx_hash ?? null
    : null;
  const names = d.settlements.length ? await royaltyNames(client, d) : new Map<string, string>();
  const who = (addr: string) => names.get(addr.toLowerCase()) ?? shortAddr(addr, 4);
  emit(ctx, d, (e) => {
    const a = e.anchor;
    const lines = [
      c.bold(a.name) + '  ' + statusColor(e.status) + (e.owned ? c.dim('  (yours)') : '') + (e.purchased ? c.ok('  purchased') : '') + (e.applied ? c.ok('  applied') : ''),
      kv([
        ['id', a.id], ['author', `${a.author_name ?? ''} ${a.author}`.trim()], ['model', `${a.model.id_M}${a.model.checkpoint_hash ? ` (${a.model.checkpoint_hash})` : ''}`],
        // Item 198 — a lesson's data provider was on the record and on the web page, and in no terminal output.
        ...(a.contributors?.length ? [['taught by', a.contributors.map((x) => `${x.name ?? shortAddr(x.address, 4)} (${Math.round(x.share * 100)}% of this node's share of each sale${x.proof === 'signed' ? ', signed' : ''})`).join(', ')] as [string, unknown]] : []),
        ['rows / size', `${a.rows.toLocaleString('en-US')} rows · ${fmtBytes(a.size_bytes)}`], ['sha256', a.patch_sha256],
        ['price', `${a.price} ${a.currency} · ${a.billing}`], ['benchmark', `${a.benchmark.schema} · ${a.benchmark.queries} queries · ${a.benchmark.format.join('/')}${a.benchmark.collateral_bound_nat ? ` · collateral ≤ ${a.benchmark.collateral_bound_nat} nat` : ''}`],
        ['benchmark hash', a.benchmark_hash], ['topic', a.topic_path], ['branch', a.branch ?? '-'], ['gateway', e.gateway_url ?? '-'],
        // Item 194: `revenue` is the price buyers paid, which on a derivative is up to three times what its author
        // received. Both numbers, and the one the author actually kept named as such.
        ['verification', verificationLine(e)], ['sold', `${e.downloads}${e.buyers && e.buyers !== e.downloads ? ` (${e.buyers} buyer${e.buyers === 1 ? '' : 's'})` : ''} · revenue ${e.revenue} ${a.currency} gross`
          + (Number(e.revenue_shared ?? 0) > 0 ? ` · ${e.revenue_net} to ${a.author_name ?? shortAddr(a.author, 6)}, ${e.revenue_shared} shared with the creators it was built on` : '')
          + (e.self_purchases ? c.warn(` · ${e.self_purchases} self-purchase${e.self_purchases === 1 ? '' : 's'} not counted`) : '')],
        ['created', fmtTime(a.created_at)],
        // Items 173 / 343: what this node may DO with it, before the line that says whether the file is here.
        ['licence', licenceLine(e, tx)], ['body on this node', e.has_body ? 'yes' : 'no'],
      ]),
      '', a.description ? a.description : c.dim('(no description)'),
    ];
    // Item 154: an anchor stuck at 0/2 used to say nothing at all on the author's own machine — the retry warnings
    // are events on the VERIFIERS' nodes. Print what this node knows, and who it asked.
    if (e.stalled) {
      lines.push('', c.warn(`not verified after ${e.stalled.waited_minutes} minutes — ${e.stalled.counted}/${e.stalled.quorum}`), `  ${e.stalled.reason}`);
      if (e.stalled.verifiers.length) {
        lines.push(...e.stalled.verifiers.map((v) => c.dim(`    ${v.name ?? v.endpoint} — serves ${v.model ?? 'no model'}; attested: ${v.attested}`)));
      }
    }
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
      // A FAIL used to be a fraction and nothing else. The verifier signs what the model actually answered on up to
      // five of the questions it got wrong (item 155) — print it under the row, because that is what a rejected
      // author has to work from.
      for (const x of e.attestations) {
        if (!x.failures?.length) continue;
        lines.push('', `${c.err('FAIL')} ${x.verifier_name ?? shortAddr(x.verifier, 6)} — what the model answered on ${x.failures.length} of the questions it got wrong:`);
        for (const f of x.failures) lines.push(`  ${c.dim('asked   ')} ${f.prompt}`, `  ${c.dim('expected')} ${c.ok(f.expect)}`, `  ${c.dim('answered')} ${c.err(f.got || '(nothing)')}`, '');
      }
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
      `  parents : ${e.lineage.parents.map((p) => `${p.id} ${c.dim(`(${p.status}${p.price !== undefined ? `, ${p.price} ${p.currency ?? e.anchor.currency}` : ''})`)}`).join(', ') || c.dim('none (root)')}`,
      // Items 195, 318: a child was an id and a status. Its PRICE — a child under the base's own price is the base
      // at a discount — and what it has actually paid the creator of the base are what an ancestor needs to see.
      `  children: ${e.lineage.children.map((p) => `${p.id} ${c.dim(`(${p.status}${p.price !== undefined ? `, ${p.price} ${p.currency ?? e.anchor.currency}` : ''}${p.author_name && p.author !== e.anchor.author ? `, ${p.author_name}` : ''})`)}${p.sales ? c.ok(` +${p.earned} from ${p.sales} sale${p.sales > 1 ? 's' : ''}`) : ''}`).join(', ') || c.dim('none')}`,
      e.lineage.earned ? `  earned from derivatives: ${e.lineage.earned.sales ? `${e.lineage.earned.amount} ${e.lineage.earned.currency} from ${e.lineage.earned.sales} sale(s) of knowledge built on this` : c.dim('nothing yet — it appears here as derivatives sell')}` : '',
      e.supersedes.length ? `  supersedes: ${e.supersedes.join(', ')}` : '', e.superseded_by.length ? c.warn(`  superseded by: ${e.superseded_by.join(', ')}`) : '');
    if (e.conflicts.length) {
      lines.push('', c.head('address-set overlaps (A₁ ∩ A₂)'), table(e.conflicts, [
        { key: 'p', title: 'PATCH', get: (x) => x.patch_id }, { key: 'o', title: 'SHARED ROWS', get: (x) => x.overlap_rows.toLocaleString('en-US'), align: 'right' },
        { key: 's', title: 'SAME SCHEMA', get: (x) => (x.lineage ? c.ok(`yes → its ${x.lineage === 'parent' ? 'base' : 'add-on'}, not a rival`) : x.same_schema ? c.warn('yes → conflicting knowledge') : 'no') }, { key: 'st', title: 'STATUS', get: (x) => statusColor(x.status) },
      ]));
    }
    if (e.branches.length) lines.push('', c.head('branches'), ...e.branches.map((b) => `  ${b.name} ${c.dim(JSON.stringify(b.context))}`));
    if (e.settlements.length) {
      lines.push('', c.head('settlements'), table(e.settlements.slice(-10), [
        { key: 'b', title: 'BUYER', get: (s) => shortAddr(s.buyer, 8) }, { key: 'a', title: 'AMOUNT', get: (s) => `${s.amount} ${s.currency}`, align: 'right' },
        { key: 'sch', title: 'SCHEME', get: (s) => s.scheme }, { key: 'tx', title: 'TX', get: (s) => shortHash(s.tx_hash, 14) },
        // Item 198 — `0x1111…1111:0.75` named nobody. The recipients are resolved from the record itself.
        { key: 'r', title: 'ROYALTY', get: (s) => Object.entries(s.royalty).map(([k, v]) => `${who(k)}:${v}`).join(' ') }, { key: 't', title: 'AT', get: (s) => fmtTime(s.created_at) },
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
  /** publish past `duplicate_body` (your own bytes, same subject) and `model_mismatch` — never past another author's bytes */
  force?: boolean;
  /** the listings this announce is allowed to retire — required when there are any (item 150) */
  supersede?: string[];
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

/** The node's own id rule (`market.createDraft`), mirrored so the CLI can say what will happen before it happens. */
export const slugForId = (name: string): string => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
/** …and the shape the node then demands of it. */
const NODE_SLUG = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/**
 * The id of a knowledge whose publisher did not choose one (item 158).
 *
 * The node derives it from the name by dropping everything outside `a-z 0-9 . _ -`, so every Korean, Japanese or
 * Chinese name collapsed to the empty string and the publisher was told `invalid patch id (use 2-64 chars …)` —
 * a rule about a flag they never passed, on the product's own flagship subject. A name with no usable ASCII gets a
 * derived, stable id here instead, and the command says so; `--id` still wins over everything.
 */
export function idFromName(name: string): { id: string; from: 'name' | 'hash' } {
  const slug = slugForId(name);
  if (NODE_SLUG.test(slug)) return { id: slug, from: 'name' };
  return { id: `patch-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`, from: 'hash' };
}

/** The benchmark, from a path or from inline JSON — with the three mistakes told apart (item 159). */
export function readBenchmarkArg(value: string): unknown {
  const raw = (value ?? '').trim();
  if (raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch (e) {
      throw new CliError(`--benchmark was read as inline JSON (it starts with "{") and could not be parsed: ${(e as Error).message}\n`
        + `  it must be an object like {"schema":"krx-ticker-codes","queries":2761,"format":["template"],"samples":[{"prompt":"…","expect":"…"}]}`);
    }
  }
  const p = resolve(raw);
  if (!existsSync(p)) throw new CliError(`benchmark file not found: ${p}\n  --benchmark takes a path to a JSON file, or inline JSON starting with "{"`);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    throw new CliError(`${p} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * A knowledge body is a numpy archive, which is a ZIP (item 159). Publishing something else used to reach the npz
 * reader on the node and come back as `npz: end of central directory not found` — a ZIP structure term, with no
 * filename, that gives no hint the file is simply the wrong kind.
 */
export function assertNpzBody(file: string): void {
  const head = Buffer.alloc(4);
  const fd = openSync(file, 'r');
  let n = 0;
  try { n = readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
  if (n === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return;
  throw new CliError(`${file} is not a valid .npz — a knowledge body is a numpy archive (a ZIP holding the addrs / before / after arrays), and this file does not start with one.\n`
    + `  ${statSync(file).size} bytes, first bytes ${[...head.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ') || '(empty file)'}.\n`
    + `  Export it again from the trainer, or pass the file the lesson produced (\`lesson-*.npz\`).`);
}

export async function patchPublish(ctx: CliContext, a: PublishArgs): Promise<{ anchor: PatchAnchor; announced: boolean }> {
  const file = resolve(a.file);
  if (!existsSync(file)) throw new CliError(`file not found: ${file}`);
  if (!file.endsWith('.npz')) throw new CliError('patch body must be a .npz (addrs/before/after arrays)');
  assertNpzBody(file);
  const benchmark = readBenchmarkArg(a.benchmark);
  const b = benchmark as { schema?: string; queries?: number; format?: string[] };
  if (!b.schema) throw new CliError('benchmark.schema is required (e.g. "krx-ticker-codes")');
  if (!b.queries) b.queries = 0;
  if (!b.format) b.format = ['template'];
  const contributors = parseContributors(a.contributor);
  const client = new NodeClient(ctx);
  const datasetFile = a.dataset ? resolve(a.dataset) : undefined;
  if (datasetFile && !existsSync(datasetFile)) throw new CliError(`training set not found: ${datasetFile}`);
  // Item 158 — an id derived from a name that has no ASCII at all.
  const derived = a.id ? { id: a.id, from: 'name' as const } : idFromName(a.name);
  if (derived.from === 'hash') {
    warn(ctx, `no id could be made from the name ${JSON.stringify(a.name)} — an id is a-z 0-9 . _ - and that name has none of them, so this draft is ${c.id(derived.id)}.`);
    info(ctx, c.dim(`  choose your own instead: ${PROG} patch rm ${derived.id} && ${PROG} publish ${a.file} --id <your-slug> --name ${JSON.stringify(a.name)} …`));
  }
  const r = await client.post<{ anchor: PatchAnchor }>('/api/patches', {
    id: derived.id, name: a.name, model_id: a.model, benchmark: JSON.stringify(b), price: a.price, description: a.description, parents: a.parents,
    branch: a.branch, topic_path: a.topic, license: a.license, billing: a.billing, path: file, visibility: a.test ? 'test' : undefined,
    contributors: contributors ? JSON.stringify(contributors) : undefined,
    // past `duplicate_body` / `model_mismatch` only — the node never lets --force publish another author's bytes
    ...(a.force ? { force: true } : {}),
    // the questions this knowledge was made from, published under the access level the operator chose (§6.1)
    ...(datasetFile ? { dataset_file: datasetFile, dataset_access: a.datasetAccess ?? 'derivative', dataset_license: a.datasetLicense } : {}),
  });
  ok(ctx, `draft created: ${c.id(r.anchor.id)}  (${r.anchor.rows.toLocaleString('en-US')} rows, sha256 ${shortHash(r.anchor.patch_sha256)})`);
  if (r.anchor.dataset) ok(ctx, c.dim(`training set on the record: ${r.anchor.dataset.rows} questions, ${r.anchor.dataset.access ?? 'private'}${r.anchor.dataset.license ? `, ${r.anchor.dataset.license}` : ''} (sha256 ${shortHash(r.anchor.dataset.sha256)})`));
  if (r.anchor.contributors?.length) ok(ctx, c.dim(`data providers on the record: ${r.anchor.contributors.map((x) => `${x.name ?? shortAddr(x.address, 4)} ${Math.round(x.share * 100)}%`).join(', ')} (of this node's share of each sale)`));
  // Items 189 + 318: the money split and the parents' prices, while the draft is still a draft and the price can change.
  if (!ctx.json && r.anchor.parents?.length) {
    const detail = await client.get<PatchDetail>(`/api/patches/${encodeURIComponent(r.anchor.id)}`).catch(() => null);
    const lines = detail?.split ? splitLines(detail.split) : [];
    if (lines.length) process.stderr.write(lines.join('\n') + '\n' + c.dim(`  the price goes on the permanent record at announce; until then \`${PROG} patch rm ${r.anchor.id}\` and publish again changes it.\n`));
  }
  let announced: AnnounceResult | null = null;
  if (a.announce) announced = await patchAnnounce(ctx, r.anchor.id, { supersede: a.supersede, document: false });
  else if (!ctx.json) ok(ctx, c.dim(`announce when ready: ${PROG} patch announce ${r.anchor.id}`));
  // Item 253: the morning script had `{anchor, announced}` and a 64-integer addr_sketch, and had to poll
  // `patch get --json` to learn whether the announce landed, what it retired and whether anyone can verify it.
  emit(ctx, publishDocument(r.anchor, announced), () => undefined);
  return { anchor: r.anchor, announced: !!announced };
}

/** `ainize --json publish` — the record hash, the derived status and what the announce retired, without the sketch. */
export function publishDocument(anchor: PatchAnchor, announced: AnnounceResult | null): Record<string, unknown> {
  const { addr_sketch: _sketch, ...rest } = anchor;   // 64 integers a script has no use for; the sha256 identifies the body
  return {
    anchor: rest,
    announced: !!announced,
    status: announced ? 'ANNOUNCED' : 'DRAFT',
    record_hash: announced?.record.hash ?? null,
    pending_supersedes: (announced?.retires ?? []).map((x) => ({ id: x.patch_id, status: x.status, sales: x.sales ?? 0, overlap_rows: x.overlap_rows ?? 0 })),
    verifiers_known: announced?.verifiers?.verifiers ?? null,
    quorum: announced?.verifiers?.quorum ?? null,
    visibility: announced?.visibility ?? anchor.visibility ?? 'public',
  };
}

/** What the node's `verifierReach()` reports back with an announce (item 147). */
export interface VerifierReach { known: number; reachable: number; verifiers: number; quorum: number; self_attest: boolean; endpoints: string[] }

/** Everything an announce establishes: the record it wrote, what it retired, and who can verify it (item 253). */
export interface AnnounceResult {
  patch_id: string;
  record: LedgerRecord;
  retires: PatchDetail['conflicts'];
  verifiers: VerifierReach | null;
  visibility: string;
}

/**
 * The overlaps an announce would RETIRE: same subject, same branch, still tradeable, and published by this same node
 * — the node's own rule (market.supersedable). A cross-author overlap is not in this list any more: it coexists.
 */
export function retiredByAnnounce(d: PatchDetail): PatchDetail['conflicts'] {
  return d.conflicts.filter((x) => x.same_schema && !x.cross_branch && x.same_author !== false && !x.lineage && ['LISTED', 'VERIFYING', 'ANNOUNCED'].includes(x.status));
}

/**
 * DRAFT → ANNOUNCED, with the two things the publisher was never told (items 147, 150):
 *  - what this announce retires, listed with each item's status and sales, and refused until every one of them is
 *    named with `--supersede` — the same friction the console demands before the same, permanent, irreversible write;
 *  - whether any reachable peer on this network actually verifies. Below the quorum nothing announced here can ever
 *    be LISTED, so the old unconditional "verifiers will now attest" was a promise the node could not keep.
 */
export async function patchAnnounce(ctx: CliContext, id: string, opts: { supersede?: string[]; document?: boolean } = {}): Promise<AnnounceResult> {
  const client = new NodeClient(ctx);
  const detail = await client.get<PatchDetail>(`/api/patches/${encodeURIComponent(id)}`).catch(() => null);
  let retired: PatchDetail['conflicts'] = [];
  if (detail) {
    const retires = retiredByAnnounce(detail);
    retired = retires;
    const named = new Set((opts.supersede ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean));
    const missing = retires.filter((x) => !named.has(x.patch_id));
    if (retires.length && !ctx.json) {
      process.stderr.write([
        c.warn('! ') + `announcing ${c.id(id)} retires ${retires.length} of your listing(s) on the same subject (${detail.anchor.benchmark.schema}) — permanently:`,
        table(retires, [
          { key: 'id', title: 'RETIRED BY THIS ANNOUNCE', get: (x) => c.id(x.patch_id) },
          { key: 'st', title: 'STATUS', get: (x) => statusColor(x.status) },
          { key: 'sales', title: 'SALES', get: (x) => String(x.sales ?? 0), align: 'right' },
          { key: 'ov', title: 'SHARED ENTRIES', get: (x) => (x.overlap_rows ?? 0).toLocaleString('en-US'), align: 'right' },
        ]),
        c.dim('  buyers of each one will see "Newer version available"; there is no undo.'),
      ].join('\n') + '\n');
    }
    if (missing.length) {
      throw new CliError(
        `${id} would retire ${missing.map((x) => x.patch_id).join(', ')} — name them to go ahead:\n`
        + `  ${PROG} patch announce ${id} ${missing.map((x) => `--supersede ${x.patch_id}`).join(' ')}\n`
        + c.dim(`  the draft is untouched; nothing was written to the ledger.`), 1, { retires: missing },
      );
    }
    const coexisting = detail.conflicts.filter((x) => x.same_schema && (x.cross_branch || x.same_author === false));
    if (coexisting.length && !ctx.json) info(ctx, c.dim(`  ${coexisting.length} other overlap(s) on the same subject stay as they are (another branch, or another node's knowledge — those are never retired by your publish).`));
  }
  const r = await client.post<{ record: LedgerRecord; verifiers?: VerifierReach; visibility?: string }>(`/api/patches/${encodeURIComponent(id)}/announce`);
  const v = r.verifiers;
  const enough = !v || v.verifiers >= v.quorum;
  ok(ctx, `announced ${c.id(id)} → ledger record ${shortHash(r.record.hash, 16)}${enough && v ? c.dim(` (${v.verifiers} verifier node(s) can attest; quorum is ${v.quorum})`) : ''}`);
  if (v && !enough) {
    warn(ctx, `this node knows ${v.verifiers} reachable verifier${v.verifiers === 1 ? '' : 's'} and the quorum is ${v.quorum}${v.known ? ` (${v.known} peer(s) known, ${v.reachable} answering)` : ''} — nothing announced here can be LISTED or sold until that changes.`);
    process.stderr.write([
      c.dim(`  join a network:   ${PROG} peers add <node url>`),
      c.dim(`  or verify alone:  ${PROG} config set verifier.quorum 1 && ${PROG} config set verifier.allowSelfAttest true`),
    ].join('\n') + '\n');
  }
  if (r.visibility === 'test') warn(ctx, `${id} was published as a TEST listing: it is hidden from every public catalogue, and only this node can see it.`);
  const out: AnnounceResult = { patch_id: id, record: r.record, retires: retired, verifiers: r.verifiers ?? null, visibility: r.visibility ?? 'public' };
  // `publish` writes the one document for the whole operation; a bare `patch announce` writes its own (item 253)
  if (opts.document !== false) emit(ctx, { ...out, record_hash: r.record.hash, status: 'ANNOUNCED' }, () => undefined);
  return out;
}

/**
 * `ainize patch retire <id>` — the exit (item 148). `patch forget` deletes this node's copy of the file and keeps
 * selling it; this writes an author-signed `retire` record: off the catalogue, 410 at the gateway, permanent.
 */
export async function patchRetire(ctx: CliContext, id: string, opts: { reason?: string } = {}): Promise<{ patch_id: string; retired_at: number; reason: string }> {
  const r = await new NodeClient(ctx).post<{ patch_id: string; retired_at: number; reason: string }>(`/api/patches/${encodeURIComponent(id)}/retire`, { reason: opts.reason ?? '' });
  emit(ctx, r, (x) => [
    c.ok('✓ ') + `retired ${c.id(x.patch_id)} — off sale from now on${x.reason ? c.dim(` ("${x.reason}")`) : ''}`,
    c.dim('  the anchor stays on the permanent record, and everyone who already bought it keeps their copy.'),
    c.dim(`  its gateway now answers 410 Gone; ${PROG} patch ls --status RETIRED still shows it to you.`),
  ].join('\n'));
  return r;
}

/**
 * A Python traceback from the model container, turned into one English line (item 160).
 *
 * `Runtime.verify` rethrows the applier's stderr verbatim, so a failed verification reached the operator as eight
 * lines of `scripts/patch.py` and `engram/live.py` internals ending in a Korean sentence — a stack trace from a file
 * they do not own, in a language the rest of the product does not use, with no statement of what failed or where to
 * look. The trace is not hidden (its last line is the container's own words, quoted as such); it is framed.
 */
export function runtimeFailure(err: unknown, nodeUrl: string, what: string): unknown {
  const e = err as CliError;
  const msg = String(e?.message ?? '');
  if (!/Traceback \(most recent call last\)|^apply failed:|patch hook reported failure/m.test(msg)) return err;
  const lines = msg.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? msg;
  const frames = [...msg.matchAll(/File "([^"]+)", line (\d+)/g)].map((m) => `${m[1]}:${m[2]}`);
  return new CliError([
    `cannot load ${what} into the model served by ${nodeUrl} — the patch hook in the model container refused the write.`,
    `  the container said: ${last}`,
    ...(frames.length ? [c.dim(`  it stopped in ${frames[frames.length - 1]}; the whole trace is in the node's own log (${PROG} logs --limit 50)`)] : [c.dim(`  the whole trace is in the node's own log (${PROG} logs --limit 50)`)]),
    c.dim(`  nothing was attested and nothing about the knowledge changed; this node's verifier loop tries again on its own (${PROG} logs --kind verifier).`),
  ].join('\n'), e?.exitCode ?? 1, e?.details);
}

export async function patchVerify(ctx: CliContext, id: string, opts: { recheck?: boolean } = {}): Promise<unknown> {
  const r = await new NodeClient(ctx).post<{ attestation: { passed: boolean; score: Record<string, unknown>; verified_on: string; samples_run?: number; samples_available?: number; duration_ms?: number } }>(
    `/api/patches/${encodeURIComponent(id)}/verify`, opts.recheck ? { recheck: true } : {}, { timeoutMs: 30 * 60_000 })
    .catch((err) => { throw runtimeFailure(err, ctx.nodeUrl, id); });
  emit(ctx, r, (x) => {
    const a = x.attestation;
    // Item 340 — what the run cost, so a 4/4 and a 40/40 on a 2,761-fact knowledge stop reading the same.
    const work = a.samples_run !== undefined
      ? c.dim(`  ${a.samples_run} of ${a.samples_available ?? a.samples_run} question(s)${a.duration_ms !== undefined ? ` in ${Math.round(a.duration_ms / 1000)}s` : ''}`)
      : '';
    return `${a.passed ? c.ok('PASS') : c.err('FAIL')} ${id} on ${a.verified_on}${opts.recheck ? c.dim(' (recheck)') : ''}  ${c.dim(JSON.stringify(a.score))}${work}`;
  });
  return r;
}

/**
 * `ainize patch challenge <id> --reason …`. A challenge is free to file and expensive for everyone else: it stops
 * every sale of the knowledge and spends another operator's GPU minutes on the re-run (item 328). The command says
 * that before it sends, and afterwards it reports what actually happens next — which, for a knowledge that was never
 * LISTED, is not "off sale" but "the verifiers are asked to run it again" (item 242).
 */
export async function patchChallenge(ctx: CliContext, id: string, reason: string): Promise<void> {
  const client = new NodeClient(ctx);
  const before = await client.get<PatchDetail>(`/api/patches/${encodeURIComponent(id)}`).catch(() => null);
  if (before && !ctx.json) {
    const sellable = before.sellable;
    ok(ctx, c.dim(`${id} is ${before.status}${sellable ? ` and on sale at ${before.anchor.price} ${before.anchor.currency}` : ''}. A challenge is not a comment: ${sellable ? 'it stops every sale of this knowledge' : 'it asks the verifiers to run the benchmark again'}, and some other operator pays the GPU minutes for the re-run. Your address is on the record next to your reason.`));
  }
  const r = await client.post<{ challenge?: { created_at: number }; record?: { filed: number; upheld: number; dismissed: number; open: number } }>(
    `/api/patches/${encodeURIComponent(id)}/challenge`, { reason });
  ok(ctx, `challenge recorded for ${id}: ${reason}`);
  const after = await client.get<PatchDetail>(`/api/patches/${encodeURIComponent(id)}`).catch(() => null);
  const status = after?.status ?? before?.status;
  if (status === 'CHALLENGED') ok(ctx, c.dim(`${id} is off sale until a verifier re-runs the benchmark and passes it; the author is told who challenged it and why`));
  else ok(ctx, c.dim(`${id} is ${status ?? 'not listed'} (${after ? verificationCount(after).fraction : '?'} passed) — it was not on sale, so nothing stops; the verifiers that have not answered your challenge will run the benchmark again`));
  if (r.record) ok(ctx, c.dim(`your challenges on this network: ${r.record.filed} filed · ${r.record.upheld} upheld · ${r.record.dismissed} dismissed by a re-run · ${r.record.open} waiting`));
}

export interface PurchaseResult {
  patch_id: string; steps: { step: string; detail: string; at: number }[]; manifest: { patch_sha256: string; size_bytes: number; rows: number };
  path: string; tx_hash: string; amount: string; scheme: string;
  /** every knowledge this call paid for, bases first (item 270) */
  purchases?: { patch_id: string; amount: string; currency: string; scheme: string; tx_hash: string; free?: boolean }[];
  total?: string; currency?: string;
  /** the payment was already settled and the seller re-issued the manifest — nothing was charged (item 273) */
  redeemed?: boolean;
}

/** `GET /api/patches/:id/quote` — what this purchase costs before anyone pays for it (item 270). */
export interface PatchQuote {
  patch_id: string; price: string; currency: string;
  requires: { id: string; name: string; price: string; currency: string; author: string; author_name?: string | null; depth: number; known: boolean; held: boolean; licensed: boolean; purchased: boolean; mine: boolean }[];
  missing: string[]; unknown: string[]; total: string; self_contained: boolean;
  export: 'delta' | 'squash' | null; derivation: string | null;
}

/** `GET /api/credit/:address` — where local credit comes from and what it is worth (item 364). */
export interface CreditInfo {
  address: string; currency: string; balance: number;
  grant: { amount: string; reason: string; granted_at: number } | null;
  would_grant: string | null;
  issued_by: { address: string; name: string | null; url: string };
  issuance: { cap: number; addresses: number; amount: number; per_address: string; currency: string; issues: boolean };
  note: string;
}

export interface BuyArgs {
  apply?: boolean;
  /** buy the bases this knowledge needs underneath it too, deepest first */
  withRequired?: boolean;
  /** answer the confirmation in advance */
  yes?: boolean;
  /** refuse if the TOTAL (this knowledge plus the bases it needs) is above this */
  maxPrice?: number;
  /** pay a second time for something this node has already bought (item 271) — off, so a retry never charges twice */
  again?: boolean;
  /** one step of `use a b` / `buy a b`: the terminal still gets its lines, the JSON document is the batch's (item 219) */
  batched?: boolean;
}

/**
 * The quote, printed before anything is spent (item 102). Every number here comes from the node: the price on the
 * record, the bases this knowledge needs underneath it and what they cost (item 270), the balance the money leaves
 * from, and — on a local-credit node — the fact that the credit was issued by that node and is not money (item 364).
 */
async function printQuote(ctx: CliContext, client: NodeClient, detail: PatchDetail, quote: PatchQuote): Promise<{ total: number; balance: number | null }> {
  const a = detail.anchor;
  const chain = await client.get<{ kind: string; address: string; balance: number | null }>('/api/chain').catch(() => null);
  const credit = quote.currency === 'CREDIT' ? await client.get<CreditInfo>('/api/me/credit').catch(() => null) : null;
  const total = Number(quote.total);
  const balance = chain?.balance ?? null;
  const lines: string[] = [];
  lines.push(`${c.id(a.id)}${a.name && a.name !== a.id ? ` · ${a.name}` : ''}  ${c.bold(`${quote.price} ${quote.currency}`)}`);
  lines.push(c.dim(`  seller ${a.author_name ? `${a.author_name} ` : ''}${shortAddr(a.author, 8)} · ${a.rows.toLocaleString('en-US')} rows · ${a.model.id_M}`));
  for (const r of quote.requires) {
    const state = r.mine ? 'published here' : r.licensed ? 'already paid for on this node' : r.known ? `${r.price} ${r.currency}${r.author_name ? ` from ${r.author_name}` : ''}${r.held ? ' (body already here, not paid for)' : ''}` : 'price unknown — this node has never seen it';
    lines.push(`  ${c.dim('needs')} ${c.id(r.id)}${r.name && r.name !== r.id ? ` · ${r.name}` : ''}  ${r.licensed || r.mine ? c.dim(state) : c.warn(state)}`);
  }
  if (quote.requires.length && !quote.missing.length) lines.push(c.dim('  everything it needs underneath is already here'));
  if (quote.missing.length) lines.push(`  ${c.head('total')} ${c.bold(`${quote.total} ${quote.currency}`)} ${c.dim(`(this knowledge + ${quote.missing.length} base${quote.missing.length === 1 ? '' : 's'} it cannot work without)`)}`);
  if (balance !== null) lines.push(c.dim(`  balance ${balance} → ${Math.round((balance - total) * 1e6) / 1e6} ${quote.currency}`));
  if (credit?.issuance.issues) lines.push(c.dim(`  ${credit.note}`));
  info(ctx, lines.join('\n'));
  return { total, balance };
}

/**
 * `ainize patch buy <id>` — the quote, the decision, then the money (item 102).
 *
 * It used to print `✓ bought <id> for 25 (local-credit)` as its FIRST line: the price was never quoted, no
 * confirmation existed anywhere in this CLI, and on an AIN node the first keystroke moved real money. Now the
 * quote is printed, `--max-price` is checked against the family total (not just this item), a terminal is asked,
 * and a non-terminal without `--yes` is refused instead of taken as a yes.
 */
export async function patchBuy(ctx: CliContext, id: string, opts: BuyArgs | boolean = {}): Promise<PurchaseResult> {
  const o: BuyArgs = typeof opts === 'boolean' ? { apply: opts } : opts;
  const client = new NodeClient(ctx);
  const detail = await client.get<PatchDetail>(`/api/patches/${encodeURIComponent(id)}`);
  const quote = await client.get<PatchQuote>(`/api/patches/${encodeURIComponent(id)}/quote`);
  // Item 271: this node has already paid for it. Collect on that receipt instead of running the 402 loop again —
  // no quote, no confirmation, no charge. `--again` is the deliberate second purchase.
  if (detail.purchased && !o.again) {
    info(ctx, c.dim(`${id} was already paid for by this node — collecting the body on that receipt (nothing will be charged; \`--again\` buys a second time on purpose)`));
    const done = await client.post<PurchaseResult>(`/api/patches/${encodeURIComponent(id)}/buy`, { apply: !!o.apply }, { timeoutMs: 30 * 60_000 });
    emitStep(ctx, !!o.batched, done, (x) => [
      c.ok('✓ ') + `collected ${c.id(x.patch_id)} — nothing was charged (paid ${x.amount}${x.currency ? ` ${x.currency}` : ''} already, tx ${shortHash(x.tx_hash, 16)})`,
      ...x.steps.map((st) => `  ${c.head(st.step.padEnd(11))} ${st.detail}`),
      c.dim(`  body: ${x.path}`),
    ].join('\n'));
    return done;
  }
  /*
   * Items 173 / 343 — the file is already here because this node VERIFIED it, and the purchase is about the licence,
   * not the bytes. Said before the money moves (the node's own timeline then prints "body already present", which on
   * its own reads as "nothing happened"), and said again afterwards, naming what the payment actually bought.
   */
  const heldUnlicensed = detail.has_body && !detail.purchased && !detail.owned;
  if (heldUnlicensed) {
    info(ctx, c.warn('! ') + `this node already holds the file for ${c.id(id)} — it fetched it to verify it, which is not a licence to use, teach on or subscribe with.`);
    info(ctx, c.dim(`  buying records the licence on the ledger and pays ${detail.anchor.author_name ?? shortAddr(detail.anchor.author, 8)} ${quote.price} ${quote.currency}; nothing is downloaded twice.`));
  }
  const { balance } = await printQuote(ctx, client, detail, quote);
  /**
   * The bases it cannot work without (design §13). The quote's `total` is the FAMILY price, and this command used to
   * ask "Pay {total} for 2 knowledges?" and then pay for one — the bases were bought only with `--bundle`, and the
   * prompt never mentioned the flag. So the family is offered here, in the terminal, and whatever is decided is what
   * the confirmation then quotes: no answer buys a file that answers nothing until its base is under it, and no
   * answer pays for a base nobody asked for.
   */
  const named = quote.requires.filter((r) => quote.missing.includes(r.id));
  let bundle = !!o.withRequired;
  if (named.length && !bundle) {
    const list = named.map((r) => `${r.name || r.id} (${r.known ? `${r.price} ${r.currency}` : 'price unknown'})`).join(', ');
    bundle = await ask(ctx, `${c.id(id)} also needs ${list}; buy ${named.length === 1 ? 'both' : `all ${named.length + 1}`}? [y/N]`, { skip: !!o.yes });
    if (!bundle) info(ctx, c.warn(`  buying ${id} alone — it will not answer anything until ${named.map((r) => r.id).join(' and ')} ${named.length === 1 ? 'is' : 'are'} loaded under it (\`${PROG} patch buy ${id} --bundle\` buys the family)`));
  }
  const pay = bundle ? Number(quote.total) : Number(quote.price);
  if (o.maxPrice !== undefined && pay > o.maxPrice) {
    throw new CliError(`${id} costs ${bundle ? quote.total : quote.price} ${quote.currency}${bundle && quote.missing.length ? ` with the ${quote.missing.length} base(s) it needs` : ''} — over --max-price ${o.maxPrice}. Nothing was bought.`);
  }
  if (balance !== null && balance < pay) {
    throw new CliError(`this node holds ${balance} ${quote.currency} and the purchase costs ${bundle ? quote.total : quote.price} — nothing was bought`);
  }
  /*
   * Item 277 — a free knowledge is not bought. Nothing is charged, no identity is needed and no sale is recorded,
   * so asking "Pay 0 CREDIT?" was both untrue and the last thing between a visitor and the cheapest way in.
   * Item 351 — and when money DOES move, the record naming this node as the buyer is public on every peer. That
   * was learned afterwards, from the ledger page; it is said here, before the answer.
   */
  const freeNow = pay === 0;
  if (freeNow) info(ctx, c.dim(`  free — nothing will be charged, and no public record will name this node as a buyer`));
  else info(ctx, c.dim(`  the sale is recorded publicly: ${id}, ${bundle ? quote.total : quote.price} ${quote.currency} and this node's address, on every peer's ledger`));
  await confirm(ctx, heldUnlicensed
    ? `Pay ${quote.price} ${quote.currency} to license ${id} (the file is already here)? [y/N]`
    : freeNow
      ? `Download ${id} for free${bundle && named.length ? ` with ${named.length} base${named.length === 1 ? '' : 's'}` : ''}? [Y/n]`
      : `Pay ${bundle ? quote.total : quote.price} ${quote.currency}${bundle && named.length ? ` for ${named.length + 1} knowledges` : ''}? [y/N]`, { yes: o.yes || freeNow });
  const seller = detail.anchor.author_name ?? shortAddr(detail.anchor.author, 8);
  const r = await client.post<PurchaseResult>(`/api/patches/${encodeURIComponent(id)}/buy`,
    { apply: !!o.apply, bundle, max_total: o.maxPrice, again: !!o.again }, { timeoutMs: 30 * 60_000 })
    .catch((err) => { throw refusalError(err, { seller, id, price: bundle ? quote.total : quote.price, currency: quote.currency, balance }); });
  emit(ctx, r, (x) => {
    const t0 = x.steps[0]?.at ?? Date.now();
    const cur = x.currency ?? quote.currency;
    const head = x.redeemed
      ? c.ok('✓ ') + `collected ${c.id(x.patch_id)} against the payment already made — nothing was charged  tx ${shortHash(x.tx_hash, 16)}`
      : Number(x.total ?? x.amount) === 0
        // Item 277: "bought ux4-free for 0 (local-credit)" described a ceremony that no longer happens.
        ? c.ok('✓ ') + `downloaded ${c.id(x.patch_id)} — free, nothing was charged and no sale was recorded`
        : c.ok('✓ ') + `bought ${c.id(x.patch_id)} for ${x.total ?? x.amount} ${cur} (${x.scheme})  tx ${shortHash(x.tx_hash, 16)}`;
    const bought = (x.purchases ?? []).filter((pp) => pp.patch_id !== x.patch_id);
    return [
      head,
      ...bought.map((pp) => c.dim(`  with its base ${pp.patch_id}: ${pp.amount} ${pp.currency}  tx ${shortHash(pp.tx_hash, 12)}`)),
      ...x.steps.map((s) => `  ${c.dim(`+${String(s.at - t0).padStart(5)}ms`)}  ${c.head(s.step.padEnd(9))} ${s.detail}`),
      // Item 343: the node's own timeline says "body already present"; what the money bought is said here.
      ...(heldUnlicensed ? [c.dim(`  the file was already on this node (fetched to verify it) — what ${x.total ?? x.amount} ${cur} bought is the licence: settlement ${shortHash(x.tx_hash, 16)}, and ${id} may now be used, taught on and subscribed with here`)] : []),
      c.dim(`  body: ${x.path}`),
    ].join('\n');
  });
  return r;
}

/**
 * A seller's refusal, as a sentence (item 293).
 *
 * `market.buy` throws `payment rejected: 402 {"error":"insufficient credit: 2 < 5"}` and every surface printed it
 * verbatim: at the moment a purchase fails, the buyer was shown a status code and a JSON blob. The seller's reasons
 * are readable sentences on the other side; this unwraps them and names the seller, the balance and the price.
 */
export function refusalError(err: unknown, ctxInfo: { seller: string; id: string; price: string; currency: string; balance: number | null }): unknown {
  const e = err as CliError;
  const msg = String(e?.message ?? '');
  const m = /^payment rejected: (\d{3}) ([\s\S]*)$/.exec(msg);
  if (!m) return err;
  let detail = m[2].trim();
  try { const j = JSON.parse(detail) as { error?: string; message?: string }; detail = String(j.error ?? j.message ?? detail); } catch { /* the seller answered prose */ }
  const credit = /insufficient credit:\s*([\d.]+)\s*<\s*([\d.]+)/.exec(detail);
  const line = credit
    ? `${ctxInfo.seller} refused the payment: this node has ${credit[1]} ${ctxInfo.currency} and ${ctxInfo.id} costs ${credit[2]}.`
    : /transfer (not found|not executed)|no such transfer/i.test(detail)
      ? `${ctxInfo.seller} could not confirm the payment on the chain (${detail}) — nothing was delivered; the transfer, if it went through, is on your wallet.`
      : /does not sell|not for sale|unknown patch/i.test(detail)
        ? `${ctxInfo.seller} does not sell ${ctxInfo.id} (${detail}) — \`${PROG} patch get ${ctxInfo.id}\` shows where it is sold today.`
        : `${ctxInfo.seller} refused the payment (HTTP ${m[1]}): ${detail}`;
  const next = credit && ctxInfo.balance !== null
    ? `\n  this node's balance is ${ctxInfo.balance} ${ctxInfo.currency}; ${PROG} wallet shows where it comes from.`
    : '';
  return new CliError(line + next, e?.exitCode ?? 1, e?.details);
}

/**
 * `ainize patch download <id>` — collect a knowledge this node has ALREADY paid for, without paying again (item 273).
 *
 * The recovery path existed in the node and was invisible: a buyer whose manifest was lost, or whose purchase died
 * between the transfer and the download (item 274), was told "payment already used" and offered "Buy again".
 */
export async function patchDownload(ctx: CliContext, id: string): Promise<PurchaseResult> {
  const r = await new NodeClient(ctx).post<PurchaseResult>(`/api/patches/${encodeURIComponent(id)}/collect`, {}, { timeoutMs: 30 * 60_000 });
  emit(ctx, r, (x) => {
    const t0 = x.steps[0]?.at ?? Date.now();
    return [
      c.ok('✓ ') + `collected ${c.id(x.patch_id)} — no payment (paid ${x.amount}${x.currency ? ` ${x.currency}` : ''}, tx ${shortHash(x.tx_hash, 16)})`,
      ...x.steps.map((s) => `  ${c.dim(`+${String(s.at - t0).padStart(5)}ms`)}  ${c.head(s.step.padEnd(11))} ${s.detail}`),
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

/** A queued apply/remove on the node (`GET /api/runtime/jobs/:id`). */
export interface RuntimeJob {
  id: string; kind: 'apply' | 'remove'; patch_id: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  queued_at: number; started_at: number | null; finished_at: number | null;
  result: string | null; error: string | null; status?: number;
  queue?: { running: { label: string; since: number } | null; waiting: number; lock: { label: string; owner: string; since: number; mine: boolean } | null };
}

/**
 * Apply/remove as a JOB (item 212). The shared model lock has no upper bound — another node's live test or a
 * verification can hold it for minutes — and the synchronous POST used to die on the HTTP client's own header
 * timeout: `cannot reach node … (fetch failed)`, exit 2, five minutes before the node ran the operation anyway.
 * The node answers 202 with a job now; this prints where it is in the queue and waits for the real answer.
 */
async function runRuntimeJob(ctx: CliContext, kind: 'apply' | 'remove', id: string, body: Record<string, unknown>, batched = false): Promise<string> {
  const client = new NodeClient(ctx);
  const path = `/api/patches/${encodeURIComponent(id)}/${kind === 'apply' ? 'apply' : 'remove'}`;
  const first = await client.post<{ job?: RuntimeJob; result?: string; stack?: StackLayer[] }>(path, { ...body, async: true }, { timeoutMs: 120_000 });
  /**
   * Item 220 — under `--json` these verbs printed nothing at all on success: a script that loaded a set got zero
   * bytes and exit 0 from every step, and had to read `/api/runtime` afterwards to guess what each one did. The
   * stack is what the caller actually wants ("what is loaded now, in what order"), so it is fetched once, for the
   * document only, and never for a terminal that has just been told the same thing in a sentence.
   */
  const done = async (result: string): Promise<string> => {
    const stack = ctx.json && !batched ? await client.get<{ stack: StackLayer[] }>('/api/runtime/stack').then((x) => x.stack).catch(() => null) : null;
    emitStep(ctx, batched, { patch_id: id, kind, result, applied: stack }, () => c.ok('✓ ') + `${kind === 'apply' ? 'applied' : 'removed'} ${id}: ${result}`);
    return result;
  };
  // A node from before jobs existed answers synchronously; keep working with it.
  if (!first.job) return done(String(first.result ?? ''));
  let job = first.job;
  let said = false;
  for (;;) {
    if (job.state === 'done') return done(job.result ?? '');
    // A refusal from the model container arrives here as its own Python trace too (item 160).
    if (job.state === 'failed') throw runtimeFailure(new CliError(job.error ?? `${kind} failed`, job.status === 409 ? 5 : 1), ctx.nodeUrl, id);
    if (!said && job.state === 'queued') {
      const holder = job.queue?.running ?? (job.queue?.lock ? { label: job.queue.lock.label, since: job.queue.lock.since } : null);
      info(ctx, c.dim(holder
        ? `queued behind ${holder.label} (started ${fmtTime(holder.since)}) — Ctrl-C leaves it queued on the node; \`${PROG} patch stack\` shows the result`
        : `queued on the node — Ctrl-C leaves it queued; \`${PROG} patch stack\` shows the result`));
      said = true;
    }
    await new Promise((r) => setTimeout(r, 1500));
    job = (await client.get<{ job: RuntimeJob }>(`/api/runtime/jobs/${job.id}`, { timeoutMs: 30_000 })).job;
  }
}

export async function patchApply(ctx: CliContext, id: string, opts: { withBase?: boolean; batched?: boolean } = {}): Promise<string> {
  return runRuntimeJob(ctx, 'apply', id, { with_base: !!opts.withBase }, !!opts.batched);
}

export async function patchRemove(ctx: CliContext, id: string, opts: { cascade?: boolean; batched?: boolean } = {}): Promise<string> {
  return runRuntimeJob(ctx, 'remove', id, { cascade: !!opts.cascade }, !!opts.batched);
}

/**
 * `ainize use a b`, `patch apply a b`, `patch buy a,b` — a set, in the order given (item 219).
 *
 * The product's stated purpose is combining several knowledges, and `use a,b` answered `patch not found` while
 * `patch apply a b` answered `Unknown argument: b`: the set had to be assembled one command at a time, with no
 * stated order. The order typed IS the load order, and the last one wins on any memory entry two of them share —
 * so the run ends by saying which order that was. Under `--json` the batch writes one document, not one per step.
 */
export async function overIds<T>(ctx: CliContext, ids: string[], verb: 'loaded' | 'unloaded' | 'bought' | null, one: (id: string, batched: boolean) => Promise<T>): Promise<T[]> {
  const many = ids.length > 1;
  const out: T[] = [];
  for (const id of ids) out.push(await one(id, many));
  if (!many) return out;
  if (verb && !ctx.json) info(ctx, c.dim(verb === 'loaded'
    ? `loaded in order: ${ids.join(' → ')}  (the last one wins on any memory entry they share)`
    : `${verb}: ${ids.join(', ')}`));
  emit(ctx, { ids, items: out }, () => undefined);
  return out;
}

/**
 * `a,b`, `a b` and repeated flags all mean the same set, in the order typed (item 219). `chat` had this and
 * nothing else did, so the comma form was sent to the node verbatim as one id and came back "patch not found".
 */
export function parseIds(input: string | string[] | undefined): string[] {
  const raw = Array.isArray(input) ? input : input === undefined ? [] : [input];
  const ids = [...new Set(raw.flatMap((x) => String(x).split(/[,\s]+/)).map((x) => x.trim()).filter(Boolean))];
  if (!ids.length) throw new CliError(`knowledge id required — \`${PROG} patch ls\` lists what this node knows about`);
  return ids;
}

/** Why a layer is on the table, in the operator's words (`applied.reason`). */
function layerReason(reason: string): string {
  if (reason === 'manual') return 'loaded by hand';
  if (reason.startsWith('subscription:')) return `loaded by the track ${reason.slice('subscription:'.length)}`;
  if (reason.startsWith('chat:')) return 'loaded for a live test';
  return `loaded: ${reason}`;
}

/**
 * `ainize patch stack` — what is loaded in the serving model, bottom first, and what each layer sits on.
 *
 * Item 216: the position, why the layer is there and when it was loaded were all in the answer and none of them on
 * screen, and the rows two neighbouring layers share — the thing that decides which of them the model actually
 * answers from — were nowhere at all. Positions are 1-based here and in `patch ls`'s LOADED column, so the two
 * listings cannot disagree about where a knowledge sits.
 */
export async function patchStack(ctx: CliContext): Promise<StackLayer[]> {
  const client = new NodeClient(ctx);
  const r = await client.get<{ stack: StackLayer[]; journal_dir: string | null }>('/api/runtime/stack');
  // What each layer shares with the one directly under it (the pair that decides an answer).
  const shared = new Map<string, number>();
  for (const [i, l] of r.stack.entries()) {
    if (i === 0) continue;
    const below = r.stack[i - 1].patch_id;
    const conf = await client.get<{ conflicts: { patch_id: string; overlap_rows: number }[] }>(`/api/patches/${encodeURIComponent(l.patch_id)}/conflicts`).catch(() => null);
    const hit = conf?.conflicts.find((x) => x.patch_id === below);
    if (hit?.overlap_rows) shared.set(l.patch_id, hit.overlap_rows);
  }
  emit(ctx, r.stack, () => {
    if (!r.stack.length) return c.dim('nothing is loaded in the serving model');
    return [
      ...r.stack.map((l, i) => [
        `${`#${i + 1}`.padStart(3)}  ${l.patch_id}${l.name ? c.dim(` — ${l.name}`) : ''}`,
        c.dim(`     ${l.rows !== null ? `${l.rows.toLocaleString()} rows · ` : ''}${layerReason(l.reason)} · ${fmtTime(l.applied_at)}`),
        c.dim(`     ${l.export === 'delta' ? `add-on, needs ${l.base_stack.join(', ')} underneath` : l.export === 'squash' ? 'stand-alone build' : 'published before add-ons existed'}`),
        shared.has(l.patch_id) ? c.warn(`     shares ${shared.get(l.patch_id)!.toLocaleString('en-US')} entries with ${r.stack[i - 1].patch_id} below it — this one answers on them`) : '',
        c.dim(`     ${l.journal ? 'can be unloaded without disturbing what is under it' : 'no journal — unloading it writes the model\'s own rows back'}${l.body_present ? '' : ' · body no longer on this node'}`),
      ].filter(Boolean).join('\n')),
      c.dim(`\nthe last line is on top: it wins on any row two of them share`),
    ].join('\n');
  });
  return r.stack;
}

// ------------------------------------------------------------------ family tree, open questions, signals (design §13)
/** One knowledge in the tree, as the node reports it (`GET /api/patches/:id/tree`). */
export interface TreeNodeView {
  id: string; name: string; missing?: boolean; author_name?: string | null; taught_by?: string | null; status?: string;
  added: { questions: number; changed: number; removed: number; rows: number; new: number };
  signals: Record<string, number>; depth: number; legacy?: boolean; export?: 'delta' | 'squash' | null;
}
export interface TreeView {
  root: string; depth: number; truncated: boolean;
  nodes: TreeNodeView[]; edges: { from: string; to: string; kind: string }[];
  family: { sales: number; knowledges: number; authors: number };
  money: { seller_pct: number; lineage_pct: number; contributor_pct: number; seller_name: string | null; lineage_names: string[]; recipients: { address: string; pct: number; name: string | null; kind: 'lineage' | 'contributor' }[] };
}

/**
 * `ainize patch tree <id>` — the family tree as text: ancestors above, this knowledge, then what was built on it,
 * each line saying what that knowledge ADDED. The relation is the child's own claim ("built on" / "newer version" /
 * "correction" / "combined"), and `declared` prints as the honest "declared parent — not trained on top" (§14).
 */
export async function patchTree(ctx: CliContext, id: string, opts: { depth?: number; dir?: 'up' | 'down' | 'both' } = {}): Promise<TreeView> {
  const r = await new NodeClient(ctx).get<TreeView>(`/api/patches/${encodeURIComponent(id)}/tree${query({ depth: opts.depth, dir: opts.dir })}`);
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  // The same edge reads differently from each end: looking UP at a base, `version` means "this replaces it"; looking
  // DOWN at a derivative it means "a newer version of this". One map per direction, so no line is true backwards.
  const relDown: Record<string, string> = { extend: 'built on it', update: 'newer version', contradict: 'correction', merge: 'combined from', version: 'newer version', track: 'different context', declared: 'declared parent — not trained on top' };
  const relUp: Record<string, string> = { extend: 'this was built on it', update: 'this replaces it', contradict: 'this corrects it', merge: 'combined from it', version: 'this replaces it', track: 'a different context of it', declared: 'declared parent — not trained on top' };
  const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;
  const label = (n: TreeNodeView) => {
    if (n.missing) return `${c.dim(n.id)} ${c.dim('(not on this node)')}`;
    const added = `+${n.added.questions} questions · ${n.added.changed} changed · ${n.added.rows.toLocaleString('en-US')} rows (${n.added.new.toLocaleString('en-US')} new)`;
    const sig = `${plural(n.signals.sales_all ?? 0, 'sale')} · loaded on ${plural(n.signals.loads ?? 0, 'node')} · built on ${n.signals.built_on ?? 0}×`;
    return `${c.id(n.id)}${n.name && n.name !== n.id ? ` — ${n.name}` : ''}\n      ${c.dim(added)}\n      ${c.dim(sig)}`;
  };
  emit(ctx, r, () => {
    const lines: string[] = [];
    const children = (from: string) => r.edges.filter((e) => e.from === from);
    // One line per KNOWLEDGE above the root, not per edge: ep12 is both a declared parent of krx-all and a version
    // of it, and printing it twice made the demo node's tree read as two different knowledges with the same name.
    const above = new Map<string, string[]>();
    for (const e of r.edges.filter((x) => x.to === r.root)) above.set(e.from, [...(above.get(e.from) ?? []), relUp[e.kind] ?? e.kind]);
    for (const [id, kinds] of above) {
      const n = byId.get(id);
      const onlyVersion = kinds.every((k) => k === relUp.version);
      if (n) lines.push(`  ${c.dim(onlyVersion ? 'older' : 'base')}  ${label(n)}  ${c.dim(`(${[...new Set(kinds)].join(', ')})`)}`);
    }
    if (above.size) lines.push(c.dim('    ↓'));
    const root = byId.get(r.root);
    if (root) lines.push(`  ${c.dim('this')}  ${label(root)}`);
    const kids = children(r.root);
    if (kids.length) lines.push(c.dim('    ↓'));
    const seen = new Set<string>([r.root]);
    const walk = (from: string, indent: string) => {
      for (const e of children(from)) {
        const n = byId.get(e.to);
        if (!n || seen.has(e.to)) continue;
        seen.add(e.to);
        lines.push(`${indent}${c.dim(relDown[e.kind] ?? e.kind)}  ${label(n)}`);
        walk(e.to, `${indent}  `);
      }
    };
    walk(r.root, '  ');
    if (!above.size && !kids.length) lines.push(c.dim('  nothing was built on this, and it was not built on anything'));
    lines.push('');
    lines.push(c.dim(`this family: ${r.family.sales} sales · ${r.family.knowledges} knowledges · ${r.family.authors} creators`));
    if (r.money.lineage_pct > 0) lines.push(c.dim(`each sale: ${r.money.seller_pct}% to ${r.money.seller_name ?? 'the seller'}, ${r.money.lineage_pct}% shared by the creators of ${r.money.lineage_names.join(', ')}`));
    if (r.money.contributor_pct > 0) lines.push(c.dim(`  and ${r.money.contributor_pct}% to this knowledge's own credited teacher${r.money.recipients.filter((x) => x.kind === 'contributor').map((x) => ` (${x.name ?? shortAddr(x.address, 8)})`).join('')}`));
    if (r.truncated) lines.push(c.dim(`(stopped at depth ${r.depth} — ask for more with --depth)`));
    return lines.join('\n');
  });
  return r;
}

export interface IssueView { id: string; kind: string; count: number; people: number; topic: string | null; text: string | null; sample_index: number | null; status: string; covered_by: string | null; first_seen: number; last_seen: number }

/**
 * `ainize patch missing <id>` — the open questions of a knowledge. A row with no text is not a bug: the question was
 * counted without being kept, because nobody consented to share it (§10).
 */
export async function patchMissing(ctx: CliContext, id: string, opts: { kind?: string; limit?: number; all?: boolean } = {}): Promise<IssueView[]> {
  const r = await new NodeClient(ctx).get<{ total: number; counts: Record<string, number>; items: IssueView[] }>(
    `/api/patches/${encodeURIComponent(id)}/issues${query({ kind: opts.kind, limit: opts.limit, status: opts.all ? 'all' : 'open' })}`);
  const kindText: Record<string, string> = { own_miss: 'its own question, got wrong here', preflight: 'someone tried to teach it on top', free_wrong: 'a free question marked wrong', request: 'a buyer asked for it', gap: 'coverage gap' };
  emit(ctx, r.items, (rows) => table(rows, [
    { key: 'k', title: 'WHY', get: (x) => kindText[x.kind] ?? x.kind },
    { key: 'q', title: 'QUESTION', get: (x) => x.text ?? c.dim('not shared — counted only') },
    { key: 'n', title: 'ASKED', get: (x) => `${x.count}×`, align: 'right' },
    { key: 'p', title: 'PEOPLE', get: (x) => String(x.people), align: 'right' },
    { key: 's', title: 'STATUS', get: (x) => (x.covered_by ? c.ok(`covered by ${x.covered_by}`) : 'open') },
  ], 'nothing reported yet — load it in Chat and ask around'));
  return r.items;
}

/** `ainize patch signals <id>` — what it is doing, with the two scopes kept apart (SC-11). */
export async function patchSignals(ctx: CliContext, id: string): Promise<{ network: Record<string, number | string>; node: Record<string, number> }> {
  const r = await new NodeClient(ctx).get<{ patch_id: string; network: Record<string, number | string>; node: Record<string, number> }>(`/api/patches/${encodeURIComponent(id)}/signals`);
  emit(ctx, { network: r.network, node: r.node }, () => [
    c.dim('network — read from the ledger and the peers, the same on every node'),
    kv([
      ['sales', `${r.network.sales_all} (${r.network.sales_30d} in 30 days)`],
      ['buyers', String(r.network.buyers)], ['revenue', String(r.network.revenue)],
      ['loaded on', `${r.network.loads} nodes`], ['built on', `${r.network.built_on} knowledges`],
      ['versions', String(r.network.versions)], ['track subscribers', String(r.network.subscribers)],
      ['verified', `${r.network.passed}/${r.network.quorum}`],
    ]),
    '',
    c.dim(`this node — last ${r.node.window_days} days, this node only`),
    kv([
      ['live tests', `${r.node.tests} (✓${r.node.hits} ✗${r.node.misses} unscored ${r.node.unscored})`],
      ['marked wrong', String(r.node.marked_wrong)], ['visitors', String(r.node.visitors)],
      ['pre-flight on top of it', `${r.node.preflight_wrong_today} new · ${r.node.preflight_in_base} already answered · ${r.node.preflight_base_conflict} disagreeing`],
      ['questions fetched', String(r.node.derive_fetches)], ['lessons built on it', String(r.node.builds_on_jobs)],
      ['open questions', String(r.node.open_questions)],
    ]),
  ].join('\n'));
  return { network: r.network, node: r.node };
}

/**
 * `ainize patch conflicts <id>` — the bodies that write the same memory rows, and which of them is winning (item 216).
 *
 * The table used to print an overlap and stop, leaving the only question that matters — whose answer does the model
 * actually give on those rows — unanswerable from any surface. An overlap decides nothing until both are loaded;
 * when they are, the one loaded later wins, and that is what the row says.
 */
export async function patchConflicts(ctx: CliContext, id: string): Promise<PatchDetail['conflicts']> {
  const client = new NodeClient(ctx);
  const r = await client.get<{ conflicts: PatchDetail['conflicts'] }>(`/api/patches/${encodeURIComponent(id)}/conflicts`);
  const loaded = await loadedPositions(client);
  const mine = loaded.get(id) ?? null;
  const verdict = (x: PatchDetail['conflicts'][number]) => {
    const theirs = loaded.get(x.patch_id) ?? null;
    if (theirs === null && mine === null) return c.dim('neither is loaded — nothing is overridden');
    if (theirs === null) return c.dim(`only ${id} is loaded — its answers stand`);
    if (mine === null) return c.warn(`${x.patch_id} is loaded and ${id} is not — the model answers from ${x.patch_id}`);
    return theirs > mine
      ? c.warn(`loaded above (#${theirs} > #${mine}): its answers win on the ${x.overlap_rows.toLocaleString('en-US')} shared rows`)
      : c.ok(`loaded below (#${theirs} < #${mine}): ${id} wins on the ${x.overlap_rows.toLocaleString('en-US')} shared rows`);
  };
  emit(ctx, r.conflicts, (rows) => table(rows, [
    { key: 'p', title: 'PATCH', get: (x) => x.patch_id },
    { key: 'l', title: 'LOADED', get: (x) => (loaded.has(x.patch_id) ? c.ok(`#${loaded.get(x.patch_id)}`) : c.dim('-')), align: 'right' },
    { key: 'o', title: 'SHARED ROWS', get: (x) => x.overlap_rows.toLocaleString('en-US'), align: 'right' },
    { key: 's', title: 'SAME SCHEMA', get: (x) => (x.same_schema ? c.warn('yes') : 'no') }, { key: 'st', title: 'STATUS', get: (x) => statusColor(x.status) },
    { key: 'w', title: 'WHICH ONE ANSWERS', get: verdict },
  ], 'no address-set overlap with any patch body held by this node')
    + `\n${c.dim(mine === null ? `${id} is not loaded in the serving model (${PROG} patch apply ${id})` : `${id} is loaded at #${mine} (${PROG} patch stack shows the whole stack)`)}`);
  return r.conflicts;
}

// ---------------------------------------------------------------- `ainize purchases` (items 216, 289)
/** One purchase this node made, as `GET /api/me/purchases` reports it (the row plus the anchor it belongs to). */
export interface PurchaseRowView {
  patch_id: string; sha256: string; tx_hash: string; scheme: string; amount: string;
  path: string | null; created_at: number; applied?: boolean;
  entry?: (CatalogEntry & { anchor: PatchAnchor }) | null;
}

/**
 * `ainize purchases` — what this node bought, from whom, for how much, and whether it is loaded.
 *
 * `patch ls --mine` is "knowledge I registered" and hid every purchase (item 216), so a buyer's own node could not
 * list what it owned; and the purchase row itself names no counterparty (item 289), which is the first thing anyone
 * needs for a refund, a dispute or an audit. The seller is resolved here from the anchor the same call returns.
 */
export async function purchasesLs(ctx: CliContext): Promise<PurchaseRowView[]> {
  const client = new NodeClient(ctx);
  const r = await client.get<{ items: PurchaseRowView[] }>('/api/me/purchases');
  const loaded = await loadedPositions(client);
  const seller = (p: PurchaseRowView) => {
    const a = p.entry?.anchor;
    if (!a) return c.dim('unknown — this node no longer holds that anchor');
    return a.author_name ? `${a.author_name} ${c.dim(shortAddr(a.author, 4))}` : shortAddr(a.author, 8);
  };
  emit(ctx, r.items, (rows) => table(rows, [
    { key: 'id', title: 'KNOWLEDGE', get: (p) => c.id(p.patch_id) },
    { key: 'n', title: 'NAME', get: (p) => p.entry?.anchor.name ?? c.dim('-') },
    { key: 'a', title: 'PAID', get: (p) => `${p.amount}${p.entry ? ` ${p.entry.anchor.currency}` : ''}`, align: 'right' },
    { key: 'to', title: 'PAID TO', get: seller },
    { key: 's', title: 'HOW', get: (p) => p.scheme },
    { key: 'tx', title: 'TX', get: (p) => shortHash(p.tx_hash, 14) },
    { key: 'l', title: 'LOADED', get: (p) => (loaded.has(p.patch_id) ? c.ok(`#${loaded.get(p.patch_id)}`) : c.dim('-')), align: 'right' },
    { key: 'f', title: 'FILE', get: (p) => (p.path ? c.ok('here') : c.warn(`gone — ${PROG} patch download ${p.patch_id}`)) },
    { key: 't', title: 'BOUGHT', get: (p) => fmtTime(p.created_at) },
  ], `this node has not bought anything yet — \`${PROG} patch ls\` is the catalogue, \`${PROG} use <id>\` buys and loads one`));
  return r.items;
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

/**
 * `ainize patch rm <id>` — delete a draft, after saying what goes (item 168).
 *
 * The friction was inverted twice over: the console makes you type the full id to delete a draft, while this
 * command did it on one keystroke — no prompt, no `--yes`, no report of what was deleted, and no undo. The draft
 * may be the only record of a lesson trained somewhere else, whose recipe the operator no longer has.
 */
export async function patchRm(ctx: CliContext, id: string, opts: { yes?: boolean } = {}): Promise<void> {
  const client = new NodeClient(ctx);
  const d = await client.get<PatchDetail>(`/api/patches/${encodeURIComponent(id)}`).catch(() => null);
  if (d && d.status !== 'DRAFT') {
    throw new CliError(`${id} is ${d.status}, not a draft — a published knowledge cannot be deleted (its anchor is on the permanent record). Take it off sale with \`${PROG} patch retire ${id}\`, or stop serving the file with \`${PROG} patch forget ${id}\`.`);
  }
  if (d) {
    const a = d.anchor;
    info(ctx, [
      `${c.id(id)} · ${a.name}`,
      c.dim(`  ${a.rows.toLocaleString('en-US')} rows · ${fmtBytes(a.size_bytes)} · ${a.model.id_M} · benchmark ${a.benchmark.schema} (${a.benchmark.queries} questions)`),
      c.dim(`  deleting it removes the name, the benchmark, the lineage and the price from this node — nothing was ever written to the ledger, and there is no undo.`),
      d.has_body
        ? c.dim(`  the knowledge FILE itself stays in this node's blob store (sha256 ${shortHash(a.patch_sha256, 12)}, \`${PROG} blobs ls\`); \`${PROG} patch forget\` is what deletes that.`)
        : c.warn('  its body is not on this node'),
    ].join('\n'));
  }
  await confirm(ctx, `Delete draft ${id}? [y/N]`, { yes: opts.yes });
  await client.delete(`/api/patches/${encodeURIComponent(id)}`);
  ok(ctx, `draft ${id} deleted${d ? c.dim(`  (${d.anchor.rows.toLocaleString('en-US')} rows, ${fmtBytes(d.anchor.size_bytes)}; the file is still in the blob store)`) : ''}`);
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
  // Forgetting is not a takedown (item 148): the listing is still on the record and the gateway still charges for it.
  info(ctx, c.dim(`  this changes nothing on the public record: ${r.patch_id} stays listed and its gateway keeps taking payments. To take it off sale for good: ${PROG} patch retire ${r.patch_id}`));
  return r;
}


/**
 * `ainize use <id>` — the one-line consumer path: check it is verified, pay automatically (x402), download,
 * verify the body hash and load it into this node's model. Falls back gracefully when the runtime is off.
 */
export async function patchUse(ctx: CliContext, id: string, opts: BuyArgs = {}): Promise<PurchaseResult | { already: true }> {
  const client = new NodeClient(ctx);
  const detail = await client.get<PatchDetail & { purchased: boolean; has_body: boolean; owned: boolean; applied: boolean }>(`/api/patches/${encodeURIComponent(id)}`);
  const apply = opts.apply !== false;
  // SUPERSEDED knowledge stays valid (point-in-time versions); it just has a newer version on the same subject.
  if (detail.status === 'CHALLENGED') {
    const ch = detail.open_challenge;
    throw new CliError(`${id} is CHALLENGED — a verifier disputes it, so it is not for sale until it is re-verified${ch ? `\n  ${shortAddr(ch.challenger, 8)}: "${ch.reason}" (${fmtTime(ch.created_at)})` : ''}\n  see the dispute: ainize patch get ${id}`);
  }
  /*
   * Item 263 — every non-LISTED status used to be reported as "not verified yet", so a finished, FAILED verification
   * read as one still in progress and a script keyed on that sentence retried a rejected bake forever. A verification
   * that is over says so, with what the verifiers answered, and exits 6 (the same code `teach train --wait` uses for
   * REJECTED) so a cron line can tell "wait" from "this will never work".
   */
  if (detail.status === 'REJECTED') {
    const fails = detail.attestations.filter((x) => !x.passed).length;
    throw new CliError(`${id} FAILED verification — ${detail.passed}/${detail.quorum} passed, ${fails} verifier${fails === 1 ? '' : 's'} answered FAIL. It is not for sale and retrying will not change it: the network measured this build and rejected it.\n`
      + `  what they answered:  ${PROG} patch get ${id}\n`
      + `  ${detail.superseded_by.length ? `a newer build of the same subject: ${detail.superseded_by.join(', ')}` : 'wait for its publisher to bake a new one'}`, 6);
  }
  if (detail.status === 'RETIRED') {
    throw new CliError(`${id} was withdrawn by its publisher${detail.retire_reason ? ` ("${detail.retire_reason}")` : ''} — off sale for good; everyone who already bought it keeps their copy.`, 6);
  }
  if (!detail.quorum_ok || !['LISTED', 'SUPERSEDED'].includes(detail.status)) throw new CliError(`${id} is ${detail.status} (verification ${detail.passed}/${detail.quorum}) — not verified yet, so it cannot be bought here; the verifiers usually answer within a few minutes. Watch it with \`${PROG} patch get ${id}\``);
  if (detail.status === 'SUPERSEDED' && detail.superseded_by?.length) ok(ctx, c.dim(`note: a newer version exists on the same subject → ${detail.superseded_by.join(', ')} (newer version available)`));
  if (detail.has_body && (detail.purchased || detail.owned)) {
    ok(ctx, `${c.id(id)} is already on this node ${detail.owned ? '(you published it)' : '(purchased)'}`);
    // item 220: the document says which of the two happened, and whether it ended up loaded
    // §8.7 — `use` means the knowledge WORKS afterwards, so an add-on is loaded with the stack it was trained on
    // top of; without this, `ainize use <child>` on a held child failed with `needs_base` and left nothing loaded.
    if (apply) { await patchApply(ctx, id, { withBase: true }); }
    if (!ctx.json) ok(ctx, c.dim(`try it: ${PROG} chat ${id} "your question"`));
    return emitStep(ctx, !!opts.batched, { patch_id: id, already: true as const, owned: !!detail.owned, purchased: !!detail.purchased, applied: apply, has_body: true }, () => '');
  }
  // A knowledge already paid for whose body this node no longer holds is COLLECTED, not bought again (item 273).
  if (detail.purchased && !detail.has_body) {
    info(ctx, c.dim(`${id} was already paid for on this node but its body is not here — collecting it again, free`));
    const back = await patchDownload(ctx, id);
    if (apply) await patchApply(ctx, id, { withBase: true });
    return back;
  }
  const r = await patchBuy(ctx, id, { ...opts, apply });
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

export interface ImportArgs { file: string; recipe: string; id?: string; name?: string; model?: string; price?: string; license?: string; description?: string; dropLineage?: boolean; }
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
  /**
   * A lesson trained on top of somebody's knowledge carries that knowledge's id in its recipe, and the import used
   * to drop the link with a warning whenever this node had not heard of the base yet (item 175) — turning a
   * derivative into a root, with no credit and no royalty, on a line most people scroll past. It refuses now: the
   * base has to reach this node first (`ainize peers add <url>` is one gossip round), and `--drop-lineage` is the
   * explicit way to say "import it as a root anyway".
   */
  const parents: string[] = [];
  const unknownParents: string[] = [];
  for (const pid of d.parents) { try { await client.get(`/api/patches/${encodeURIComponent(pid)}`, { auth: false }); parents.push(pid); } catch { unknownParents.push(pid); } }
  if (unknownParents.length && !a.dropLineage) {
    throw new CliError(`this lesson was trained on top of ${unknownParents.join(', ')}, and ${unknownParents.length > 1 ? 'those are' : 'that is'} not on this node — importing it now would record it as a root, with no credit to ${unknownParents.length > 1 ? 'their creators' : 'its creator'} and no royalty on any sale.\n  add the node that publishes it:  ${PROG} peers add <its url>   (the record arrives within about 10 s)\n  or import it as a root anyway:   ${PROG} patch import ${a.file} --recipe ${a.recipe} --drop-lineage`);
  }
  if (unknownParents.length) warnLine(ctx, `--drop-lineage: imported WITHOUT the link to ${unknownParents.join(', ')} — this draft claims no base, so nobody is credited if you publish it`);
  const r = await client.post<{ anchor: PatchAnchor }>('/api/patches', {
    id: d.id, name: d.name, model_id: d.model_id, benchmark: JSON.stringify(d.benchmark), description: d.description, price: a.price, license: a.license,
    parents: parents.join(',') || undefined, path: file, contributors: d.contributors ? JSON.stringify(d.contributors) : undefined,
    // An import is a PRIVATE draft of a lesson someone else trained, not a publish: the model mismatch is stated in
    // words above (it is the whole point of the warning) rather than refused the way `publish` refuses it (item 154).
    force: true,
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
