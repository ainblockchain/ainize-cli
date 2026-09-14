/**
 * `ainize ledger ls|verify|graph|export`
 */
import { writeFileSync } from 'node:fs';
import type { LedgerRecord, RecordKind } from '@ainize/core';
import { NodeClient, query } from '../client.js';
import type { CliContext } from '../context.js';
import { c, emit, fmtTime, kv, ok, shortAddr, shortHash, statusColor, table } from '../output.js';

export interface LedgerInfo { kind: string; network: string; records: number; height?: number; head?: string; provider?: string; app?: string; }

interface InferenceView {
  enabled: boolean; total: number; offset: number; limit: number; unbatched_receipts: number; scope: string;
  entries: { id: string; state: string; path?: string; tx_hash?: string;
    batch: { model_id: string; request_count: number }; receipt_commitment_valid?: boolean; receipts?: unknown[] | null }[];
}

export async function ledgerInference(ctx: CliContext, opts: { id?: string; receipts?: boolean; offset: number; limit: number }) {
  if (opts.receipts && !opts.id) throw new Error('--receipts requires a batch ID');
  const result = await new NodeClient(ctx).get<InferenceView>(`/api/ledger/inference${query({ id: opts.id, receipts: opts.receipts, offset: opts.offset, limit: opts.limit })}`);
  emit(ctx, result, view => [
    kv([['recording enabled', view.enabled], ['matching batches', view.total], ['unbatched receipts', view.unbatched_receipts]]),
    view.scope,
    ...view.entries.map(entry => kv([
      ['batch', entry.id], ['state', entry.state], ['model', entry.batch.model_id], ['requests', entry.batch.request_count],
      ['transaction', entry.tx_hash ?? '-'], ['chain path', entry.path ?? '-'],
      ['receipt commitment matches', entry.receipt_commitment_valid ?? 'not checked'],
    ])),
    ...(opts.receipts ? ['Use --json to export the receipt array.'] : []),
  ].join('\n\n'));
  return result;
}

/**
 * Item 197 — a settle row said `<id> · 10 CREDIT · buyer 0x81…` and stopped exactly one field short of the money:
 * `royalty` on the same record body says who was actually paid what. A creator checking whether her 30 % arrived
 * had to re-run with `--json` and read addresses. `names` resolves an address to a name using the records
 * themselves (a `node` record carries a node's name, an `anchor` its author's and its contributors'), so nothing is
 * invented — an address the record never named stays an address.
 */
function summary(r: LedgerRecord, names?: (address: string) => string | undefined): string {
  const who = (a: unknown) => names?.(String(a ?? '')) ?? shortAddr(String(a ?? ''), 4);
  const b = r.body as Record<string, unknown>;
  switch (r.kind) {
    case 'anchor': return `${b.id} · ${(b.model as { id_M?: string })?.id_M ?? b.id_M ?? ''} · ${b.rows ?? '?'} rows`;
    case 'attest': return `${b.patch_id ?? b.id} · ${b.passed === false ? 'FAIL' : 'PASS'} · ${b.verified_on ?? ''}`;
    case 'settle': {
      const seller = String(b.seller ?? '').toLowerCase();
      const paid = Object.entries((b.royalty ?? {}) as Record<string, string>)
        .filter(([addr, v]) => Number(v) > 0 && addr.toLowerCase() !== seller)
        .map(([addr, v]) => `${who(addr)} ${v}`);
      const unresolved = Object.values((b.royalty_unresolved ?? {}) as Record<string, string>).reduce((n, v) => n + Number(v), 0);
      return `${b.patch_id ?? b.resource} · ${b.amount} ${b.currency ?? ''} · buyer ${who(b.buyer)}`
        + (paid.length ? ` → ${paid.join(' · ')} (creator share)` : '')
        + (unresolved > 0 ? ` · ${Math.round(unresolved * 1e6) / 1e6} ${b.currency ?? ''} with no payee yet` : '');
    }
    case 'branch': return `${b.name} · ${(b.patch_ids as string[])?.length ?? 0} patch(es)`;
    case 'node': return `${b.name} · ${b.endpoint} · ${(b.roles as string[])?.join(',')}`;
    case 'supersede': return `${b.new_patch_id} supersedes ${b.old_patch_id} (${b.overlap_rows} rows)`;
    case 'subscribe': return `${b.action} ${b.branch}`;
    case 'challenge': return `${b.patch_id} · ${b.reason}`;
    default: return JSON.stringify(b).slice(0, 60);
  }
}

/** Every name the record set itself carries, for the settle rows that pay those addresses (item 197). */
function nameOf(records: LedgerRecord[]): (address: string) => string | undefined {
  const m = new Map<string, string>();
  for (const r of records) {
    const b = (r.body ?? {}) as Record<string, unknown>;
    if (r.kind === 'node' && typeof b.address === 'string' && typeof b.name === 'string' && b.name) m.set(b.address.toLowerCase(), b.name);
    if (r.kind === 'anchor') {
      if (typeof b.author === 'string' && typeof b.author_name === 'string' && b.author_name) m.set(b.author.toLowerCase(), b.author_name);
      for (const con of (b.contributors as { address?: string; signer?: string; name?: string }[] | undefined) ?? []) {
        if (con.name && con.address) m.set(con.address.toLowerCase(), con.name);
        if (con.name && con.signer) m.set(con.signer.toLowerCase(), con.name);
      }
    }
  }
  return (address: string) => m.get(address.toLowerCase());
}

export async function ledgerLs(ctx: CliContext, a: { kind?: RecordKind; limit?: number } = {}): Promise<{ info: LedgerInfo; records: LedgerRecord[] }> {
  const d = await new NodeClient(ctx).get<{ info: LedgerInfo; records: LedgerRecord[] }>(`/api/ledger${query({ kind: a.kind, limit: a.limit ?? 50 })}`);
  // "ledger is empty" two lines under "records 1223" was the lie: an empty *filter* is not an empty ledger (item 116)
  const empty = a.kind
    ? `no records of kind '${a.kind}' (${d.info.records} record(s) in the ledger)`
    : d.info.records ? `no records in the newest ${a.limit ?? 50} (${d.info.records} in the ledger)` : 'ledger is empty';
  emit(ctx, d, (x) => [
    kv([['ledger', `${x.info.kind} · ${x.info.network}${x.info.provider ? ` · ${x.info.provider}` : ''}`], ['records', x.info.records], ['height', x.info.height ?? '-'], ['head', x.info.head ? shortHash(x.info.head, 20) : '-']]),
    '',
    table(x.records, [
      { key: 't', title: 'AT', get: (r) => fmtTime(r.ts) }, { key: 'k', title: 'KIND', get: (r) => c.id(r.kind.padEnd(9)) },
      { key: 'a', title: 'AUTHOR', get: (r) => shortAddr(r.author, 6) }, { key: 's', title: 'SUMMARY', get: (r) => summary(r, nameOf(x.records)) },
      { key: 'h', title: 'HASH', get: (r) => shortHash(r.hash, 14) },
    ], empty),
  ].join('\n'));
  return d;
}

export async function ledgerVerify(ctx: CliContext): Promise<{ valid: boolean; checked: number; errors: string[] }> {
  const d = await new NodeClient(ctx).get<{ valid: boolean; checked: number; errors: string[] }>('/api/ledger/verify');
  emit(ctx, d, (x) => (x.valid ? c.ok(`✓ ledger valid — ${x.checked} record(s) checked (hashes, signatures, imported chain linkage)`) : c.err(`✗ ledger INVALID — ${x.errors.length} problem(s):\n`) + x.errors.map((e) => `  - ${e}`).join('\n')));
  return d;
}

export interface GraphResponse { nodes: { id: string; name: string; author: string; status: string; model: string; schema: string; branch?: string }[]; edges: { from: string; to: string; type: string }[]; chain: unknown; }

export async function ledgerGraph(ctx: CliContext): Promise<GraphResponse> {
  const g = await new NodeClient(ctx).get<GraphResponse>('/api/ledger/graph');
  emit(ctx, g, (x) => {
    const byId = new Map(x.nodes.map((n) => [n.id, n]));
    const children = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const e of x.edges.filter((e) => e.type === 'extends')) { children.set(e.to, [...(children.get(e.to) ?? []), e.from]); hasParent.add(e.from); }
    const sup = new Map<string, string[]>();
    for (const e of x.edges.filter((e) => e.type === 'supersedes')) sup.set(e.from, [...(sup.get(e.from) ?? []), e.to]);
    const lines: string[] = [c.head('lineage (child → parent edges, royalties flow upward)')];
    const draw = (id: string, prefix: string, last: boolean, depth: number) => {
      const n = byId.get(id);
      const label = n ? `${c.id(id)} ${c.dim(`[${n.model} · ${n.schema}${n.branch ? ` · ${n.branch}` : ''}]`)} ${statusColor(n.status)}` : c.dim(id);
      const s = sup.get(id)?.length ? c.dim(`  supersedes ${sup.get(id)!.join(', ')}`) : '';
      lines.push(depth === 0 ? `${label}${s}` : `${prefix}${last ? '└─ ' : '├─ '}${label}${s}`);
      const kids = children.get(id) ?? [];
      kids.forEach((k, i) => draw(k, depth === 0 ? '' : prefix + (last ? '   ' : '│  '), i === kids.length - 1, depth + 1));
    };
    const roots = x.nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
    roots.forEach((r) => { draw(r, '', true, 0); lines.push(''); });
    return lines.join('\n').trimEnd() || c.dim('(empty)');
  });
  return g;
}

/** The node returns the NEWEST `limit` records and cannot page backwards (GET /api/ledger). */
const EXPORT_MAX = 5000;

export async function ledgerExport(ctx: CliContext, file: string): Promise<number> {
  const client = new NodeClient(ctx);
  // Ask how big the ledger is first, then ask for exactly that many: exporting a fixed 1,000 silently dropped
  // everything older once the chain grew past it, and still printed "exported 1000 record(s)".
  const head = await client.get<{ info: LedgerInfo }>('/api/ledger?limit=1');
  const total = head.info.records ?? 0;
  const want = Math.min(Math.max(total, 1), EXPORT_MAX);
  const d = await client.get<{ records: LedgerRecord[] }>(`/api/ledger?limit=${want}`);
  const recs = [...d.records].reverse();
  writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''));
  ok(ctx, recs.length < total
    ? `exported the most recent ${recs.length} of ${total} record(s) to ${file} — this node returns at most ${EXPORT_MAX} per request and cannot page further back`
    : `exported ${recs.length} record(s) to ${file}`);
  return recs.length;
}
