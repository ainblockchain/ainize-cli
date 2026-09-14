import { createHash } from 'node:crypto';
import type { DatasetUploadResult } from './teach-dataset.js';
import type { HuggingFaceSource } from './huggingface-dataset.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function huggingFaceImportReceipt(source: HuggingFaceSource, sourceFile: string, result: DatasetUploadResult) {
  const dataset = result.dataset;
  const url = new URL(result.node);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) || !/^[a-f0-9]{40}$/.test(source.revision)
    || !uuid(dataset.id) || !sha256(dataset.sha256) || !sha256(source.sha256) || !sha256(source.inputSha256)
    || result.sha256 !== source.sha256 || !Number.isSafeInteger(dataset.revision) || dataset.revision < 0
    || !Number.isSafeInteger(dataset.rows) || dataset.rows < 0 || !Number.isSafeInteger(result.bytes) || result.bytes !== source.bytes) {
    throw new Error('HF import receipt could not bind the accepted upload to its dataset; inspect existing jobs before retrying');
  }
  const job = result.job?.job;
  if (job && (!uuid(job.id) || job.dataset?.id !== dataset.id || job.dataset?.sha256 !== dataset.sha256)) {
    throw new Error('HF import job refers to a different dataset snapshot; inspect existing jobs before retrying');
  }
  return {
    version: 1,
    kind: 'huggingface-import',
    recorded_at: Date.now(),
    source_file: 'source.json',
    source_file_sha256: hash(sourceFile),
    repository: source.repository,
    source_revision: source.revision,
    input_sha256: source.inputSha256,
    upload_sha256: source.sha256,
    node_url: result.node,
    dataset_id: dataset.id,
    dataset_sha256: dataset.sha256,
    dataset_revision: dataset.revision,
    accepted_rows: dataset.rows,
    created: result.created,
    job: job ? { id: job.id, status: job.status, dataset_id: job.dataset!.id, dataset_sha256: job.dataset!.sha256 } : null,
    scope: 'Local import snapshot. Source, upload and canonical dataset hashes cover different bytes. Not proof of training, inference or block inclusion.',
  };
}
