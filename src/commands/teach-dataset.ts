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
 * (the browser's backup JSON) or `--key` / `NGRAM_TEACH_KEY` chooses one; otherwise the CLI keeps one at
 * `<NGRAM_HOME>/teaching-key.json` and creates it on first use — losing that file loses the lessons and earnings.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createIdentity, type TeachDataset, type TeachDatasetRow, type TeachDatasetSummary, type TeachEffort } from '@ngram/core';
import { NodeClient, query } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, fmtBytes, fmtTime, kv, shortHash, table, warn } from '../output.js';
import { loadTeacherKeyFor, nodeAddressOf, parseTeacherKey, renderTeachStatus, signedTeachHeader, TEACH_KEY_FILE, type KeyOpts, type TeachJobView, type TeacherKey } from './teach.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- response shapes (server: packages/node/src/teach-datasets.ts)
export interface DatasetReport { summary: TeachDatasetSummary; rows: TeachDatasetRow[] }
export interface DatasetResult { dataset: TeachDataset; report: DatasetReport; created: boolean }
export interface DatasetRowsPage { total: number; source_rows: number; offset: number; limit: number; summary: TeachDatasetSummary; items: TeachDatasetRow[] }
export interface CreateJobResult { job: TeachJobView; quota?: { key_remaining?: number; ip_remaining?: number; rows_remaining?: number; rows_ip_remaining?: number } }

export interface ParseOpts { format?: string; delimiter?: string; header?: boolean; columns?: string; encoding?: string; layout?: string }
export interface TrainOpts { effort?: TeachEffort; check?: boolean; alt?: boolean; rows?: number; name?: string; patch?: string; wait?: boolean }
export interface DatasetOpts extends KeyOpts, ParseOpts { name?: string; retention?: 'keep' | 'delete_after_training' }

// ---------------------------------------------------------------- teaching key
/**
 * The teaching key for this terminal: `--key-file` / `--key` / `NGRAM_TEACH_KEY`, else `<home>/teaching-key.json`,
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
    return { 'x-ngram-auth': signedTeachHeader(this.key, this.nodeAddress, method, path, body) };
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
      headers: { ...this.hdr('POST', path, fileSha), 'x-ngram-dataset-sha256': fileSha }, auth: false,
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
  return table(shown, [
    // after an edit the dataset was rewritten: these are positions in it, not lines of the file that was uploaded
    { key: 'l', title: opts.positions ? '#' : 'LINE', get: (r) => String(r.line), align: 'right' },
    { key: 's', title: 'STATUS', get: (r) => rowColor(r.status) },
    { key: 'q', title: 'QUESTION', get: (r) => (r.prompt ?? r.raw ?? '').replace(/\s+/g, ' ').slice(0, 36) },
    { key: 'w', title: 'WHY', get: (r) => (r.detail ?? (r.fixes?.length ? `tidied up: ${r.fixes.join(', ')}` : ROW_COPY[r.status] ?? r.status)).slice(0, 60) },
  ]);
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
  `train it:      ${PROG} teach train ${id} --effort balanced`,
  `see it:        ${PROG} teach dataset get ${id}`,
  `download it:   ${PROG} teach dataset get ${id} -o questions.jsonl`,
].join('\n'));

// ---------------------------------------------------------------- teach dataset <file>
export interface DatasetUploadResult extends DatasetResult { node: string; file: string; bytes: number; sha256: string; job?: CreateJobResult }

/**
 * Validate a dataset file and upload it. Nothing is trained here — the node parses the bytes, reports every line it
 * could not use, and keeps the questions as a dataset you can train (`--train`, or `teach train <id>`).
 * Re-uploading the same file returns the SAME dataset (200, `created: false`) instead of a second copy.
 */
export async function datasetUpload(ctx: CliContext, file: string, opts: DatasetOpts & TrainOpts & { train?: boolean; silent?: boolean; nextSteps?: boolean } = {}): Promise<DatasetUploadResult> {
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
  if (opts.train) out.job = await trainDataset(s, r.dataset.id, opts);
  if (!opts.silent) emit(ctx, out, (d) => renderUpload(d, { nextSteps: opts.nextSteps }));
  return out;
}

export function renderUpload(r: DatasetUploadResult, opts: { nextSteps?: boolean } = {}): string {
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
  if (r.job) lines.push('', renderJobCreated(r.job, r.node));
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
    writeFileSync(resolve(opts.out), body);
    // the .jsonl bytes ARE the fingerprint subject; a .csv rendering of them is not
    const verified = format === 'jsonl' ? sha256(body) === dataset.sha256 : sha256(body) === (res.headers.get('x-content-sha256') ?? '');
    if (format === 'jsonl' && !verified) warn(ctx, 'the downloaded bytes do not match the dataset fingerprint — do not re-upload this file');
    out.saved = { path: resolve(opts.out), bytes: body.length, sha256: sha256(body), verified };
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
  if (r.saved) lines.push('', c.ok('✓ ') + `saved ${r.saved.path} (${fmtBytes(r.saved.bytes)})` + (r.saved.verified ? c.dim(` · fingerprint verified — re-uploading it lands on this same dataset`) : ''));
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

async function trainDataset(s: TeachSession, datasetId: string, opts: TrainOpts): Promise<CreateJobResult> {
  const patchIds = (opts.patch ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const body = {
    dataset_id: datasetId, patch_ids: patchIds, builds_on_context: patchIds.length > 0,
    ...(opts.name ? { name: opts.name } : {}), ...(trainingSpec(opts) ? { training: trainingSpec(opts) } : {}),
    ...(s.key.name ? { contributor: { name: s.key.name } } : {}),
  };
  return s.post<CreateJobResult>('/api/teach/jobs', body);
}

export interface TrainResult extends CreateJobResult { node: string; dataset_id: string; uploaded?: DatasetUploadResult }

/**
 * `teach train <dataset-id | file>` — queue a lesson from a dataset. A path is uploaded first (the same validation
 * `teach dataset` prints), so one command can go from a file on disk to a lesson.
 */
export async function teachTrain(ctx: CliContext, target: string, opts: DatasetOpts & TrainOpts = {}): Promise<TrainResult> {
  let uploaded: DatasetUploadResult | undefined;
  let datasetId = target;
  if (!UUID_RE.test(target)) {
    if (!existsSync(target)) throw new CliError(`not a dataset id or a file: ${target} — \`${PROG} teach dataset ls\` lists your datasets`);
    uploaded = await datasetUpload(ctx, target, { ...opts, silent: ctx.json, nextSteps: false });
    datasetId = uploaded.dataset.id;
    if (!ctx.quiet && !ctx.json) process.stdout.write('\n');
  }
  const s = await TeachSession.open(ctx, opts);
  const created = await trainDataset(s, datasetId, opts);
  let out: TrainResult = { ...created, node: s.client.baseUrl, dataset_id: datasetId, ...(uploaded ? { uploaded } : {}) };
  if (opts.wait) {
    const done = await waitForJob(s, created.job.id, ctx);
    out = { ...out, job: done };
  }
  emit(ctx, out, (d) => (opts.wait ? renderTeachStatus({ kind: 'job', node: d.node, job: d.job, owner: true }) : renderJobCreated(d, d.node)));
  return out;
}

const TERMINAL = ['READY', 'NEEDS_MORE', 'FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'ANNOUNCED', 'PENDING_REVIEW'];

/** Poll one lesson until it stops moving, printing each stage change (`--wait`). */
async function waitForJob(s: TeachSession, id: string, ctx: CliContext, timeoutMs = 60 * 60_000): Promise<TeachJobView> {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const { job } = await s.get<{ job: TeachJobView }>(`/api/teach/jobs/${encodeURIComponent(id)}`);
    const line = `${job.status}${job.progress ? ` step ${job.progress.step}/${job.progress.max_steps} · ${job.progress.hits}/${job.progress.total} right` : ''}`;
    if (line !== last && !ctx.quiet && !ctx.json) { process.stderr.write(c.dim(`  ${line}\n`)); last = line; }
    if (TERMINAL.includes(job.status)) return job;
    if (Date.now() - t0 > timeoutMs) throw new CliError(`lesson ${id} is still ${job.status} after ${Math.round((Date.now() - t0) / 60_000)} min — check later: ${PROG} teach status ${id}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export function renderJobCreated(r: CreateJobResult, node: string): string {
  const q = r.quota ?? {};
  const lines = [
    c.ok('✓ ') + `lesson ${c.id(r.job.id)} queued` + (r.job.position !== undefined ? c.dim(`  ${r.job.position} ahead of it`) : ''),
    kv([
      ['questions', `${r.job.facts?.length ?? r.job.dataset?.trained_rows ?? 0} of ${r.job.dataset?.rows ?? '?'} in the dataset`],
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
      { key: 'p', title: 'PUBLISHED AS', get: (j) => j.patch_id ?? c.dim(j.draft_id ?? '-') },
      { key: 't', title: 'UPDATED', get: (j) => fmtTime(j.updated_at) },
    ], 'no lessons yet'),
    '',
    c.dim(`one lesson: ${PROG} teach status <lesson-id>   ·   its questions: ${PROG} teach dataset get <dataset-id>`),
  ].join('\n');
}
