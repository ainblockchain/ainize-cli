/**
 * `ainize teach status <target>` — read-only view of teach mode from the terminal (spec §6.4 / §14 PR-8).
 *
 * `target` is whatever the visitor has in hand:
 *   - a node URL                          → the node's teaching policy (accepting lessons? publish mode, trainer state, queue, limits)
 *   - a lesson URL (`…/chat?lesson=<id>`, `…/api/teach/jobs/<id>`) or a bare job id → that lesson's status
 *   - a teacher page (`…/teacher/<address>`) or a bare 0x address → the data provider's lessons and earnings
 * With the teaching key (`--key-file` = the browser's backup JSON, `--key` = hex, or AINIZE_TEACH_KEY) the lesson view is
 * the owner's full body (facts, before/after answers, checks); without it the node returns status only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityFromPrivateKey, signMessage, type TeachDatasetRef, type TeachEffort, type TeachTrainingSpec } from '@ainize/core';
import { teachAuthHeaderFor } from '@ainize/core';
import { NodeClient } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, fmtBytes, fmtTime, kv, shortAddr, shortHash, table } from '../output.js';

// ---------------------------------------------------------------- teaching key (same file format as the web "Download key backup")
export interface TeacherKey { privateKey: string; address: string; name?: string; payout_address?: string }

const PRIV_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a backup file body, pasted JSON or a bare private key (mirrors `parseTeacherKeyBackup` in the web app). */
export function parseTeacherKey(text: string): TeacherKey {
  const s = text.trim();
  let priv: string | undefined; let name: string | undefined; let payout: string | undefined;
  if (PRIV_RE.test(s)) priv = s;
  else {
    let j: Partial<TeacherKey>;
    try { j = JSON.parse(s) as Partial<TeacherKey>; } catch { throw new CliError('teaching key must be a 64-hex private key or the backup JSON the browser downloaded'); }
    if (typeof j.privateKey !== 'string' || !PRIV_RE.test(j.privateKey)) throw new CliError('backup has no valid private key');
    priv = j.privateKey; name = typeof j.name === 'string' && j.name.trim() ? j.name.trim().slice(0, 40) : undefined;
    payout = typeof j.payout_address === 'string' && ADDR_RE.test(j.payout_address) ? j.payout_address : undefined;
  }
  const hex = priv.replace(/^0x/, '').toLowerCase();
  const id = identityFromPrivateKey(hex);
  return { privateKey: hex, address: id.address, ...(name ? { name } : {}), ...(payout ? { payout_address: payout } : {}) };
}

export interface KeyOpts { key?: string; keyFile?: string }

/** Where the CLI keeps its own teaching key when none was passed — the same JSON the browser downloads as a backup. */
export const TEACH_KEY_FILE = 'teaching-key.json';

/**
 * The key to sign with: `--key-file` / `--key` / `AINIZE_TEACH_KEY`, else `<home>/teaching-key.json` when it exists.
 * Read-only — nothing is created here, so a read-only command never mints an identity (`ensureTeacherKey` does).
 */
export function loadTeacherKeyFor(ctx: { home: string }, o: KeyOpts = {}): TeacherKey | null {
  const explicit = loadTeacherKey(o);
  if (explicit) return explicit;
  const p = join(ctx.home, TEACH_KEY_FILE);
  return existsSync(p) ? parseTeacherKey(readFileSync(p, 'utf8')) : null;
}

/** Resolve the teaching key from --key / --key-file / AINIZE_TEACH_KEY (a hex key or a path to the backup). Null when none was given. */
export function loadTeacherKey(o: KeyOpts = {}): TeacherKey | null {
  if (o.keyFile) {
    if (!existsSync(o.keyFile)) throw new CliError(`key file not found: ${o.keyFile}`);
    return parseTeacherKey(readFileSync(o.keyFile, 'utf8'));
  }
  const raw = o.key ?? process.env.AINIZE_TEACH_KEY;
  if (!raw) return null;
  if (!PRIV_RE.test(raw.trim()) && existsSync(raw)) return parseTeacherKey(readFileSync(raw, 'utf8'));
  return parseTeacherKey(raw);
}

/**
 * Legacy `x-ainize-auth: <address>:<ts>:<sig over "teach:<ts>">`. Still accepted by nodes (single-use per route) but not
 * bound to node / method / path / body — prefer `signedTeachHeader` (v2), which is what every command here sends.
 * @deprecated use signedTeachHeader
 */
export function teachAuthHeader(key: TeacherKey, purpose = 'teach', ts = Date.now()): string {
  return `${key.address}:${ts}:${signMessage(`${purpose}:${ts}`, key.privateKey)}`;
}

/**
 * Request-bound v2 header (node `teach-auth.ts`): sig over "teach:<nodeAddress>:<METHOD>:<path+query>:<ts>[:<sha256(body)>]".
 * `body` must be the exact JSON string that is sent. Single-use: build one per request.
 */
export function signedTeachHeader(key: TeacherKey, nodeAddress: string, method: string, path: string, body?: string): string {
  return teachAuthHeaderFor(key, { node: nodeAddress, method, path, body: body ?? null });
}

/** The node's identity address (what the v2 signature is bound to) — `GET /api/auth/me` is public. */
export async function nodeAddressOf(client: NodeClient): Promise<string> {
  const me = await client.get<{ address: string }>('/api/auth/me', { auth: false });
  if (!me?.address) throw new CliError('node did not report its address (/api/auth/me)');
  return me.address;
}

// ---------------------------------------------------------------- target parsing
export type TeachTarget = { kind: 'node'; nodeUrl: string } | { kind: 'job'; nodeUrl: string; id: string } | { kind: 'teacher'; nodeUrl: string; address: string };

/** Turn what the user pasted into (node URL, what to look at). Bare ids/addresses use the context node. */
export function parseTeachTarget(target: string | undefined, defaultNode: string): TeachTarget {
  const t = (target ?? '').trim();
  if (!t) return { kind: 'node', nodeUrl: defaultNode };
  if (UUID_RE.test(t)) return { kind: 'job', nodeUrl: defaultNode, id: t.toLowerCase() };
  if (ADDR_RE.test(t)) return { kind: 'teacher', nodeUrl: defaultNode, address: t };
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(t) ? t : `http://${t}`); } catch { throw new CliError(`not a node URL, lesson URL, job id or 0x address: ${t}`); }
  const nodeUrl = `${u.protocol}//${u.host}`;
  const lesson = u.searchParams.get('lesson');
  if (lesson && UUID_RE.test(lesson)) return { kind: 'job', nodeUrl, id: lesson.toLowerCase() };
  const m = u.pathname.match(/^\/(?:api\/)?teach\/jobs\/([0-9a-f-]{36})(?:\/|$)/i);
  if (m) return { kind: 'job', nodeUrl, id: m[1].toLowerCase() };
  const tm = u.pathname.match(/^\/(?:api\/)?teacher\/(0x[0-9a-fA-F]{40})(?:\/|$)/);
  if (tm) return { kind: 'teacher', nodeUrl, address: tm[1] };
  return { kind: 'node', nodeUrl };
}

// ---------------------------------------------------------------- response shapes (server types: packages/node/src/teach.ts)
export interface TeachPolicy {
  enabled: boolean; publish: 'review' | 'auto' | 'never'; trainer: 'ready' | 'busy' | 'paused'; paused_reason?: string; backend: 'gradient' | 'stub';
  queue: { depth: number; max: number; position_eta_s?: number | null; queued_rows?: number; queued_rows_max?: number };
  /** v2 (datasets) fields are optional so the CLI still reads a v1 node. */
  limits: {
    facts_per_job: number; jobs_per_key_per_day: number; jobs_per_ip_per_day: number; prompt_max: number; answer_max: number;
    dataset_max_bytes?: number; dataset_max_rows?: number; dataset_max_source_lines?: number;
    rows_per_job?: number; rows_per_job_source?: 'default' | 'measured' | 'operator';
    rows_per_key_per_day?: number; rows_per_ip_per_day?: number; datasets_per_key_per_day?: number; dataset_ttl_days?: number;
    formats?: string[]; declaration_rows?: number;
  };
  timing: { p50_s: number | null; p90_s: number | null; samples: number; backend?: 'gradient' | 'stub'; simulated?: boolean; s_per_row_p50?: number | null };
  effort?: { id: TeachEffort; max_steps: number; eval_every: number }[];
  samples?: { kind: string; name: string; rows: number }[];
  shares: { contributor: number; lineage: number }; model: { id_M: string | null }; applied: string[]; draft_ttl_days: number;
  simulated_checks?: boolean;
  /** item 298 — whether a lesson published here can ever reach quorum. Absent on an older node: unknown, not "yes". */
  verification?: { quorum: number; peers: number; reachable: number; verifiers: number; self_verifier: boolean };
  /** item 299 — `local` is development play money; a price set here is not money anyone can spend. */
  ledger?: { kind: 'local' | 'ain'; currency: string };
}
export interface TeachJobView {
  id: string; status: string; position?: number; eta_s?: number | null; blocked?: string | null; name?: string;
  /** While `blocked` is 'lock': who holds the shared model, how long this lesson has waited, what is left of the grace (item 244). */
  blocked_by?: { holder: string; label: string; since: number; waited_s: number; grace_left_s: number } | null;
  /**
   * The questions that will NOT be trained and why (items 180 / 181). Counts alone said "known 0, overlaps 1" and
   * no surface could name the row, the knowledge, or the answer the pre-flight had measured to decide it.
   */
  preflight?: { checked: number; of: number; known: number; overlaps?: number;
    dropped?: { index: number; prompt: string; reason: 'already_known' | 'in_base' | 'overlaps_listing'; base_answer?: string; listing_id?: string; listing_name?: string }[] };
  contributor?: { address: string; name?: string }; context_patch_ids?: string[]; builds_on_context?: boolean;
  facts?: { prompt: string; answer: string; alt_prompt?: string; base_answer?: string; after_answer?: string; hit?: boolean; heldout_hit?: boolean }[];
  progress?: { step: number; max_steps: number; loss?: number; hits: number; total: number; load_s?: number; avg_step_s?: number; phase?: string; percent?: number; rows_total?: number; rows_touched?: number; eval_sample?: { n: number; of: number }; elapsed_s?: number };
  checks?: { executed: boolean; ok: boolean; taught: { hits: number; total: number; questions?: { hits: number; total: number }; sampled?: { checked: number; of: number } }; heldout?: { hits: number; total: number }; parent_regression: { ok: boolean; hit: number; total: number }; locality: { ok: boolean; same: number; total: number }; reverted_and_reapplied: boolean; note?: string; simulated?: boolean; skipped?: true;
    parent_check?: { patch_id: string; hit: number; total: number; failed: number[]; base_hit?: number; base_total?: number; base_failed?: number[]; overridden?: number }[]; reversibility_ok?: boolean | null };
  /** Lineage (design §12.1): what this lesson was trained ON TOP OF, and what it did with the base's questions. */
  bases?: { patch_id: string; sha256: string; name?: string; status?: string }[];
  mode?: 'scratch' | 'extend' | 'fork' | 'merge';
  export?: 'delta' | 'squash';
  inherited_rows?: number;
  changed_rows?: number;
  result?: { sha256: string; rows: number; size_bytes: number };
  /** teach mode v2: what this lesson was trained from. A lesson taught before datasets existed reports `id: null`. */
  dataset?: TeachDatasetRef;
  training?: TeachTrainingSpec;
  draft_id?: string; patch_id?: string; publish_status?: string; reject_reason?: string; error?: string; parent_job?: string;
  created_at?: number; updated_at?: number; started_at?: number; finished_at?: number; expires_at?: number;
}
export interface TeacherProfile {
  address: string; name?: string; hidden?: boolean;
  lessons: { id: string; name: string; status: string; verified: boolean; downloads: number; revenue: string; created_at?: number; attestations?: number; quorum?: number }[];
  verification?: { quorum: number; peers: number; reachable: number; verifiers: number; self_verifier: boolean };
  ledger?: { kind: 'local' | 'ain'; currency: string };
  earnings: { currency?: string; owed: string; paid: string; pending: string; failed?: string; sales?: number; items?: unknown[] };
}
export type TeachStatusResult =
  | { kind: 'node'; node: string; info: { name?: string; accepts_contributions?: boolean; contributor_share?: number; model?: string | null }; policy: TeachPolicy; mine?: TeachJobView[] }
  | { kind: 'job'; node: string; job: TeachJobView; owner: boolean }
  | { kind: 'teacher'; node: string; profile: TeacherProfile };

const STATUS_COPY: Record<string, string> = {
  QUEUED: 'waiting for the trainer', PREFLIGHT: 'checking the model still gets it wrong', LOADING: 'warming up', TRAINING: 'training',
  EXPORTED: 'trained — waiting for the side-effect check', CHECKING: 'checking side effects on the live model', READY: 'ready — try it, keep it private or publish it',
  NEEDS_MORE: 'did not stick well enough — improve and retry', FAILED: 'failed', CANCELLED: 'cancelled', EXPIRED: 'expired (unsaved lesson removed)',
  PENDING_REVIEW: 'published — waiting for the operator\'s review', REJECTED: 'declined by the operator', ANNOUNCED: 'published (verifiers are attesting)',
};
const statusColor = (s: string) => (['READY', 'ANNOUNCED'].includes(s) ? c.ok(s) : ['FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'NEEDS_MORE'].includes(s) ? c.err(s) : c.warn(s));
const fmtDur = (s: number | null | undefined) => (s === null || s === undefined ? '-' : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
const pct = (x: number) => `${Math.round(x * 100)} %`;

export async function teachStatus(ctx: CliContext, target: string | undefined, opts: KeyOpts = {}): Promise<TeachStatusResult> {
  const t = parseTeachTarget(target, ctx.nodeUrl);
  const key = loadTeacherKeyFor(ctx, opts);
  const client = new NodeClient({ ...ctx, nodeUrl: t.nodeUrl });
  const nodeAddress = key ? await nodeAddressOf(client) : null;
  const signed = (path: string) => (key && nodeAddress ? { 'x-ainize-auth': signedTeachHeader(key, nodeAddress, 'GET', path) } : undefined);
  let out: TeachStatusResult;
  if (t.kind === 'node') {
    const raw = await client.get<{ node?: { name?: string }; name?: string; accepts_contributions?: boolean; contributor_share?: number; model?: string | null }>('/api/info', { auth: false });
    const info = { name: raw.node?.name ?? raw.name, accepts_contributions: raw.accepts_contributions, contributor_share: raw.contributor_share, model: raw.model };
    const policy = await client.get<TeachPolicy>('/api/teach/policy', { auth: false });
    out = { kind: 'node', node: t.nodeUrl, info, policy };
    if (key && policy.enabled) {
      try { out.mine = (await client.get<{ items: TeachJobView[] }>('/api/teach/jobs', { headers: signed('/api/teach/jobs'), auth: false })).items; } catch { /* banned / disabled — the policy line already says so */ }
    }
  } else if (t.kind === 'job') {
    const path = `/api/teach/jobs/${encodeURIComponent(t.id)}`;
    const r = await client.get<{ job: TeachJobView }>(path, { headers: signed(path), auth: false });
    out = { kind: 'job', node: t.nodeUrl, job: r.job, owner: Array.isArray(r.job.facts) };
  } else {
    const profile = await client.get<TeacherProfile>(`/api/teacher/${t.address}`, { auth: false });
    out = { kind: 'teacher', node: t.nodeUrl, profile };
  }
  emit(ctx, out, renderTeachStatus);
  return out;
}

/**
 * What a lesson is waiting for, in one phrase (item 245). The node knows; `--wait` printed the status and not this,
 * so a 3 a.m. bake against a model server that was off looked identical to one that was simply slow.
 */
export function blockedText(blocked: string): string {
  if (blocked === 'slot') return 'the trainer GPUs (another job or training run holds them)';
  if (blocked === 'lock') return 'the shared model server (busy with another test)';
  if (blocked === 'runtime') return 'the model server (it is off right now)';
  return blocked;
}

/**
 * The id a lesson produced, and what that id IS (item 184).
 *
 * The column was titled `PUBLISHED AS` and printed the PRIVATE draft id of a lesson that had published nothing —
 * and `patch get <that id>` answers `patch not found`, because a draft is invisible to everyone but the operator.
 * So the column says which of the two it is, and never calls a private draft "published".
 */
export function knowledgeCell(j: { patch_id?: string; draft_id?: string; publish_status?: string }): string {
  if (j.patch_id) {
    const what = j.publish_status === 'listed' ? c.ok('(listed)') : j.publish_status === 'announced' ? c.warn('(verifying)') : c.dim(`(${j.publish_status ?? 'published'})`);
    return `${j.patch_id} ${what}`;
  }
  if (j.draft_id) {
    const what = j.publish_status === 'pending_review' ? '(private · sent for review)' : j.publish_status === 'rejected' ? '(private · the operator declined it)' : '(private)';
    return `${c.dim(j.draft_id)} ${c.warn(what)}`;
  }
  return c.dim('-');
}

/** The sentence under a lesson table that has private drafts in it: their ids do not resolve anywhere else. */
export function privateDraftNote<T extends { patch_id?: string; draft_id?: string }>(rows: T[]): string {
  return rows.some((j) => !j.patch_id && j.draft_id)
    ? c.dim(`(private) = a draft on this node only: it is not on the record, and \`${PROG} patch get <id>\` cannot see it. `
      + `${PROG} teach status <lesson-id> shows it; ${PROG} teach publish <lesson-id> publishes it.`)
    : '';
}

export function renderTeachStatus(r: TeachStatusResult): string {
  if (r.kind === 'node') {
    const p = r.policy;
    const lines = [
      c.bold(`Teaching on ${r.info.name ?? r.node}`) + '  ' + (p.enabled ? c.ok('accepting lessons') : c.err('not accepting lessons')) + c.dim(`  ${r.node}`),
      kv([
        ['trainer', `${p.trainer === 'ready' ? c.ok('ready') : p.trainer === 'busy' ? c.warn('busy') : c.err('paused')}${p.paused_reason ? ` — ${p.paused_reason}` : ''} · backend ${p.backend}${p.backend === 'stub' ? c.dim(' (no GPU training on this node)') : ''}`],
        ['publish', p.publish === 'auto' ? 'auto — published lessons are announced at once' : p.publish === 'review' ? 'review — the operator approves each lesson first' : 'never — lessons stay private (try / keep / download only)'],
        ['queue', `${p.queue.depth} / ${p.queue.max} lessons${p.queue.queued_rows !== undefined ? ` · ${p.queue.queued_rows} / ${p.queue.queued_rows_max} questions waiting` : ''}${p.queue.position_eta_s !== null && p.queue.position_eta_s !== undefined ? ` · next lesson ≈ ${fmtDur(p.queue.position_eta_s)}` : ''}`],
        ['typical lesson', p.timing.simulated ? c.dim('not timed — this node simulates training (backend stub), so no duration here would be real')
          : p.timing.p50_s === null ? c.dim(`no measurement yet (${p.timing.samples} of 3 lessons measured)`)
            : `${fmtDur(p.timing.p50_s)} (p50) · ${fmtDur(p.timing.p90_s)} (p90) · ${p.timing.samples} measured${p.timing.s_per_row_p50 ? ` · ≈ ${p.timing.s_per_row_p50.toFixed(2)} s per question per pass` : ''}`],
        ['limits', `${p.limits.rows_per_job ?? p.limits.facts_per_job} questions per lesson${p.limits.rows_per_job_source ? c.dim(` (${p.limits.rows_per_job_source})`) : ''} · ${p.limits.jobs_per_key_per_day} lessons per key and ${p.limits.jobs_per_ip_per_day} per IP a day · prompt ≤ ${p.limits.prompt_max} / answer ≤ ${p.limits.answer_max} chars`],
        ...(p.limits.dataset_max_rows !== undefined
          ? [['datasets', `up to ${p.limits.dataset_max_rows.toLocaleString('en-US')} questions per file · files ≤ ${fmtBytes(p.limits.dataset_max_bytes)} · ${(p.limits.formats ?? []).join(' ')} · ${p.limits.datasets_per_key_per_day} uploads and ${p.limits.rows_per_key_per_day?.toLocaleString('en-US')} trained questions per key a day · kept ${p.limits.dataset_ttl_days} days`] as [string, unknown]]
          : []),
        ...(p.effort?.length ? [['effort', p.effort.map((e) => `${e.id} (${e.max_steps} passes)`).join(' · ')] as [string, unknown]] : []),
        ['data-provider share', `${pct(p.shares.contributor)} of the node's share of each sale (lineage pool ${pct(p.shares.lineage)})`],
        // item 298: publishing here is only worth doing if something can attest it — self-attestation never counts
        ...(p.verification ? [['verifiers reachable', p.verification.verifiers >= p.verification.quorum
          ? c.ok(`${p.verification.verifiers} of ${p.verification.quorum} needed`) + c.dim(`  (${p.verification.reachable} of ${p.verification.peers} peers answered)`)
          : c.err(`${p.verification.verifiers} of ${p.verification.quorum} needed`) + ` — a lesson published here goes on the record but cannot be sold until verifier nodes appear${p.verification.self_verifier ? c.dim(' (this node verifies, but its own attestation does not count towards quorum)') : ''}`] as [string, unknown]] : []),
        // item 299: a price on a local-ledger node is credit this node mints, and no wallet can spend it
        ...(p.ledger ? [['settles in', p.ledger.kind === 'local' ? c.warn(`${p.ledger.currency} on this node's own ledger`) + ' — development play money, not withdrawable' : `${p.ledger.currency} transfers on the AIN chain`] as [string, unknown]] : []),
        ['model', p.model.id_M ?? c.dim('model server off')], ['always loaded', p.applied.length ? p.applied.join(', ') : c.dim('nothing pinned')],
        ['unsaved lessons kept', `${p.draft_ttl_days} days`],
      ]),
    ];
    if (r.mine) {
      lines.push('', c.head('your lessons on this node'), table(r.mine, [
        { key: 'id', title: 'LESSON', get: (j) => c.id(j.id) }, { key: 'n', title: 'NAME', get: (j) => j.name ?? j.facts?.[0]?.prompt.slice(0, 40) ?? '-' },
        { key: 's', title: 'STATUS', get: (j) => statusColor(j.status) }, { key: 'p', title: 'KNOWLEDGE', get: knowledgeCell },
        { key: 't', title: 'UPDATED', get: (j) => fmtTime(j.updated_at) },
      ], 'none yet'));
      const note = privateDraftNote(r.mine);
      if (note) lines.push(note);
    }
    lines.push('', c.dim([
      `teach from a file:  ${PROG} teach dataset ./questions.csv --train      (or ${r.node}/teach/upload)`,
      `teach in chat:      ${r.node}/chat?teach=1`,
    ].join('\n')));
    return lines.join('\n');
  }
  if (r.kind === 'job') {
    const j = r.job;
    const lines = [c.bold(j.name ?? `Lesson ${j.id}`) + '  ' + statusColor(j.status) + c.dim(`  — ${STATUS_COPY[j.status] ?? ''}`)];
    const pairs: [string, unknown][] = [['lesson', j.id], ['node', r.node]];
    if (j.position !== undefined) pairs.push(['queue position', `${j.position} ahead${j.eta_s ? ` · ≈ ${fmtDur(j.eta_s)}` : ''}`]);
    if (j.blocked) pairs.push(['waiting for', blockedText(j.blocked) + (j.blocked_by
      ? ` — held by ${j.blocked_by.label} for ${fmtDur(Math.round((Date.now() - j.blocked_by.since) / 1000))}; this lesson has waited ${fmtDur(j.blocked_by.waited_s)}`
        + (j.blocked_by.grace_left_s > 0 ? `, and is saved unchecked in ${fmtDur(j.blocked_by.grace_left_s)} if the model stays busy` : ', and the wait is over')
      : '')]);
    if (!r.owner) {
      lines.push(kv(pairs), c.dim('status only — pass your teaching key (--key-file <backup.json>) to see the lesson body'));
      return lines.join('\n');
    }
    if (j.contributor) pairs.push(['taught by', `${j.contributor.name ?? ''} ${shortAddr(j.contributor.address, 6)}`.trim()]);
    if (j.context_patch_ids?.length) pairs.push(['taught with', `${j.context_patch_ids.join(', ')}${j.builds_on_context ? ' (builds on them)' : ''}`]);
    // design §13: one line that says what this lesson is built on and what it did to it
    if (j.bases?.length) {
      const direct = j.bases[j.bases.length - 1];
      const name = direct.name ?? direct.patch_id;
      const pc = j.checks?.parent_check?.find((x) => x.patch_id === direct.patch_id);
      const bits = [
        `${name}${j.export ? ` (${j.export === 'delta' ? 'add-on — buyers need it too' : 'stand-alone build'})` : ''}`,
        `adds ${(j.facts?.length ?? 0) - (j.changed_rows ?? 0)}`,
        ...(j.changed_rows ? [`changes ${j.changed_rows} of its answers`] : []),
        ...(j.inherited_rows ? [`keeps ${j.inherited_rows} of its questions`] : []),
        ...(pc && pc.total ? [`${name} still answers ${pc.hit}/${pc.total} with the lesson on top`] : []),
        ...(j.checks?.reversibility_ok === true ? ['reversible: yes'] : j.checks?.reversibility_ok === false ? [c.err('reversible: no')] : []),
      ];
      pairs.push(['built on', bits.join(' · ')]);
      if (j.bases.length > 1) pairs.push(['  loaded under it', j.bases.slice(0, -1).map((b) => b.patch_id).join(' → ')]);
      const stale = j.bases.filter((b) => b.status && !['LISTED', 'ANNOUNCED', 'VERIFYING'].includes(b.status));
      if (stale.length) pairs.push(['  not published yet', `${stale.map((b) => `${b.patch_id} (${b.status})`).join(', ')} — publish it first, or this lesson cannot be published on top of it`]);
    }
    if (j.dataset) {
      const d = j.dataset;
      const what = d.id === null
        ? `${d.rows} questions kept with the lesson ${c.dim('(taught before datasets existed — one is written on the first download or re-train)')}`
        : `${d.name ?? d.id} · trained ${d.trained_rows} of ${d.rows} questions${d.revision ? ` · revision ${d.revision}` : ''}${d.sha256 ? ` · ${shortHash(d.sha256, 12)}` : ''}${d.deleted ? c.err(' · deleted by its owner') : ''}`;
      pairs.push(['dataset', what]);
      if (d.id && !d.deleted) pairs.push(['  its questions', c.dim(`${PROG} teach dataset get ${d.id} -o questions.jsonl`)]);
      if (d.sampled) pairs.push(['  checked', `${d.sampled.checked} of ${d.sampled.of} questions were re-asked on the live model (a sample — not the whole dataset)`]);
    }
    if (j.training) {
      const t = j.training;
      pairs.push(['effort', `${t.effort} · ${t.max_steps} passes, evaluated every ${t.eval_every}${t.use_alt ? ' · another wording trained too' : ''}${t.check_side_effects === false ? c.warn(' · side-effect check OFF') : ''}`]);
    }
    if (j.progress) {
      const g = j.progress;
      pairs.push(['progress', `${g.phase ? `${g.phase}: ` : ''}step ${g.step}/${g.max_steps} · ${g.hits}/${g.total} sentences right${g.eval_sample ? ` (a sample of ${g.eval_sample.n} of ${g.eval_sample.of} questions)` : ''}${g.loss !== undefined ? ` · loss ${g.loss.toFixed(3)}` : ''}${g.elapsed_s ? ` · ${fmtDur(g.elapsed_s)} so far` : ''}`]);
    }
    if (j.result) pairs.push(['knowledge file', `${j.result.rows.toLocaleString('en-US')} rows · ${fmtBytes(j.result.size_bytes)} · sha256 ${shortHash(j.result.sha256, 16)}`]);
    if (j.checks) {
      const k = j.checks;
      /*
       * Item 239 — `checks.ok` is the SIDE-EFFECT check (locality && parent_regression), and it is computed
       * independently of whether the lesson stuck. A bake that taught 0 of 18 sentences printed a green
       * `checks  passed` above a line reading `taught 0/18`, so the label now says which check it is, and whether the
       * LESSON worked is stated first, in its own line, with the status that decided it.
       */
      if (k.executed) {
        /*
         * Item 180 — one lesson had two denominators. "taught 0/2 trained sentences" counts PROBES (the head of the
         * sample is asked twice), "1 of 2 questions" counts questions, and nobody could reconcile them. Questions is
         * the unit every screen and every command names, so it is the one stated here; the probe count keeps its own
         * line below. And the questions that never made it into the lesson are named, not silently missing.
         */
        const q = k.taught.questions;
        const ratio = q ? `${q.hits} of ${q.total} questions` : `${k.taught.hits}/${k.taught.total} trained sentences`;
        const dropped = j.preflight?.dropped ?? [];
        const droppedNote = dropped.length ? c.dim(`  (${dropped.length} of ${j.preflight?.of ?? '?'} never trained — see below)`) : '';
        pairs.push(['lesson', (j.status === 'READY'
          ? c.ok(`learned — ${ratio} answer right in the live model`)
          : c.err(`did not stick — ${ratio} answer right (${j.status})`)) + droppedNote]);
      }
      pairs.push(['side-effect check', !k.executed ? c.warn('not measured (model server was off) — ask the node to check again') : k.ok ? c.ok('passed') + c.dim(' — it did not change unrelated answers') : c.err('failed')]);
      if (k.executed) {
        pairs.push(['  taught', `${k.taught.hits}/${k.taught.total} trained sentences answer right${k.taught.sampled ? ` (a sample of ${k.taught.sampled.checked} of ${k.taught.sampled.of} questions)` : ''}${k.heldout?.total ? ` · other phrasings ${k.heldout.hits}/${k.heldout.total}` : ''}`]);
        pairs.push(['  side effects', `${k.locality.same}/${k.locality.total} unrelated answers unchanged ${k.locality.ok ? c.ok('✓') : c.err('✗')}`]);
        /*
         * Item 182 — this line was printed only when `total > 0`, and the stub sets it to 0, so on every demo node
         * the base was never named and "checks passed" appeared with the base-regression check silently skipped.
         * The line is printed whenever the lesson HAS a base; when nothing was measured it says so.
         */
        if (k.parent_regression.total) pairs.push(['  parents', `${k.parent_regression.hit}/${k.parent_regression.total} still right ${k.parent_regression.ok ? c.ok('✓') : c.err('✗')}`]);
        else if (j.bases?.length || j.context_patch_ids?.length) {
          const names = (j.bases ?? []).map((b) => b.name ?? b.patch_id).join(', ') || (j.context_patch_ids ?? []).join(', ');
          pairs.push(['  parents', c.warn(`not measured on this node — nothing checked whether ${names} still answers its own questions${k.simulated ? ' (this node simulates its checks)' : ''}`)]);
        }
        if (k.reverted_and_reapplied) pairs.push(['  note', 'the model server restarted during the check; the lesson was re-applied']);
      }
      if (k.simulated && !k.note) pairs.push(['  note', c.warn('simulated — this node has no model server, so nothing was measured on a live model')]);
      if (k.skipped) pairs.push(['  note', c.warn('you turned the side-effect check off — publishing stays blocked until it is measured (`teach status` again after a recheck)')]);
      if (k.note) pairs.push(['  note', k.note]);
    }
    if (j.draft_id) pairs.push(['private draft', j.draft_id]);
    if (j.patch_id) pairs.push(['published as', `${j.patch_id} (${j.publish_status})`]);
    if (j.reject_reason) pairs.push(['declined because', j.reject_reason]);
    if (j.error) pairs.push(['error', c.err(j.error)]);
    if (j.parent_job) pairs.push(['retry of', j.parent_job]);
    pairs.push(['created', fmtTime(j.created_at)]);
    if (j.finished_at) pairs.push(['finished', fmtTime(j.finished_at)]);
    if (j.expires_at && !j.patch_id) pairs.push(['kept until', fmtTime(j.expires_at)]);
    lines.push(kv(pairs));
    if (j.facts?.length) {
      lines.push('', c.head('corrections'), table(j.facts, [
        { key: 'q', title: 'QUESTION', get: (f) => f.prompt.slice(0, 48) }, { key: 'a', title: 'RIGHT ANSWER', get: (f) => f.answer.slice(0, 24) },
        { key: 'b', title: 'BEFORE', get: (f) => (f.base_answer ?? '-').replace(/\s+/g, ' ').slice(0, 28) }, { key: 'af', title: 'AFTER', get: (f) => (f.after_answer ?? '-').replace(/\s+/g, ' ').slice(0, 28) },
        { key: 'h', title: 'HIT', get: (f) => (f.hit === undefined ? c.dim('-') : f.hit ? c.ok('✓') : c.err('✗')) },
      ]));
    }
    /*
     * Items 180 / 181 — the questions that never made it into the lesson.
     *
     * `overlapsListing` and the pre-flight drop a row whose question is already answered, and the job stored only
     * counts: `preflight: {checked 2, of 2, known 0, overlaps 1}`. "trained 1 of 2 questions" was the whole
     * explanation, and the publisher could not tell WHICH row vanished without diffing files. Worse, the pre-flight
     * had ASKED the model each of them and had its answer — that is how it decided — and threw it away, so the first
     * step of every derivative ("what does the base already cover?") meant re-asking each question by hand in chat.
     */
    const dropped = j.preflight?.dropped ?? [];
    if (dropped.length) {
      const why = (d: { reason: string; listing_id?: string; listing_name?: string }) =>
        d.reason === 'already_known' ? c.dim('the model already answers this')
          : d.reason === 'in_base' ? c.dim(`already in ${d.listing_name ?? d.listing_id ?? 'the base'}`)
            : c.warn(`already sold here as ${d.listing_name ?? d.listing_id ?? 'another knowledge'}`);
      lines.push('', c.head(`not trained — ${dropped.length} of ${j.preflight?.of ?? dropped.length} question(s)`), table(dropped, [
        { key: 'l', title: 'LINE', get: (d) => String(d.index + 1), align: 'right' },
        { key: 'q', title: 'QUESTION', get: (d) => d.prompt.replace(/\s+/g, ' ').slice(0, 48) },
        { key: 'b', title: 'ANSWER ALREADY THERE', get: (d) => (d.base_answer ?? '-').replace(/\s+/g, ' ').slice(0, 34) },
        { key: 'w', title: 'WHY', get: why },
      ]));
      lines.push(c.dim('these questions were left out before training. Change the answer you want and train them again, or take them out of the file.'));
    }
    if (j.patch_id) lines.push('', c.dim(`knowledge page: ${r.node}/patch/${j.patch_id} · ainize patch get ${j.patch_id}`));
    else if (j.status === 'READY') lines.push('', c.dim([
      `publish it from here: ${PROG} teach publish ${j.id} --name "<name>" --price <n> --consent-permanent --consent-rights`,
      `or in the browser:    ${r.node}/teach/lesson/${j.id}  (try it, keep it private, publish it)`,
      ...(j.dataset?.id && !j.dataset.deleted ? [`train the same questions harder: ${PROG} teach train ${j.dataset.id} --effort thorough`] : []),
    ].join('\n')));
    return lines.join('\n');
  }
  const p = r.profile;
  const e = p.earnings;
  const cur = e.currency ? ` ${e.currency}` : '';
  const v = p.verification;
  const lines = [
    c.bold(`Data provider ${p.name ?? ''}`.trim()) + '  ' + c.dim(p.address) + (p.hidden ? c.dim('  (name hidden by the operator)') : ''),
    kv([['node', r.node], ['lessons', String(p.lessons.length)], ['earned', `${e.owed}${cur}${e.sales !== undefined ? ` from ${e.sales} sales` : ''}`],
      // item 299: on a local ledger "paid out" is a line in this node's own book — say so where the number is
      ['paid out', `${e.paid}${cur}${p.ledger?.kind === 'local' ? c.dim(' — credited on this node only, not withdrawable') : ''}`],
      ['pending', `${e.pending}${cur}`], ...(e.failed && e.failed !== '0' ? [['transfer failed', `${e.failed}${cur} (still owed by the seller)`] as [string, unknown]] : [])]),
    '', c.head('lessons'), table(p.lessons, [
      { key: 'id', title: 'KNOWLEDGE', get: (l) => c.id(l.id) }, { key: 'n', title: 'NAME', get: (l) => l.name.slice(0, 40) },
      { key: 's', title: 'STATUS', get: (l) => statusColor(l.status) },
      // item 298: "not yet" said nothing about how long, or whether anyone can ever look
      { key: 'v', title: 'VERIFIED', get: (l) => (l.verified ? c.ok('yes')
        : l.attestations !== undefined ? c.dim(`${l.attestations}/${l.quorum ?? v?.quorum ?? 2}${l.created_at ? ` · waiting ${fmtDur((Date.now() - l.created_at) / 1000)}` : ''}`)
          : c.dim('not yet')) },
      { key: 'd', title: 'SOLD', get: (l) => String(l.downloads), align: 'right' }, { key: 'r', title: 'REVENUE', get: (l) => `${l.revenue}${cur}`, align: 'right' },
    ], 'no lessons yet'),
  ];
  if (v && v.verifiers < v.quorum) {
    lines.push('', c.warn('! ') + `${r.node} has ${v.verifiers} verifier peer(s) and needs ${v.quorum}: knowledge published here stays on the record but cannot go on sale until verifier nodes appear.`);
  }
  lines.push('', c.dim(`public page: ${r.node}/teacher/${p.address}`));
  return lines.join('\n');
}
