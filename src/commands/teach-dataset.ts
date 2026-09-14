/**
 * `ainize teach dataset …` / `ainize teach train …` / `ainize teach jobs` — the FILE door of teach mode from the
 * terminal (design docs/teachable-dataset-design.md §7.4).
 *
 * One pipeline, two doors: the browser collects corrections in chat and freezes them into a dataset file; here you
 * hand the node a dataset file directly. Both produce the same dataset object and the same lesson, so a lesson
 * taught in either door can be downloaded, re-trained or continued from its dataset.
 *
 *   ainize teach dataset ./questions.csv --train        # validate + upload, then train it
 *   ainize teach train <dataset-id> --effort thorough   # train the same questions again
 *   ainize teach jobs                                   # my lessons on this node, with the dataset each came from
 *   ainize teach dataset get <id> -o questions.jsonl    # exactly what a lesson was trained on
 *
 * Every request is signed with a teaching key (§6.1). There is no account: the key is the identity. `--key-file`
 * (the browser's backup JSON) or `--key` / `AINIZE_TEACH_KEY` chooses one; otherwise the CLI keeps one at
 * `<AINIZE_HOME>/teaching-key.json` and creates it on first use — losing that file loses the lessons and earnings.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createIdentity, signMessage, type TeachDataset, type TeachDatasetRow, type TeachDatasetSummary, type TeachEffort } from '@ainize/core';
import { NodeClient, query } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, fmtBytes, fmtTime, info, kv, shortHash, table, warn } from '../output.js';
import { blockedText, knowledgeCell, loadTeacherKeyFor, nodeAddressOf, parseTeacherKey, privateDraftNote, renderTeachStatus, signedTeachHeader, TEACH_KEY_FILE, type KeyOpts, type TeachJobView, type TeacherKey } from './teach.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- response shapes (server: packages/node/src/teach-datasets.ts)
export interface DatasetReport { summary: TeachDatasetSummary; rows: TeachDatasetRow[] }
export interface DatasetResult { dataset: TeachDataset; report: DatasetReport; created: boolean }
export interface DatasetRowsPage { total: number; source_rows: number; offset: number; limit: number; summary: TeachDatasetSummary; items: TeachDatasetRow[] }
export interface CreateJobResult { job: TeachJobView; quota?: { key_remaining?: number; ip_remaining?: number; rows_remaining?: number; rows_ip_remaining?: number } }

export interface ParseOpts { format?: string; delimiter?: string; header?: boolean; columns?: string; encoding?: string; layout?: string }
export interface TrainOpts { effort?: TeachEffort; check?: boolean; alt?: boolean; rows?: number; name?: string; patch?: string; wait?: boolean;
  /** `--timeout <minutes>`: how long `--wait` waits before giving up with exit 7 (default 60). */
  timeout?: number;
  /** `--on <id>`: the knowledge this lesson is trained ON TOP OF (design §13). Distinct from `--patch`, which only loads for comparison. */
  on?: string;
  /** `--no-inherit`: check against the base, but do not train its questions as known answers. */
  inherit?: boolean;
  /** `--yes-change`: these answers are meant to replace the base's (design §12.1 `base_unresolved_conflicts`). */
  yesChange?: boolean }
export interface DatasetOpts extends KeyOpts, ParseOpts { name?: string; retention?: 'keep' | 'delete_after_training' }

// ---------------------------------------------------------------- teaching key
/**
 * The teaching key for this terminal: `--key-file` / `--key` / `AINIZE_TEACH_KEY`, else `<home>/teaching-key.json`,
 * created (0600) on first use. `created` is true only when this call wrote the file — the caller says so out loud,
 * because that file is the ONLY way back to the lessons and the earnings.
 */
export function ensureTeacherKey(ctx: CliContext, o: KeyOpts = {}): { key: TeacherKey; path: string | null; created: boolean } {
  const existing = loadTeacherKeyFor(ctx, o);
  const path = join(ctx.home, TEACH_KEY_FILE);
  if (existing) return { key: existing, path: o.keyFile ?? (existsSync(path) ? path : null), created: false };
  const id = createIdentity();
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(path, JSON.stringify({ kind: 'ainize-teaching-key', version: 1, privateKey: id.privateKey, address: id.address, created_at: Date.now() }, null, 2) + '\n', { mode: 0o600 });
  return { key: parseTeacherKey(readFileSync(path, 'utf8')), path, created: true };
}

/** A node client that signs every teach request with the key (request-bound v2 header, one per request). */
export class TeachSession {
  private constructor(readonly client: NodeClient, readonly key: TeacherKey, readonly nodeAddress: string) {}

  static async open(ctx: CliContext, o: KeyOpts = {}): Promise<TeachSession> {
    const client = new NodeClient(ctx);
    const { key, path, created } = ensureTeacherKey(ctx, o);
    const nodeAddress = await nodeAddressOf(client);
    if (created && path && !ctx.quiet && !ctx.json) {
      process.stderr.write(c.warn('! ') + `new teaching key ${key.address} — kept in ${path}. Back it up: it is the only way back to these lessons and their earnings.\n`);
    }
    return new TeachSession(client, key, nodeAddress);
  }

  private hdr(method: string, path: string, body?: string): Record<string, string> {
    return { 'x-ainize-auth': signedTeachHeader(this.key, this.nodeAddress, method, path, body) };
  }
  get<T>(path: string): Promise<T> { return this.client.get<T>(path, { headers: this.hdr('GET', path), auth: false }); }
  post<T>(path: string, body?: unknown): Promise<T> {
    const payload = body ?? {};
    return this.client.request<T>(path, { method: 'POST', body: payload, headers: this.hdr('POST', path, JSON.stringify(payload)), auth: false });
  }
  del<T>(path: string): Promise<T> { return this.client.request<T>(path, { method: 'DELETE', headers: this.hdr('DELETE', path), auth: false }); }
  /** Raw (non-JSON) GET — the dataset download. */
  raw(path: string): Promise<Response> { return this.client.get<Response>(path, { headers: this.hdr('GET', path), auth: false, raw: true }); }
  /** Multipart upload: the v2 signature covers the sha256 header value, not the body (design §D14). */
  upload<T>(path: string, form: FormData, fileSha: string): Promise<T> {
    return this.client.request<T>(path, {
      method: 'POST', body: form, timeoutMs: 300_000,
      headers: { ...this.hdr('POST', path, fileSha), 'x-ainize-dataset-sha256': fileSha }, auth: false,
    });
  }
}

// ---------------------------------------------------------------- rendering
/** What the visitor is told about one source line. Only `ok` / `fixed` are trained. */
const ROW_COPY: Record<string, string> = {
  ok: 'will train', fixed: 'will train (tidied up)', duplicate: 'same as an earlier line', conflict: 'two answers — pick one',
  too_long: 'too long', empty: 'no question or no answer', blocked: 'not allowed on this node', not_parsed: 'could not be read',
  over_cap: 'over this node\'s per-dataset limit',
};
const rowColor = (s: string) => (s === 'ok' ? c.ok(s) : s === 'fixed' || s === 'pii' ? c.warn(s) : c.err(s));

export function renderSummary(s: TeachDatasetSummary): string {
  const bad: string[] = [];
  const add = (n: number, w: string) => { if (n) bad.push(`${n} ${w}`); };
  add(s.duplicates, 'duplicate'); add(s.conflicts, 'contradicting'); add(s.too_long, 'too long'); add(s.empty, 'empty');
  add(s.blocked, 'not allowed'); add(s.not_parsed, 'unreadable'); add(s.over_cap, 'over the limit');
  const head = `${s.accepted} of ${s.source_rows} lines will train${s.fixed ? ` (${s.fixed} tidied up)` : ''}`;
  const pii = s.pii ? ` · ${s.pii} look like personal information (they train; the training set cannot be published above "private" until they are removed)` : '';
  return (bad.length ? `${head} · not used: ${bad.join(', ')}` : head) + pii;
}

/** The per-line problems — every line that will NOT train, with its source line number and the reason. */
export function renderRows(rows: TeachDatasetRow[], opts: { all?: boolean; positions?: boolean } = {}): string {
  // `pii` rows train, but they are shown with the problems: the owner has to remove them before the set can be shared
  const shown = opts.all ? rows : rows.filter((r) => r.status !== 'ok' && r.status !== 'fixed');
  if (!shown.length) return c.dim(opts.all ? '(no questions)' : 'every line will train');
  // item 5: after an edit the accepted rows are numbered by position, but a CARRIED row still points at the line of
  // the uploaded file it came from. Marking it is the difference between two different sevens and one.
  const carried = shown.some((r) => r.carried);
  const out = table(shown, [
    // after an edit the dataset was rewritten: these are positions in it, not lines of the file that was uploaded
    { key: 'l', title: opts.positions ? '#' : 'LINE', get: (r) => `${r.line}${r.carried ? '*' : ''}`, align: 'right' },
    { key: 's', title: 'STATUS', get: (r) => rowColor(r.status) },
    { key: 'q', title: 'QUESTION', get: (r) => (r.prompt ?? r.raw ?? '').replace(/\s+/g, ' ').slice(0, 36) },
    { key: 'w', title: 'WHY', get: (r) => (r.detail ?? (r.fixes?.length ? `tidied up: ${r.fixes.join(', ')}` : ROW_COPY[r.status] ?? r.status)).slice(0, 60) },
  ]);
  return carried && opts.positions
    ? `${out}\n${c.dim('* a line of the file you uploaded, left out when it was read and not resolved by your edits since')}`
    : out;
}

export function renderDataset(d: TeachDataset, node: string): string {
  const file = [d.source_name, d.format, d.delimiter ? `separator ${JSON.stringify(d.delimiter)}` : '', d.has_header ? 'header row' : d.has_header === false ? 'no header row' : '', d.encoding, d.layout].filter(Boolean).join(' · ');
  const pairs: [string, unknown][] = [
    ['dataset', c.id(d.id)],
    ['questions', `${d.rows.toLocaleString('en-US')} kept${d.invalid_rows ? ` · ${d.invalid_rows} lines not used` : ''}`],
    ['fingerprint', `${shortHash(d.sha256, 16)}  (revision ${d.revision})`],
    ['where it came from', d.source === 'upload' ? `a file you uploaded${file ? ` — ${file}` : ''}` : d.source === 'chat' ? 'corrections you collected in chat' : d.source === 'sample' ? 'an example dataset of this node' : 'the questions of a lesson taught before datasets existed'],
    ['size', `${fmtBytes(d.size_bytes)}${d.source_bytes ? ` (uploaded ${fmtBytes(d.source_bytes)})` : ''}`],
    ['state', d.deleted_at ? c.err('deleted') : d.status === 'in_use' ? c.warn('a lesson is training from it') : d.status === 'staged' ? 'never trained yet' : c.ok('ready')],
    ['kept', d.deleted_at ? `deleted ${fmtTime(d.deleted_at)} — the questions are gone from this node`
      // the sweep already ran: the row survives (name, fingerprint, lessons) but the questions do not
      : d.size_bytes === 0 && d.rows > 0 ? 'the questions were deleted when its lesson finished, as you asked — it cannot be downloaded or trained again'
        : d.retention === 'delete_after_training' ? 'deleted as soon as its lesson finishes' : `until ${fmtTime(d.expires_at)}`],
  ];
  if (d.parent_dataset) pairs.push(['copied from', d.parent_dataset]);
  if (d.job_ids.length) pairs.push(['lessons', d.job_ids.join(', ')]);
  if (d.summary.shared_ending) pairs.push(['heads-up', `${d.summary.shared_ending} questions end the same way — the model may answer them all alike`]);
  return [c.bold(d.name) + c.dim(`  ${node}`), kv(pairs)].join('\n');
}

const nextSteps = (id: string) => c.dim([
  `train it:      ${PROG} teach ${id} --effort balanced`,
  `see it:        ${PROG} teach dataset get ${id}`,
  `download it:   ${PROG} teach dataset get ${id} -o questions.jsonl`,
].join('\n'));

// ---------------------------------------------------------------- teach dataset <file>
export interface DatasetUploadResult extends DatasetResult { node: string; file: string; bytes: number; sha256: string; job?: CreateJobResult;
  /** `--train --wait`: the lesson in `job` is the finished one, and the exit code is its outcome (item 252). */
  waited?: boolean }

/** How long `--wait` waits: `--timeout <minutes>`, an hour by default. */
export function waitMs(opts: TrainOpts): number {
  const m = opts.timeout;
  if (m === undefined) return 60 * 60_000;
  if (!Number.isFinite(m) || m <= 0) throw new CliError('--timeout is in minutes and must be a positive number');
  return Math.round(m * 60_000);
}

/**
 * Validate a dataset file and upload it. Nothing is trained here — the node parses the bytes, reports every line it
 * could not use, and keeps the questions as a dataset you can train (`--train`, or `teach train <id>`).
 * Re-uploading the same file returns the SAME dataset (200, `created: false`) instead of a second copy.
 */
export async function datasetUpload(ctx: CliContext, file: string, opts: DatasetOpts & TrainOpts & { train?: boolean; silent?: boolean; nextSteps?: boolean; onUploaded?: (result: DatasetUploadResult) => void; onTrainingSubmitted?: (result: DatasetUploadResult) => void } = {}): Promise<DatasetUploadResult> {
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new CliError(`dataset file not found: ${file}`);
  const bytes = readFileSync(path);
  if (!bytes.length) throw new CliError(`${basename(path)} is empty — a dataset needs at least one question and its answer`);
  const s = await TeachSession.open(ctx, opts);
  const fileSha = sha256(bytes);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), basename(path));
  const put = (k: string, v: string | undefined) => { if (v !== undefined) form.append(k, v); };
  put('name', opts.name);
  put('retention', opts.retention);
  put('format', opts.format);
  put('delimiter', opts.delimiter);
  put('encoding', opts.encoding);
  put('layout', opts.layout);
  if (opts.header !== undefined) form.append('has_header', String(opts.header));
  if (opts.columns) {
    try { JSON.parse(opts.columns); } catch { throw new CliError('--columns must be JSON, e.g. \'{"prompt":0,"answer":2}\' or \'{"prompt":"질문","answer":"답"}\''); }
    form.append('columns', opts.columns);
  }

  const r = await s.upload<DatasetResult>('/api/teach/datasets', form, fileSha).catch((e: unknown) => { throw withReport(e, ctx); });
  const out: DatasetUploadResult = { ...r, node: s.client.baseUrl, file: path, bytes: bytes.length, sha256: fileSha };
  opts.onUploaded?.(out);
  if (opts.train) {
    out.job = await trainDataset(s, r.dataset.id, opts);
    opts.onTrainingSubmitted?.(out);
    // Item 252: the documented one-liner (`teach dataset ./questions.csv --train`) is the form a cron line reaches
    // for, and it was the one form that could not block on the result — `--wait` existed only on the sibling
    // command, so the first scripted attempt failed with `Unknown argument: wait`. Same wait, same exit codes.
    if (opts.wait) {
      const done = await waitForJob(s, out.job.job.id, ctx, waitMs(opts));
      out.job = { ...out.job, job: done };
      out.waited = true;
      process.exitCode = exitForJob(done);
      if (unchecked(done)) warnUnchecked(ctx, done.id);
    }
  }
  if (!opts.silent) emit(ctx, out, (d) => renderUpload(d, { nextSteps: opts.nextSteps, waited: d.waited }));
  return out;
}

export function renderUpload(r: DatasetUploadResult, opts: { nextSteps?: boolean; waited?: boolean } = {}): string {
  const lines = [
    renderDataset(r.dataset, r.node),
    '',
    (r.created ? c.ok('✓ ') : c.dim('· ')) + (r.created ? `uploaded ${basename(r.file)} (${fmtBytes(r.bytes)})` : `${basename(r.file)} is already on this node — same questions, same dataset, no second copy`),
    renderSummary(r.report.summary),
  ];
  const bad = r.report.rows.filter((x) => x.status !== 'ok' && x.status !== 'fixed');
  if (bad.length) {
    lines.push('', c.head('lines that will not train'), renderRows(r.report.rows));
    if (r.report.rows.length >= 50) lines.push(c.dim(`the first 50 source lines only — the rest: ${PROG} teach dataset get ${r.dataset.id} --rows 200 --all`));
  }
  if (r.job && opts.waited) lines.push('', renderTeachStatus({ kind: 'job', node: r.node, job: r.job.job, owner: true }));
  else if (r.job) lines.push('', renderJobCreated(r.job, r.node));
  else if (opts.nextSteps !== false) lines.push('', nextSteps(r.dataset.id));
  return lines.join('\n');
}

/**
 * A refused upload still carries the per-line report (`dataset_empty` / `dataset_format`): print it, so the terminal
 * says WHICH lines it could not read instead of only that the file was no good (design G3).
 */
function withReport(e: unknown, ctx: CliContext): unknown {
  const err = e as CliError & { details?: { report?: DatasetReport } };
  const report = err?.details?.report;
  if (report?.rows?.length && !ctx.quiet && !ctx.json) {
    process.stderr.write([renderSummary(report.summary), c.head('what the node read'), renderRows(report.rows, { all: true }), ''].join('\n') + '\n');
  }
  return e;
}

// ---------------------------------------------------------------- teach dataset ls
export interface DatasetListResult { node: string; items: TeachDataset[] }

export async function datasetLs(ctx: CliContext, opts: KeyOpts = {}): Promise<DatasetListResult> {
  const s = await TeachSession.open(ctx, opts);
  const r = await s.get<{ items: TeachDataset[] }>('/api/teach/datasets');
  const out = { node: s.client.baseUrl, items: r.items };
  emit(ctx, out, renderDatasetList);
  return out;
}

export function renderDatasetList(r: DatasetListResult): string {
  return [
    c.head(`your datasets on ${r.node}`),
    table(r.items, [
      { key: 'id', title: 'DATASET', get: (d) => c.id(d.id) },
      { key: 'n', title: 'NAME', get: (d) => d.name.slice(0, 32) },
      { key: 'q', title: 'QUESTIONS', get: (d) => String(d.rows), align: 'right' },
      { key: 'r', title: 'REV', get: (d) => String(d.revision), align: 'right' },
      { key: 'f', title: 'FINGERPRINT', get: (d) => shortHash(d.sha256, 10) },
      { key: 'w', title: 'FROM', get: (d) => d.source },
      { key: 'l', title: 'LESSONS', get: (d) => String(d.job_ids.length), align: 'right' },
      { key: 's', title: 'STATE', get: (d) => (d.deleted_at ? c.err('deleted') : d.status === 'in_use' ? c.warn('training') : d.status) },
      { key: 'k', title: 'KEPT UNTIL', get: (d) => fmtTime(d.expires_at) },
    ], 'no datasets yet — upload one: ' + `${PROG} teach dataset ./questions.csv`),
  ].join('\n');
}

// ---------------------------------------------------------------- teach dataset get <id>
export interface DatasetGetResult { node: string; dataset: TeachDataset; page: DatasetRowsPage; saved?: { path: string; bytes: number; sha256: string; verified: boolean } }

/**
 * One dataset: what it is, and every source line with the reason it was or was not used. With `-o` the canonical
 * bytes are written to a file — re-uploading that file lands on the SAME dataset, which is what makes a lesson
 * reproducible from its own questions.
 */
export async function datasetGet(ctx: CliContext, id: string, opts: KeyOpts & { out?: string; format?: 'jsonl' | 'csv'; rows?: number; offset?: number; status?: string; all?: boolean } = {}): Promise<DatasetGetResult> {
  const s = await TeachSession.open(ctx, opts);
  const { dataset } = await s.get<{ dataset: TeachDataset }>(`/api/teach/datasets/${encodeURIComponent(id)}`);
  const page = await s.get<DatasetRowsPage>(`/api/teach/datasets/${encodeURIComponent(id)}/rows${query({ limit: Math.min(200, opts.rows ?? 50), offset: opts.offset, status: opts.status })}`);
  const out: DatasetGetResult = { node: s.client.baseUrl, dataset, page };
  if (opts.out) {
    const format = opts.format ?? 'jsonl';
    const res = await s.raw(`/api/teach/datasets/${encodeURIComponent(id)}/download${query({ format })}`);
    if (!res.ok) throw new CliError(`download failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = Buffer.from(await res.arrayBuffer());
    const expected = format === 'jsonl' ? dataset.sha256 : res.headers.get('x-content-sha256');
    const actual = sha256(body);
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected) || actual !== expected.toLowerCase()) {
      throw new CliError('Dataset download fingerprint missing or mismatched; output file was not written. Inspect the dataset revision and retry the download before using it as training evidence.');
    }
    writeFileSync(resolve(opts.out), body, { mode: 0o600 });
    out.saved = { path: resolve(opts.out), bytes: body.length, sha256: actual, verified: true };
  }
  emit(ctx, out, (d) => renderDatasetGet(d, !!opts.all));
  return out;
}

export function renderDatasetGet(r: DatasetGetResult, all: boolean): string {
  const lines = [renderDataset(r.dataset, r.node)];
  if (r.dataset.deleted_at) {
    lines.push('', c.dim(`it held ${r.dataset.rows} questions; they were deleted, so they can no longer be read, downloaded or re-trained. The lessons trained from it are kept.`));
    return lines.join('\n');
  }
  lines.push('', renderSummary(r.page.summary), '', c.head(all ? 'every line' : 'lines that will not train'), renderRows(r.page.items, { all, positions: r.dataset.revision > 1 }));
  if (r.page.total > r.page.offset + r.page.items.length) lines.push(c.dim(`${r.page.offset + r.page.items.length} of ${r.page.total} lines shown — more with --rows / --offset`));
  if (r.saved) lines.push('', c.ok('✓ ') + `saved ${r.saved.path} (${fmtBytes(r.saved.bytes)})` + (r.saved.verified ? c.dim(' · download fingerprint verified') : ''));
  return lines.join('\n');
}

// ---------------------------------------------------------------- teach dataset rm <id>
export async function datasetRm(ctx: CliContext, id: string, opts: KeyOpts = {}): Promise<{ node: string; deleted: string }> {
  const s = await TeachSession.open(ctx, opts);
  await s.del(`/api/teach/datasets/${encodeURIComponent(id)}`);
  const out = { node: s.client.baseUrl, deleted: id };
  emit(ctx, out, (d) => c.ok('✓ ') + `dataset ${d.deleted} deleted. The lessons trained from it are kept — but they can no longer be re-trained from their questions.`);
  return out;
}

// ---------------------------------------------------------------- patch fork (lineage design §13, Story B)
export interface ForkResult {
  node: string; dataset_id: string; dataset: TeachDataset; created: boolean; inherited_rows: number;
  parent: { patch_id: string; name: string; dataset_sha256: string }; license: string | null;
}

/**
 * `ainize patch fork <id>` — copy a published knowledge's questions into MY training sets, with that knowledge
 * recorded as their parent. The next line is `teach train <dataset> --on <id>`, and the command says so.
 */
export async function patchFork(ctx: CliContext, id: string, opts: KeyOpts & { name?: string } = {}): Promise<ForkResult> {
  const s = await TeachSession.open(ctx, opts);
  const r = await s.post<Omit<ForkResult, 'node'>>(`/api/patches/${encodeURIComponent(id)}/fork`, { ...(opts.name ? { name: opts.name } : {}) });
  const out: ForkResult = { ...r, node: s.client.baseUrl };
  emit(ctx, out, (d) => [
    c.ok('✓ ') + (d.created ? `copied ${d.inherited_rows} question(s) from ${c.id(d.parent.patch_id)} into ${c.id(d.dataset_id)}` : `you already have this copy: ${c.id(d.dataset_id)}`),
    kv([
      ['dataset', `${d.dataset.name} · ${d.dataset.rows} question(s) · ${shortHash(d.dataset.sha256, 12)}`],
      ['from', `${d.parent.name} (${d.parent.patch_id})${d.license ? ` · ${d.license}` : ''}`],
      ['inherited', `${d.inherited_rows} — every one of them points at the question of ${d.parent.patch_id} it came from`],
    ]),
    c.dim(`add your own questions:  ${PROG} teach dataset get ${d.dataset_id} -o questions.jsonl   (edit, then re-upload)`),
    c.dim(`teach on top of it:      ${PROG} teach ${d.dataset_id} --on ${d.parent.patch_id}`),
  ].join('\n'));
  return out;
}

// ---------------------------------------------------------------- teach train
const EFFORTS: TeachEffort[] = ['quick', 'balanced', 'thorough'];

/** Build the job body from the training flags. `check` / `alt` are only sent when the caller actually set them. */
function trainingSpec(opts: TrainOpts): Record<string, unknown> | undefined {
  const spec: Record<string, unknown> = {};
  if (opts.effort) {
    if (!EFFORTS.includes(opts.effort)) throw new CliError(`--effort must be one of ${EFFORTS.join(' | ')}`);
    spec.effort = opts.effort;
  }
  if (opts.check !== undefined) spec.check_side_effects = opts.check;
  if (opts.alt !== undefined) spec.use_alt = opts.alt;
  if (opts.rows !== undefined) {
    if (!Number.isInteger(opts.rows) || opts.rows < 1) throw new CliError('--rows must be a whole number of questions (1 or more)');
    spec.rows_limit = opts.rows;
  }
  return Object.keys(spec).length ? spec : undefined;
}

/**
 * Item 171 — every `--patch` / `--on` id, resolved BEFORE anything is uploaded.
 *
 * The CLI used to create a teaching key, upload the dataset, print "2 of 2 lines will train" and only then post the
 * job, which the node rejected with `invalid: unknown knowledge krx-all-2761` — after the side effect, with a label
 * that reads like an internal validation tag and names no remedy. The refusal now happens before the upload and says
 * which of the two problems it is: this node has never heard of that id, or it is listed here and its file is not.
 */
interface BaseCheck { id: string; name?: string; usable: boolean; reason?: 'not_listed' | 'not_held' | 'not_licensed'; price?: string; currency?: string; status?: string }

async function assertBasesUsable(s: TeachSession, ids: string[]): Promise<void> {
  for (const id of ids) {
    let e: BaseCheck;
    try {
      e = await s.get<BaseCheck>(`/api/teach/bases/${encodeURIComponent(id)}`);
    } catch (err) {
      // an older node has no such route: leave the check to the job post rather than refusing a valid command
      if ((err as CliError).exitCode === 2) throw err;
      if (/^HTTP 404|not found/i.test((err as Error).message)) return;
      throw err;
    }
    if (e.usable) continue;
    // Item 327: the file is here, but only because this node verified it — scoring is not a licence to build on it.
    if (e.reason === 'not_licensed') {
      const price = e.price && Number(e.price) > 0 ? `${e.price} ${e.currency ?? ''}`.trim() : 'free';
      throw new CliError([
        `${e.name ?? id} is on ${s.client.baseUrl}, but this node has not bought it — its file is here because this node verified it, and scoring a knowledge is not a licence to teach on top of it.`,
        `Buy it first: \`${PROG} patch buy ${id}\` (${price}), then run this again.`,
      ].join('\n'), 2);
    }
    if (e.reason === 'not_held') {
      const price = e.price && Number(e.price) > 0 ? `${e.price} ${e.currency ?? ''}`.trim() : 'free';
      throw new CliError([
        `${e.name ?? id} is listed on ${s.client.baseUrl}, but its file is not on this node.`,
        `Teaching on top of it needs the file: \`${PROG} use ${id} --no-apply\` (${price}), then run this again.`,
      ].join('\n'), 2);
    }
    throw new CliError([
      `${id} is not on ${s.client.baseUrl}.`,
      `Check the id with \`${PROG} patch ls\`, or teach on a node that holds it (\`--node <url>\`).`,
    ].join('\n'), 2);
  }
}

async function trainDataset(s: TeachSession, datasetId: string, opts: TrainOpts): Promise<CreateJobResult> {
  const patchIds = (opts.patch ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const baseIds = (opts.on ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (baseIds.length > 1) throw new CliError(`--on takes one knowledge — combining two is \`${PROG} patch merge ${baseIds[0]} ${baseIds[1]}\``);
  const body = {
    dataset_id: datasetId,
    // `--patch` alone keeps meaning "loaded for comparison"; with `--on` the base is what the lesson is built on and
    // the rest is context (design §13). `builds_on_context` is only sent for the legacy shape, without a base.
    patch_ids: patchIds, context_ids: patchIds, builds_on_context: !baseIds.length && patchIds.length > 0,
    ...(baseIds.length ? { base_ids: baseIds, mode: 'extend' as const } : {}),
    ...(opts.inherit === false ? { inherit: false } : {}),
    ...(opts.yesChange ? { confirm_conflicts: true } : {}),
    ...(opts.name ? { name: opts.name } : {}), ...(trainingSpec(opts) ? { training: trainingSpec(opts) } : {}),
    ...(s.key.name ? { contributor: { name: s.key.name } } : {}),
  };
  return s.post<CreateJobResult>('/api/teach/jobs', body);
}

export interface TrainResult extends CreateJobResult {
  node: string; dataset_id: string; uploaded?: DatasetUploadResult;
  /** `--wait` only (item 239): READY *and* measured on the live model. A script keying on `checks.ok` alone was told
   *  a lesson that taught 0 of 18 sentences had succeeded, because `checks.ok` is the SIDE-EFFECT check, not the lesson. */
  ok?: boolean;
}

/**
 * `teach train <dataset-id | file>` — queue a lesson from a dataset. A path is uploaded first (the same validation
 * `teach dataset` prints), so one command can go from a file on disk to a lesson.
 */
export async function teachTrain(ctx: CliContext, target: string, opts: DatasetOpts & TrainOpts = {}): Promise<TrainResult> {
  let uploaded: DatasetUploadResult | undefined;
  let datasetId = target;
  const s = await TeachSession.open(ctx, opts);
  // Item 171: the bases are checked BEFORE the upload. Failing after the file is on the node — after a teaching key
  // was created and a dataset quota was spent — is what made `invalid: unknown knowledge` unrecoverable advice.
  await assertBasesUsable(s, [...(opts.on ?? '').split(','), ...(opts.patch ?? '').split(',')].map((x) => x.trim()).filter(Boolean));
  if (!UUID_RE.test(target)) {
    if (!existsSync(target)) throw new CliError(`not a dataset id or a file: ${target} — \`${PROG} teach dataset ls\` lists your datasets`);
    uploaded = await datasetUpload(ctx, target, { ...opts, silent: ctx.json, nextSteps: false });
    datasetId = uploaded.dataset.id;
    if (!ctx.quiet && !ctx.json) process.stdout.write('\n');
  }
  const created = await trainDataset(s, datasetId, opts);
  let out: TrainResult = { ...created, node: s.client.baseUrl, dataset_id: datasetId, ...(uploaded ? { uploaded } : {}) };
  if (opts.wait) {
    const done = await waitForJob(s, created.job.id, ctx, waitMs(opts));
    out = { ...out, job: done, ok: done.status === 'READY' && done.checks?.executed === true };
    // Item 239: a script has to be able to tell a bake that worked from one that did not. `--wait` used to exit 0 on
    // FAILED, on NEEDS_MORE and on a lesson that taught 0 of 18, so `teach train --wait && teach publish …` published
    // a failed bake every morning. The exit code is the terminal status, documented in --help.
    //
    // Item 245: the READY-but-never-measured case had a code (8) and could not reach it — `EXIT_FOR_STATUS.READY`
    // is 0, so the `??` fallback beside it was dead. A lesson saved unchecked because the model server was down
    // cannot be published, and that is not a success.
    process.exitCode = exitForJob(done);
    if (unchecked(done)) {
      warnUnchecked(ctx, done.id);
    }
  }
  emit(ctx, out, (d) => (opts.wait ? renderTeachStatus({ kind: 'job', node: d.node, job: d.job, owner: true }) : renderJobCreated(d, d.node)));
  return out;
}

/**
 * `teach train --wait` exit codes (item 239). 0 only when the lesson is READY and was actually measured on the live
 * model; every other terminal state has its own code so a cron line can branch instead of guessing from stdout.
 */
export const EXIT_FOR_STATUS: Record<string, number> = {
  READY: 0, NEEDS_MORE: 4, FAILED: 5, CANCELLED: 5, EXPIRED: 5, REJECTED: 6, ANNOUNCED: 0, PENDING_REVIEW: 0,
};

/** READY, and nothing was ever measured on the live model — the lesson exists and cannot be published (item 245). */
export const unchecked = (j: TeachJobView): boolean => j.status === 'READY' && j.checks?.executed !== true;

/** The exit code of a finished lesson: its terminal status, except that an unmeasured READY is 8, not 0. */
export function exitForJob(j: TeachJobView): number {
  if (unchecked(j)) return 8;
  return EXIT_FOR_STATUS[j.status] ?? 0;
}

/** What to do about a lesson that was saved unchecked — the recovery step that only the browser used to have. */
function warnUnchecked(ctx: CliContext, jobId: string): void {
  warn(ctx, `this lesson was saved WITHOUT being measured on the live model (the model server was unavailable) — publishing it stays blocked until it is measured.`);
  info(ctx, c.dim(`  measure it now:  ${PROG} teach recheck ${jobId} --wait`));
}

const TERMINAL = ['READY', 'NEEDS_MORE', 'FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'ANNOUNCED', 'PENDING_REVIEW'];

/** Poll one lesson until it stops moving, printing each stage change (`--wait`). */
async function waitForJob(s: TeachSession, id: string, ctx: CliContext, timeoutMs = 60 * 60_000): Promise<TeachJobView> {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const { job } = await s.get<{ job: TeachJobView }>(`/api/teach/jobs/${encodeURIComponent(id)}`);
    // Item 245 — with the model server down the stream printed `EXPORTED step 3/3 · 10/10 right` and then nothing at
    // all for the whole grace period, while the node's own log said exactly what it was waiting for.
    const line = `${job.status}${job.progress ? ` step ${job.progress.step}/${job.progress.max_steps} · ${job.progress.hits}/${job.progress.total} right` : ''}`
      + (job.blocked ? ` · waiting for ${blockedText(job.blocked)}` : '');
    if (line !== last && !ctx.quiet && !ctx.json) { process.stderr.write(c.dim(`  ${line}\n`)); last = line; }
    if (TERMINAL.includes(job.status)) return job;
    if (Date.now() - t0 > timeoutMs) {
      const waited = Math.round((Date.now() - t0) / 1000);
      throw new CliError(`lesson ${id} is still ${job.status} after ${waited < 90 ? `${waited}s` : `${Math.round(waited / 60)} min`} — it goes on without this command; check later: ${PROG} teach status ${id}`, 7);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export function renderJobCreated(r: CreateJobResult, node: string): string {
  const q = r.quota ?? {};
  const lines = [
    c.ok('✓ ') + `lesson ${c.id(r.job.id)} queued` + (r.job.position !== undefined ? c.dim(`  ${r.job.position} ahead of it`) : ''),
    kv([
      ['questions', `${r.job.facts?.length ?? r.job.dataset?.trained_rows ?? 0} of ${r.job.dataset?.rows ?? '?'} in the dataset`],
      ...(r.job.bases?.length ? [['built on', `${r.job.bases[r.job.bases.length - 1].name ?? r.job.bases[r.job.bases.length - 1].patch_id}${r.job.inherited_rows ? ` · keeps ${r.job.inherited_rows} of its questions as known answers` : ''}${r.job.changed_rows ? ` · changes ${r.job.changed_rows} of its answers` : ''}`] as [string, unknown]] : []),
      ['effort', r.job.training ? `${r.job.training.effort} · ${r.job.training.max_steps} passes${r.job.training.check_side_effects === false ? ' · side-effect check OFF (publishing stays blocked until it is measured)' : ''}` : c.dim('node default')],
      ['left today', `${q.key_remaining ?? '?'} lessons · ${q.rows_remaining ?? '?'} questions (this key)`],
    ]),
    c.dim(`follow it:   ${PROG} teach status ${r.job.id}`),
    c.dim(`or in the browser: ${node}/teach/lesson/${r.job.id}`),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- teach jobs
export interface JobsResult { node: string; items: TeachJobView[] }

export async function teachJobs(ctx: CliContext, opts: KeyOpts & { dataset?: string } = {}): Promise<JobsResult> {
  const s = await TeachSession.open(ctx, opts);
  const r = await s.get<{ items: TeachJobView[] }>('/api/teach/jobs');
  const items = opts.dataset ? r.items.filter((j) => j.dataset?.id === opts.dataset) : r.items;
  const out = { node: s.client.baseUrl, items };
  emit(ctx, out, renderJobs);
  return out;
}

export function renderJobs(r: JobsResult): string {
  return [
    c.head(`your lessons on ${r.node}`),
    table(r.items, [
      { key: 'id', title: 'LESSON', get: (j) => c.id(j.id) },
      { key: 'n', title: 'NAME', get: (j) => (j.name ?? j.facts?.[0]?.prompt ?? '-').slice(0, 30) },
      { key: 's', title: 'STATUS', get: (j) => j.status },
      { key: 'd', title: 'DATASET', get: (j) => (j.dataset?.id ? `${shortHash(j.dataset.id, 8)}${j.dataset.deleted ? c.err(' (deleted)') : ''}` : c.dim('none (v1 lesson)')) },
      { key: 'q', title: 'QUESTIONS', get: (j) => (j.dataset ? `${j.dataset.trained_rows} / ${j.dataset.rows}` : String(j.facts?.length ?? 0)), align: 'right' },
      { key: 'e', title: 'EFFORT', get: (j) => j.training?.effort ?? '-' },
      // Item 184 — this column was titled PUBLISHED AS and printed the private draft id of a lesson that had
      // published nothing; `patch get` on that id answers "patch not found", because a draft is invisible to
      // everyone but the operator. The column says which of the two an id is.
      { key: 'p', title: 'KNOWLEDGE', get: knowledgeCell },
      { key: 't', title: 'UPDATED', get: (j) => fmtTime(j.updated_at) },
    ], 'no lessons yet'),
    privateDraftNote(r.items),
    '',
    c.dim(`one lesson: ${PROG} teach status <lesson-id>   ·   its questions: ${PROG} teach dataset get <dataset-id>`),
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- teach recheck (item 245)
/**
 * `ainize teach recheck <lesson>` — measure a lesson that was saved unchecked.
 *
 * When the serving model is unreachable the node trains anyway, waits out its grace period and then saves the
 * lesson with `checks.executed: false`, which blocks publishing for good. `POST /api/teach/jobs/:id/recheck` has
 * been the way back all along and existed only in the browser: an operator whose 3 a.m. cron produced an unchecked
 * lesson had to open a page and click "check again". `--wait` follows it to its next terminal state, with the same
 * exit codes `teach train --wait` uses.
 */
export async function teachRecheck(ctx: CliContext, jobId: string, opts: KeyOpts & { wait?: boolean } = {}): Promise<{ node: string; job: TeachJobView }> {
  const s = await TeachSession.open(ctx, opts);
  await s.post<{ ok: true; status: string }>(`/api/teach/jobs/${encodeURIComponent(jobId)}/recheck`)
    .catch((e) => {
      const msg = (e as Error).message;
      if (/^job_not_ready/.test(msg)) throw new CliError(`${msg}\n  ${PROG} teach status ${jobId}  shows what state the lesson is in (only a READY or NEEDS_MORE lesson that was never measured can be re-checked).`, 1);
      throw e;
    });
  info(ctx, c.dim(`${jobId} is queued for a re-check on the live model${opts.wait ? '' : ` — ${PROG} teach status ${jobId} follows it`}`));
  const job = opts.wait
    ? await waitForJob(s, jobId, ctx)
    : (await s.get<{ job: TeachJobView }>(`/api/teach/jobs/${encodeURIComponent(jobId)}`)).job;
  if (opts.wait) {
    process.exitCode = exitForJob(job);
    if (unchecked(job)) warn(ctx, `still unmeasured: the model server did not answer this time either. ${PROG} teach recheck ${jobId} --wait tries again.`);
  }
  const out = { node: s.client.baseUrl, job };
  emit(ctx, out, (d) => renderTeachStatus({ kind: 'job', node: d.node, job: d.job, owner: Array.isArray(d.job.facts) }));
  return out;
}

// ---------------------------------------------------------------- teach publish (item 238)
/** What `GET /api/teach/jobs/:id/publish-challenge` answers. `split_preview` is item 186's real money split. */
export interface PublishChallenge {
  patch_sha256: string; benchmark_hash: string; address: string; signer: string; share: number; claim: string;
  split_preview?: {
    currency: string; royalty_share: number; contributor_share: number;
    parents: { id: string; name: string; author?: string; price?: string }[];
    shares: { address: string; share: number; kind: 'you' | 'node' | 'lineage'; name?: string }[];
    suggested_price: string;
  };
  verification?: { quorum: number; peers: number; reachable: number; verifiers: number; self_verifier: boolean };
  ledger?: { kind: 'local' | 'ain'; currency: string };
}
export type PublishOutcome = { status: 'PENDING_REVIEW' } | { status: 'ANNOUNCED'; patch_id: string; url: string };
export interface PublishResult { node: string; job_id: string; challenge: PublishChallenge; result: PublishOutcome; price: string }
export interface TeachPublishOpts extends KeyOpts {
  name: string; price?: string; license?: string; description?: string; payout?: string;
  consentPermanent?: boolean; consentRights?: boolean;
  access?: 'public' | 'derivative' | 'private'; datasetLicense?: string; includeNotes?: boolean;
  /** where the questions came from (§6.5) — required by the node above `dataset.declarationRows` rows */
  declare?: 'own' | 'public' | 'licensed';
}

/**
 * `ainize teach publish <job-id>` — the door that only the browser had (item 238).
 *
 * The whole dataset pipeline already ran from the terminal (upload -> train -> wait -> READY) and then stopped with
 * "open <node>/teach/lesson/<id>": publishing needs a `claim_sig` signed by the TEACHING key, and only the browser's
 * PublishSheet ever signed one — although this CLI has held that key in `<home>/teaching-key.json` all along. So a
 * cron line could bake every morning and never share anything without someone opening a browser at 3 a.m.
 *
 * The two consents are the publisher's, not this command's: they are typed as flags, sent as the real checkbox state,
 * and the node refuses the publish without both. Nothing is defaulted to true.
 */
export async function teachPublish(ctx: CliContext, jobId: string, opts: TeachPublishOpts): Promise<PublishResult> {
  if (!opts.consentPermanent || !opts.consentRights) {
    throw new CliError([
      'publishing puts this lesson on a permanent public record: the questions, the answers, your display name and your payout address cannot be edited or deleted, and verifier nodes will read them.',
      'Confirm both, in your own words, with --consent-permanent --consent-rights (the second is: you have the right to share this information, and it is not private or personal data).',
    ].join('\n'), 1);
  }
  const name = (opts.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new CliError('--name must be 2 to 80 characters — it is what buyers see');
  const price = (opts.price ?? '0').trim();
  if (!/^\d+(\.\d+)?$/.test(price)) throw new CliError('--price must be a number, 0 or more (0 = free)');
  const payout = opts.payout === undefined ? undefined : opts.payout === 'none' ? null : opts.payout.trim();
  if (payout && !/^0x[0-9a-fA-F]{40}$/.test(payout)) throw new CliError('--payout takes an AIN address (0x…) or the word `none`');

  const s = await TeachSession.open(ctx, opts);
  const chPath = `/api/teach/jobs/${encodeURIComponent(jobId)}/publish-challenge${query({ payout_address: payout === null ? 'none' : payout })}`;
  const challenge = await s.get<PublishChallenge>(chPath).catch((e) => {
    const msg = (e as Error).message;
    // `job_not_ready` / `checks_failed` are the lesson's own state, not a usage error: exit 1 with what to do next
    if (/^job_not_ready|^checks_failed/.test(msg)) throw new CliError(`${msg}\n${PROG} teach status ${jobId}  shows what the lesson is waiting for.`, 1);
    if (/^publish_disabled/.test(msg)) throw new CliError(`${msg}\nKeep the file instead: ${PROG} teach status ${jobId}`, 1);
    throw e;
  });
  const claim_sig = signMessage(challenge.claim, s.key.privateKey);
  const body = {
    name, price, ...(opts.license ? { license: opts.license } : {}), ...(opts.description ? { description: opts.description } : {}),
    ...(payout !== undefined ? { payout_address: payout } : {}),
    claim_sig, consent: { permanent: true, rights: true },
    dataset: {
      access: opts.access ?? 'derivative', ...(opts.datasetLicense ? { license: opts.datasetLicense } : {}), ...(opts.includeNotes ? { include_notes: true } : {}),
      // §6.5 — where the questions come from. The node demands it above `dataset.declarationRows`, so without this
      // flag a big set could be trained from the terminal and never published from it. `no_pii` is not invented
      // here: it is the second consent this command already refuses to run without, in the publisher's own words
      // ("you have the right to share this information, and it is not private or personal data").
      ...(opts.declare ? { declaration: { source: opts.declare, no_pii: true, ...(opts.datasetLicense ? { license: opts.datasetLicense } : {}) } } : {}),
    },
    ...(s.key.name ? { contributor: { name: s.key.name } } : {}),
  };
  const result = await s.post<PublishOutcome>(`/api/teach/jobs/${encodeURIComponent(jobId)}/publish`, body);
  const out: PublishResult = { node: s.client.baseUrl, job_id: jobId, challenge, result, price };
  emit(ctx, out, renderPublished);
  return out;
}

export function renderPublished(r: PublishResult): string {
  const ch = r.challenge;
  const sp = ch.split_preview;
  const cur = sp?.currency ?? ch.ledger?.currency ?? '';
  const lines: string[] = [];
  lines.push(r.result.status === 'ANNOUNCED'
    ? c.ok('✓ ') + `published as ${c.id(r.result.patch_id)} (ANNOUNCED)`
    : c.ok('✓ ') + 'sent to the node operator for review (PENDING_REVIEW)');
  const pairs: [string, unknown][] = [['price', Number(r.price) > 0 ? `${r.price} ${cur}` : 'free'], ['credited to', ch.address]];
  // Item 186 in the terminal: the same numbers the sheet shows, from the node's own royaltySplit — never the raw
  // contributor share, which is 70 % on a lesson that pays its teacher 49 %.
  if (sp) {
    const pctOf = (x: number) => `${Math.round(x * 1000) / 10} %`;
    const amount = (x: number) => (Number(r.price) > 0 ? ` = ${Math.round(x * Number(r.price) * 1e6) / 1e6} ${cur}` : '');
    for (const sh of sp.shares) {
      if (sh.share <= 0 && sh.kind !== 'node') continue;
      const who = sh.kind === 'you' ? 'you' : sh.kind === 'node' ? 'this node' : sh.name ?? sh.address;
      pairs.push([sh.kind === 'lineage' ? '  creator share' : sh.kind === 'you' ? '  your share' : '  node share', `${pctOf(sh.share)} of every sale${amount(sh.share)}  ${c.dim(who)}`]);
    }
    if (sp.parents.length) pairs.push(['built on', sp.parents.map((p) => `${p.name}${p.price ? ` (sells for ${p.price} ${cur})` : ''}`).join(', ')]);
  }
  if (ch.ledger?.kind === 'local') pairs.push(['settles in', c.warn(`${ch.ledger.currency} on this node's own ledger`) + ' — development play money, not withdrawable']);
  if (r.result.status === 'ANNOUNCED') pairs.push(['page', r.result.url]);
  lines.push(kv(pairs));
  // Item 298: never end on "verifiers are now checking it" when this node has none.
  const v = ch.verification;
  if (v && v.verifiers < v.quorum) {
    lines.push('', c.warn('! ') + `${r.node} has ${v.verifiers} verifier peer(s) and needs ${v.quorum}: this is on the record, but it cannot go on sale here until verifier nodes appear.`);
  } else if (v) {
    lines.push('', c.dim(`${v.verifiers} verifier peer(s) reachable — it goes on sale when ${v.quorum} of them agree.`));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- patch merge (design §9, §13)
export interface MergePreview {
  a: { id: string; name: string; questions: number | null }; b: MergePreview['a'];
  questions: { a_only: number; b_only: number; same: number; conflicts: { key: string; prompt: string; a_answer: string; b_answer: string }[] } | null;
  rows: { a_only: number; b_only: number; shared: number; disagree: number; opposing: number; before_differs: number };
  merged: { rows: number; from_a: number; from_b: number; targets: number } | null;
  tiers: {
    union: { allowed: boolean; reason?: string; export?: string };
    retrain: { allowed: boolean; reason?: string; est_min: number | null };
    rebuild: { allowed: boolean; reason?: string; est_min: number | null };
    required: string | null; disagree_ratio: number;
  };
  licenses: { a: string | null; b: string | null; child_min: string | null };
  private_parent?: string;
}
export type MergeResolutionInput = 'a' | 'b' | 'drop' | { answer: string };
export interface MergeResult extends Partial<CreateJobResult> { node: string; preview: MergePreview; a: string; b: string; tier?: string }

const TIERS = ['union', 'retrain', 'rebuild'] as const;
const TIER_COPY: Record<string, string> = {
  union: 'just combine — no training', retrain: 'retrain the disagreeing questions on top of both', rebuild: 'rebuild everything from the combined questions',
};

/**
 * `ainize patch merge <a> <b>` — combine two knowledges (design §13).
 *
 * It always measures first and prints what it measured: how the two training sets overlap, how the two FILES overlap,
 * and which of the three builds is possible. `--preview` stops there. Without a resolution for every question the two
 * answer differently the command refuses and prints those questions as JSON on stdout with exit code 3 — that file,
 * with an answer chosen for each key, is what `--resolve` takes back.
 */
export async function patchMerge(ctx: CliContext, a: string, b: string, opts: KeyOpts & { preview?: boolean; resolve?: string; tier?: string; name?: string; wait?: boolean } = {}): Promise<MergeResult> {
  const s = await TeachSession.open(ctx, opts);
  await assertBasesUsable(s, [a, b]);
  const preview = await s.post<MergePreview>('/api/teach/merge/preview', { a, b });
  const base: MergeResult = { node: s.client.baseUrl, preview, a, b };
  if (opts.preview) { emit(ctx, base, (d) => renderMergePreview(d.preview)); return base; }

  if (opts.tier && !TIERS.includes(opts.tier as typeof TIERS[number])) throw new CliError(`--tier must be one of ${TIERS.join(' | ')}`);
  const tier = opts.tier ?? preview.tiers.required ?? (preview.tiers.union.allowed ? 'union' : preview.tiers.retrain.allowed ? 'retrain' : 'rebuild');
  const resolutions = opts.resolve ? readResolutions(opts.resolve) : {};
  const open = (preview.questions?.conflicts ?? []).filter((x) => resolutions[x.key] === undefined);
  if (open.length) {
    // stdout stays machine-readable on purpose: this file IS the input of `--resolve`
    process.stdout.write(`${JSON.stringify(Object.fromEntries(open.map((x) => [x.key, { prompt: x.prompt, a_answer: x.a_answer, b_answer: x.b_answer, choose: 'a | b | drop | {"answer": "…"}' }])), null, 1)}\n`);
    throw new CliError(`${open.length} question(s) are answered differently by ${a} and ${b}. Save the JSON above, put "a", "b", "drop" or {"answer": "…"} in place of each \`choose\`, and run again with --resolve <file>.`, 3, { conflicts: open });
  }
  const created = await s.post<CreateJobResult>('/api/teach/jobs', {
    patch_ids: [], base_ids: [a, b], mode: 'merge', tier, resolutions,
    ...(opts.name ? { name: opts.name } : {}), ...(s.key.name ? { contributor: { name: s.key.name } } : {}),
  });
  let out: MergeResult = { ...base, ...created, tier };
  if (opts.wait) {
    const done = await waitForJob(s, created.job.id, ctx);
    out = { ...out, job: done };
    process.exitCode = EXIT_FOR_STATUS[done.status] ?? 0;
  }
  emit(ctx, out, (d) => [
    renderMergePreview(d.preview),
    '',
    c.ok('✓ ') + `${TIER_COPY[d.tier ?? 'union']}: lesson ${c.id(d.job!.id)} queued`,
    c.dim(`watch it:   ${PROG} teach status ${d.job!.id}`),
    c.dim(`publish it: ${PROG} teach publish ${d.job!.id} --dataset-access derivative --dataset-license ${d.preview.licenses.child_min ?? 'CC-BY-4.0'}`),
  ].join('\n'));
  return out;
}

function readResolutions(path: string): Record<string, MergeResolutionInput> {
  if (!existsSync(path)) throw new CliError(`no such file: ${path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new CliError(`${path} is not JSON: ${(e as Error).message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError(`${path} must be an object of {"<question key>": "a" | "b" | "drop" | {"answer": "…"}}`);
  const out: Record<string, MergeResolutionInput> = {};
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === 'a' || v === 'b' || v === 'drop') { out[key] = v; continue; }
    const answer = (v as { answer?: unknown })?.answer;
    if (typeof answer === 'string' && answer.trim()) { out[key] = { answer }; continue; }
    // a key still carrying the `choose` placeholder is not a choice — say which one, rather than sending it
    throw new CliError(`no answer chosen for "${(v as { prompt?: string })?.prompt ?? key}" — put "a", "b", "drop" or {"answer": "…"} there`);
  }
  return out;
}

function renderMergePreview(p: MergePreview): string {
  // the design's copy names the two knowledges, never their ids: "{A} says: …" is a sentence a creator can read
  const A = p.a.name || p.a.id; const B = p.b.name || p.b.id;
  const tier = (name: 'union' | 'retrain' | 'rebuild') => {
    const t = p.tiers[name];
    const est = 'est_min' in t && t.est_min !== null ? c.dim(` ~${t.est_min} min`) : name === 'union' ? '' : c.dim(' (this node has never timed one)');
    const mark = t.allowed ? c.ok('✓') : c.err('✗');
    const why = t.allowed ? '' : c.dim(` — ${t.reason}`);
    return `  ${mark} ${TIER_COPY[name]}${est}${why}${p.tiers.required === name ? c.warn('  ← required') : ''}`;
  };
  const rows = ['rows', `${p.rows.a_only} only in ${A} · ${p.rows.b_only} only in ${B} · ${p.rows.shared} written by both (${p.rows.disagree} disagree)`] as [string, string];
  return [
    `${A} ${c.dim(`(${p.a.id})`)} + ${B} ${c.dim(`(${p.b.id})`)}`,
    p.questions
      ? kv([
        ['questions', `${p.questions.a_only} only in ${A} · ${p.questions.b_only} only in ${B} · ${p.questions.same} the same · ${p.questions.conflicts.length} same question, different answer`],
        rows,
        ['combined set', p.merged ? `${p.merged.rows} question(s) — ${p.merged.from_a} from ${A}, ${p.merged.from_b} from ${B}` : '—'],
        ['licence', `${p.licenses.a ?? '—'} + ${p.licenses.b ?? '—'} → ${p.licenses.child_min ?? 'your choice'}`],
      ])
      : kv([
        ['questions', c.dim(`${p.private_parent === p.a.id ? A : B} keeps its questions private — only the rows can be compared`)],
        rows,
      ]),
    '',
    tier('union'), tier('retrain'), tier('rebuild'),
    ...(p.questions?.conflicts.length ? ['', c.warn(`${p.questions.conflicts.length} question(s) need an answer:`),
      ...p.questions.conflicts.slice(0, 5).map((x) => `  ${x.prompt}\n    ${A}: ${x.a_answer}\n    ${B}: ${x.b_answer}`),
      ...(p.questions.conflicts.length > 5 ? [c.dim(`  … and ${p.questions.conflicts.length - 5} more`)] : [])] : []),
  ].join('\n');
}
