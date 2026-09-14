import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { CliError, type CliContext } from '../context.js';
import { emit, info } from '../output.js';
import { datasetUpload, renderUpload, type DatasetOpts, type TrainOpts } from './teach-dataset.js';
import { huggingFaceImportReceipt } from './huggingface-import-receipt.js';

const HUB = 'https://huggingface.co';
const VIEWER = 'https://datasets-server.huggingface.co';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 10000;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;

export interface HuggingFaceOptions extends DatasetOpts, TrainOpts {
  config?: string; split?: string; revision?: string; file?: string;
  limit?: number; offset?: number; hfTokenFile?: string; train?: boolean;
}
export interface HuggingFaceSource {
  kind: 'huggingface'; url: string; repository: string; revision: string;
  config: string | null; split: string | null; file: string | null;
  offset: number | null; importedRows: number | null; totalRows: number | null; sampled: boolean | null;
  format: string; sha256: string; bytes: number; inputSha256: string; inputBytes: number; license: unknown; columns: unknown;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError(`invalid Hugging Face ${label}`);
  return value as JsonObject;
}

export function parseHuggingFaceUrl(input: string): { repository: string; file?: string; revision?: string; config?: string; split?: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw new CliError('expected https://huggingface.co/datasets/<owner>/<name>'); }
  if (url.origin !== HUB || url.username || url.password || url.search || url.hash || /%2f|%5c|\\/i.test(url.pathname)) {
    throw new CliError('use an HTTPS huggingface.co dataset URL without credentials, query parameters or fragments');
  }
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(part => decodeURIComponent(part));
  if (parts[0] !== 'datasets' || !parts[1] || !parts[2] || ![parts[1], parts[2]].every(part => /^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new CliError('expected a dataset URL, not a model or Space URL: https://huggingface.co/datasets/<owner>/<name>');
  }
  const repository = `${parts[1]}/${parts[2]}`;
  if (parts.length === 3) return { repository };
  if (parts[3] === 'resolve' && parts.length >= 6 && parts[4]) return { repository, revision: parts[4], file: parts.slice(5).join('/') };
  if (parts[3] === 'viewer' && parts.length === 6 && parts[4] && parts[5]) return { repository, config: parts[4], split: parts[5] };
  throw new CliError('use the dataset repository URL, /viewer/<config>/<split>, or /resolve/<revision>/<file>');
}

function filePath(value: string): string {
  if (!value || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new CliError('invalid Hugging Face file path');
  return value.split('/').map(encodeURIComponent).join('/');
}

async function download(url: URL, fetcher: Fetcher, token?: string): Promise<{ bytes: Buffer; revision: string | null }> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const trusted = url.origin === HUB || url.origin === VIEWER;
    const fileHost = url.hostname.endsWith('.hf.co') || url.hostname.endsWith('.huggingface.co');
    if (url.protocol !== 'https:' || url.port || url.username || url.password || (!trusted && !fileHost)) throw new CliError('Hugging Face redirected to an unsupported host');
    const headers: Record<string, string> = { accept: 'application/json, text/plain, */*' };
    if (trusted && token) headers.authorization = `Bearer ${token}`;
    const response = await fetcher(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new CliError('Hugging Face redirect has no location');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CliError(`Hugging Face HTTP ${response.status}${response.status === 401 || response.status === 403 ? '; use --hf-token-file for an account with access (gated terms must already be accepted)' : '; dataset viewer may be unavailable: use --file with a supported data file'}`);
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel();
      throw new CliError('Hugging Face response exceeds the 32 MiB import limit');
    }
    if (!response.body) throw new CliError('empty Hugging Face response');
    const chunks: Buffer[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BYTES) throw new CliError('Hugging Face response exceeds the 32 MiB import limit');
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks), revision: response.headers.get('x-revision') };
  }
  throw new CliError('too many Hugging Face redirects');
}

export function mapHuggingFaceColumns(bytes: Buffer, format: string, columns?: string): Buffer {
  if (!columns || !['jsonl', 'json'].includes(format)) return bytes;
  const mapping = object(JSON.parse(columns), 'column mapping');
  const fields = ['prompt', 'answer', 'alt_prompt', 'note'];
  if (!mapping.prompt || !mapping.answer || Object.keys(mapping).some(key => !fields.includes(key)) || Object.values(mapping).some(value => typeof value !== 'string' || !value)) throw new CliError('--columns must map prompt/answer and optional alt_prompt/note to existing column names');
  const parsed: unknown = format === 'jsonl' ? bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line)) : JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parsed)) throw new CliError('JSON column mapping requires an array of objects');
  const rows = parsed.map((value, index) => {
    const original = object(value, `row ${index}`);
    const mapped: Record<string, string> = {};
    for (const [field, column] of Object.entries(mapping)) {
      if (!Object.hasOwn(original, column as string)) throw new CliError(`missing column ${column} at row ${index}`);
      const cell = original[column as string];
      if ((cell === null || cell === undefined) && !['prompt', 'answer'].includes(field)) continue;
      if (typeof cell !== 'string' && typeof cell !== 'boolean' && !(typeof cell === 'number' && Number.isFinite(cell))) throw new CliError(`column ${column} at row ${index} must be a scalar, not an object or array`);
      mapped[field] = String(cell);
    }
    return mapped;
  });
  return Buffer.from(format === 'jsonl' ? rows.map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(rows));
}

export async function readHuggingFaceDataset(input: string, opts: HuggingFaceOptions = {}, fetcher: Fetcher = fetch): Promise<{ bytes: Buffer; inputBytes: Buffer; filename: string; source: HuggingFaceSource }> {
  const target = parseHuggingFaceUrl(input);
  for (const key of ['revision', 'file', 'config', 'split'] as const) {
    if (target[key] && opts[key] && target[key] !== opts[key]) throw new CliError(`URL and --${key} disagree`);
  }
  const selected = { ...target, ...Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined)) };
  let token: string | undefined;
  if (opts.hfTokenFile) {
    const stats = statSync(opts.hfTokenFile);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new CliError('--hf-token-file must be a private file (chmod 600)');
    token = readFileSync(opts.hfTokenFile, 'utf8').trim();
    if (!token || /\s/.test(token)) throw new CliError('invalid Hugging Face token file');
  }
  const request = (url: URL) => download(url, fetcher, token);
  const metadataUrl = new URL(`/api/datasets/${target.repository}/revision/${encodeURIComponent(selected.revision || 'main')}`, HUB);
  const metadata = object(JSON.parse((await request(metadataUrl)).bytes.toString('utf8')), 'repository metadata');
  if (typeof metadata.sha !== 'string' || !/^[a-f0-9]{40}$/.test(metadata.sha)) throw new CliError('Hugging Face did not return an immutable revision');
  if (metadata.id !== target.repository) throw new CliError('Hugging Face repository identity changed');
  const source: HuggingFaceSource = { kind: 'huggingface', url: input, repository: target.repository, revision: metadata.sha,
    config: null, split: null, file: null, offset: null, importedRows: null, totalRows: null, sampled: null,
    format: '', sha256: '', bytes: 0, inputSha256: '', inputBytes: 0, license: (metadata.cardData as JsonObject | undefined)?.license ?? null,
    columns: opts.columns ? JSON.parse(opts.columns) : null };
  let bytes: Buffer;
  let filename: string;
  if (selected.file) {
    if (opts.offset !== undefined || opts.limit !== undefined || selected.config || selected.split) throw new CliError('--file cannot be combined with config/split/offset/limit; it imports the file as supplied');
    const encoded = filePath(selected.file);
    source.format = opts.format || extname(selected.file).slice(1).toLowerCase();
    if (!['jsonl', 'json', 'csv', 'tsv', 'txt'].includes(source.format)) throw new CliError('file imports support jsonl/json/csv/tsv/txt; use a repository URL and --config/--split for viewer-backed Parquet datasets');
    bytes = (await request(new URL(`/datasets/${target.repository}/resolve/${metadata.sha}/${encoded}`, HUB))).bytes;
    filename = `data.${source.format}`;
    source.file = selected.file;
  } else {
    const offset = opts.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_ROWS))) throw new CliError('offset must be a nonnegative integer; limit must be 1..10000');
    const splitsUrl = new URL('/splits', VIEWER);
    splitsUrl.searchParams.set('dataset', target.repository);
    const splitsResponse = await request(splitsUrl);
    if (splitsResponse.revision !== metadata.sha) throw new CliError('dataset viewer revision differs from the requested source; use --file for an immutable file import');
    const splitData = object(JSON.parse(splitsResponse.bytes.toString('utf8')), 'splits');
    if (!Array.isArray(splitData.splits)) throw new CliError('invalid Hugging Face split list');
    const splits = splitData.splits.map(value => object(value, 'split'));
    const configs = [...new Set(splits.map(split => split.config))];
    const config = selected.config ?? (configs.length === 1 ? configs[0] : undefined);
    if (typeof config !== 'string') throw new CliError(`choose --config; available configurations: ${configs.slice(0, 12).join(', ') || 'not ready in the viewer; use --file'}`);
    const candidates = splits.filter(split => split.config === config);
    const splitName = selected.split ?? (candidates.some(split => split.split === 'train') ? 'train' : candidates.length === 1 ? candidates[0].split : undefined);
    if (typeof splitName !== 'string' || !candidates.some(split => split.split === splitName)) throw new CliError('choose an available --split for the selected --config');
    const rows: JsonObject[] = [];
    let serializedBytes = 0;
    let totalRows: number | null = null;
    let targetRows = opts.limit ?? MAX_ROWS;
    while (rows.length < targetRows) {
      const pageOffset = offset + rows.length;
      const pageLength = Math.min(100, targetRows - rows.length);
      const rowsUrl = new URL('/rows', VIEWER);
      for (const [key, value] of Object.entries({ dataset: target.repository, config, split: splitName, offset: pageOffset, length: pageLength })) rowsUrl.searchParams.set(key, String(value));
      const pageResponse = await request(rowsUrl);
      if (pageResponse.revision !== metadata.sha) throw new CliError('dataset revision changed during pagination; no dataset uploaded');
      const page = object(JSON.parse(pageResponse.bytes.toString('utf8')), 'rows');
      if (page.partial !== false || !Number.isSafeInteger(page.num_rows_total) || (page.num_rows_total as number) < 0 || !Array.isArray(page.rows)) throw new CliError('incomplete or invalid Hugging Face rows response');
      if (totalRows !== null && totalRows !== page.num_rows_total) throw new CliError('dataset row count changed during pagination');
      totalRows = page.num_rows_total as number;
      if (offset >= totalRows) throw new CliError('offset selects no rows');
      if (opts.limit === undefined && totalRows - offset > MAX_ROWS) throw new CliError('dataset exceeds 10000 rows; choose an explicit --limit (and optionally --offset), or import a supported file');
      targetRows = Math.min(opts.limit ?? totalRows - offset, totalRows - offset);
      if (page.rows.length !== Math.min(pageLength, targetRows - rows.length)) throw new CliError('missing or unexpected Hugging Face rows');
      for (const [index, value] of page.rows.entries()) {
        const item = object(value, 'row wrapper');
        if (item.row_idx !== pageOffset + index || !Array.isArray(item.truncated_cells) || item.truncated_cells.length) throw new CliError('out-of-order or truncated Hugging Face row');
        const row = object(item.row, 'row');
        serializedBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (serializedBytes > MAX_BYTES) throw new CliError('import exceeds the 32 MiB limit; select fewer rows with --limit');
        rows.push(row);
      }
    }
    bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    filename = `huggingface-${target.repository.replace('/', '-')}.jsonl`;
    Object.assign(source, { config, split: splitName, offset, importedRows: rows.length, totalRows, sampled: offset > 0 || rows.length !== totalRows, format: 'jsonl' });
  }
  if (!bytes.length || bytes.length > MAX_BYTES) throw new CliError('import must contain 1 byte..32 MiB');
  const inputBytes = bytes;
  source.inputSha256 = sha256(inputBytes);
  source.inputBytes = inputBytes.length;
  bytes = mapHuggingFaceColumns(inputBytes, source.format, opts.columns);
  if (bytes.length > MAX_BYTES) throw new CliError('mapped import exceeds the 32 MiB limit');
  source.sha256 = sha256(bytes);
  source.bytes = bytes.length;
  return { bytes, inputBytes, filename, source };
}

export async function datasetImportHuggingFace(ctx: CliContext, input: string, opts: HuggingFaceOptions = {}) {
  if (opts.wait && !opts.train) throw new CliError('--wait requires --train');
  const imported = await readHuggingFaceDataset(input, opts);
  const cache = join(ctx.home, 'hf-imports');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(join(cache, 'import-'));
  const filename = join(folder, imported.filename);
  const provenance = join(folder, 'source.json');
  writeFileSync(filename, imported.bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(folder, `input.${imported.source.format}`), imported.inputBytes, { flag: 'wx', mode: 0o600 });
  const sourceFile = JSON.stringify(imported.source, null, 2) + '\n';
  writeFileSync(provenance, sourceFile, { flag: 'wx', mode: 0o600 });
  const importReceipt = join(folder, 'import-receipt.json');
  const submissionReceipt = opts.train ? join(folder, 'training-submission.json') : undefined;
  const result = await datasetUpload(ctx, filename, { ...opts, columns: ['json', 'jsonl'].includes(imported.source.format) ? undefined : opts.columns, format: imported.source.format, silent: true,
    onUploaded: accepted => {
      try { writeFileSync(importReceipt, JSON.stringify(huggingFaceImportReceipt(imported.source, sourceFile, accepted), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { throw new CliError(`Dataset accepted, but its import receipt could not be validated or saved in ${folder}; training was not started. Inspect the existing dataset before retrying.`); }
    },
    onTrainingSubmitted: accepted => {
      try { writeFileSync(submissionReceipt!, JSON.stringify(huggingFaceImportReceipt(imported.source, sourceFile, accepted), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { throw new CliError(`Training job accepted, but its submission receipt could not be validated or saved in ${folder}. Inspect existing jobs for this dataset before retrying; the job was not cancelled.`); }
      info(ctx, `Training submission receipt: ${submissionReceipt}`);
    },
  });
  const trainingReceipt = result.job ? join(folder, 'training-receipt.json') : undefined;
  if (trainingReceipt) writeFileSync(trainingReceipt, JSON.stringify(huggingFaceImportReceipt(imported.source, sourceFile, result), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const output = { ...result, dataset_id: result.dataset.id, source: imported.source, provenance, import_receipt: importReceipt, training_submission_receipt: submissionReceipt, training_receipt: trainingReceipt };
  emit(ctx, output, value => `${renderUpload(value)}\nHugging Face: ${value.source.repository}@${value.source.revision}\nSource evidence: ${value.provenance}\nImport receipt: ${value.import_receipt}${value.training_receipt ? `\nTraining receipt: ${value.training_receipt}` : ''}\nImported into this node; not published to Hugging Face or the public catalog.`);
  return output;
}
