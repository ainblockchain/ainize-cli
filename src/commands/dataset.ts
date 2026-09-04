/**
 * `ainize dataset get <patch-id|sha>` — the TRAINING SET behind a published knowledge (lineage design §13, §12.3).
 *
 * Different from `ainize teach dataset get <id>`, which is one of MY datasets on this node: this asks a knowledge
 * for the questions it was taught from, under the access level its creator chose (§6.1):
 *
 *   public       anyone may download and build on them
 *   derivative   only people building on this knowledge — the CLI posts a signed derive intent and fetches with the
 *                token it gets back, which is also what the creator's "built on N times" counter is made of
 *   private      nobody: the refusal says so in plain words and exits 3
 *
 *   ainize dataset get krx-all-2761                      # what it is: questions, licence, access, where it came from
 *   ainize dataset get krx-all-2761 -o questions.jsonl   # the exact canonical bytes (re-uploadable as my own dataset)
 *   ainize dataset get krx-all-2761 --manifest           # row origin, benchmark hash, PII scan, declaration
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signMessage } from '@ngram/core';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, fmtBytes, kv, shortHash, warn } from '../output.js';
import { TeachSession } from './teach-dataset.js';
import type { KeyOpts } from './teach.js';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const SHA_RE = /^[0-9a-f]{64}$/i;

/** `GET /api/patches/:id/dataset` (design §12.3). `preview` is the first 20 questions; `held` is this node's copy. */
export interface PublishedDataset {
  sha256: string;
  rows: number;
  access: 'public' | 'derivative' | 'private';
  license: string | null;
  parents: { patch_id: string; sha256: string; rows: number }[];
  held: boolean;
  include_notes: boolean;
  benchmark_samples: number | null;
  merkle_root: string | null;
  preview?: { prompt: string; answer: string; alt_prompt?: string; note?: string }[];
}
export interface DatasetGetOpts extends KeyOpts { out?: string; manifest?: boolean; includeNotes?: boolean }
export interface PublishedDatasetResult {
  node: string;
  patch_id: string;
  name?: string;
  dataset: PublishedDataset;
  manifest?: Record<string, unknown>;
  saved?: { path: string; bytes: number; sha256: string; verified: boolean; notes_removed: number; via: 'node' | 'derive' };
}

/** A refusal a person can act on: the node's reason, plus what to do about it. Exit 3, like a missing login. */
function refusal(e: unknown): never {
  const err = e as CliError;
  const msg = String(err?.message ?? e);
  if (/^dataset_private/.test(msg)) throw new CliError(`${msg}\nOnly the verification questions on the record are public. Ask the creator, or build on a knowledge whose training set is shared.`, 3, err.details);
  if (/^dataset_derivative_only/.test(msg)) throw new CliError(`${msg}\nSign the request with a teaching key (this CLI does) — if it still refuses, the creator's node no longer serves it.`, 3, err.details);
  if (/^dataset_unavailable/.test(msg)) throw new CliError(`${msg}\nNo node here holds the bytes. Try again against a node that does: \`${PROG} dataset get <id> --node <url>\`.`, 3, err.details);
  throw e;
}

/**
 * The training set of a published knowledge. With `-o` the bytes are written: the public path is a plain download,
 * a `derivative` set goes through a signed derive intent and `/p2p/dataset/<sha>` with the token it returns.
 */
export async function datasetGetPublished(ctx: CliContext, target: string, opts: DatasetGetOpts = {}): Promise<PublishedDatasetResult> {
  const s = await TeachSession.open(ctx, opts);
  const { id, name } = await resolveTarget(s, target);
  const dataset = await s.get<PublishedDataset>(`/api/patches/${encodeURIComponent(id)}/dataset`).catch(refusal);
  const out: PublishedDatasetResult = { node: s.client.baseUrl, patch_id: id, ...(name ? { name } : {}), dataset };
  if (opts.manifest) out.manifest = (await s.get<{ manifest: Record<string, unknown> }>(`/api/patches/${encodeURIComponent(id)}/dataset/manifest`).catch(refusal)).manifest;
  if (opts.out) out.saved = await download(s, id, dataset, opts, ctx);
  emit(ctx, out, renderPublishedDataset);
  return out;
}

/** A sha256 names the bytes, not the knowledge: find the knowledge on this node that published them. */
async function resolveTarget(s: TeachSession, target: string): Promise<{ id: string; name?: string }> {
  if (!SHA_RE.test(target)) return { id: target };
  const sha = target.toLowerCase();
  const cat = await s.client.get<{ items: { anchor: { id: string; name: string; dataset?: { sha256?: string } } }[] }>('/api/catalog?limit=200', { auth: false }).catch(() => ({ items: [] }));
  const hit = cat.items.map((e) => e.anchor).find((a) => a.dataset?.sha256 === sha);
  if (!hit) throw new CliError(`no knowledge on ${s.client.baseUrl} published the training set ${shortHash(sha, 12)} — give the knowledge id instead`, 3);
  return { id: hit.id, name: hit.name };
}

async function download(s: TeachSession, id: string, d: PublishedDataset, opts: DatasetGetOpts, ctx: CliContext): Promise<NonNullable<PublishedDatasetResult['saved']>> {
  let bytes: Buffer | null = null;
  let via: 'node' | 'derive' = 'node';
  const direct = await s.raw(`/api/patches/${encodeURIComponent(id)}/dataset/rows`);
  if (direct.ok) bytes = Buffer.from(await direct.arrayBuffer());
  else if (direct.status === 403 && d.access === 'derivative') {
    // the derive intent IS the record that someone is building on this knowledge (§6.1) — it is counted on the parent
    const intent = await s.post<{ token: string; sha256: string }>(`/api/patches/${encodeURIComponent(id)}/derive-intent`, {}).catch(refusal);
    const ts = Date.now();
    const auth = `${s.key.address}:${ts}:${signMessage(`dataset:${intent.sha256}:${ts}`, s.key.privateKey)}`;
    const res = await fetch(`${s.client.baseUrl}/p2p/dataset/${intent.sha256}`, { headers: { 'x-ngram-auth': auth, 'x-ngram-derive': intent.token } });
    if (!res.ok) throw new CliError(`the training set was not served: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, 3);
    bytes = Buffer.from(await res.arrayBuffer());
    via = 'derive';
  } else {
    const body = await direct.text();
    let msg = `HTTP ${direct.status}`;
    try { msg = String((JSON.parse(body) as { error?: string }).error ?? msg); } catch { /* not json */ }
    refusal(new CliError(msg, 3));
  }
  // notes are the publisher's own words about a row; they are in the file only because the publisher opted in, and
  // they are written to disk only if this caller asks for them too (§6.2)
  let notesRemoved = 0;
  let written = bytes!;
  if (!opts.includeNotes) {
    const lines = written.toString('utf8').split('\n').filter((l) => l.trim());
    const stripped = lines.map((l) => {
      try {
        const o = JSON.parse(l) as Record<string, unknown>;
        if (o.note === undefined) return l;
        notesRemoved++;
        const { note: _n, ...rest } = o;
        return JSON.stringify(rest);
      } catch { return l; }
    });
    if (notesRemoved) written = Buffer.from(stripped.join('\n') + '\n', 'utf8');
  }
  const path = resolve(opts.out!);
  writeFileSync(path, written);
  const verified = sha256(written) === d.sha256;
  if (!verified && !notesRemoved) warn(ctx, 'the bytes do not hash to the fingerprint on the record — do not build on this file');
  return { path, bytes: written.length, sha256: sha256(written), verified, notes_removed: notesRemoved, via };
}

export function renderPublishedDataset(r: PublishedDatasetResult): string {
  const d = r.dataset;
  const access = d.access === 'public' ? 'public — anyone can download and build on them'
    : d.access === 'derivative' ? 'shared with people building on this knowledge'
      : 'private — nobody can build on this knowledge';
  const lines = [
    c.head(`training set of ${c.id(r.patch_id)}${r.name ? ` · ${r.name}` : ''}`),
    kv([
      ['questions', String(d.rows)],
      ['access', access],
      ['licence', d.license ?? '—'],
      ['fingerprint', shortHash(d.sha256, 16)],
      ['on this node', d.held ? 'yes' : 'no — fetched from a peer when needed'],
      ...(d.parents.length ? [['built from', d.parents.map((p) => `${p.patch_id} (${p.rows} questions)`).join(', ')] as [string, string]] : []),
      ...(d.benchmark_samples ? [['checked with', `${d.benchmark_samples} questions (the full list travels with the set)`] as [string, string]] : []),
    ]),
  ];
  if (d.preview?.length) {
    lines.push('', c.head(`first ${d.preview.length} questions`));
    for (const row of d.preview) lines.push(`  ${c.dim('Q')} ${row.prompt}\n  ${c.dim('A')} ${row.answer}`);
  }
  if (r.manifest) lines.push('', c.head('manifest'), JSON.stringify(r.manifest, null, 1));
  if (r.saved) {
    lines.push('', c.ok('✓ ') + `saved ${r.saved.path} (${fmtBytes(r.saved.bytes)})${r.saved.via === 'derive' ? c.dim(' · fetched as a derivative — the creator’s node counted it') : ''}`);
    if (r.saved.notes_removed) lines.push(c.dim(`  ${r.saved.notes_removed} note(s) left out — pass --include-notes to keep them (and the published fingerprint)`));
    else if (r.saved.verified) lines.push(c.dim('  fingerprint verified — uploading this file gives you the same questions to build on'));
  }
  return lines.join('\n');
}
