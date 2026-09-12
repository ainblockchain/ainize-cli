import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emit } from '../output.js';
import type { CliContext } from '../context.js';
import type { TeachJobView } from './teach.js';
import { TeachSession, trainDataset } from './teach-dataset.js';
import { PipelineRecorder, savePipelineJson } from './teach-chain.js';

export interface ParallelDataset { datasetId: string; sha256: string; rows: number; }
export interface ParallelTeachOptions {
  chainConfig: string; output: string; runId: string; key?: string; keyFile?: string;
  concurrency?: number; observeSeconds?: number; resume?: boolean;
}

const active = new Set(['QUEUED', 'PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING']);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Receipt = Awaited<ReturnType<PipelineRecorder['record']>>;
type Observation = { value: Record<string, unknown>; receipt?: Receipt; };
interface ParallelEntry extends ParallelDataset {
  index: number; name: string; jobId?: string; status?: string; intent?: { at: string };
  observations: Observation[]; error?: string | null;
}

export function validateParallelManifest(value: unknown): ParallelDataset[] {
  assert.ok(Array.isArray(value) && value.length >= 1 && value.length <= 1000, 'manifest must contain 1–1000 dataset bindings');
  for (const entry of value) {
    assert.match(entry.datasetId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
    assert.match(entry.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(entry.rows) && entry.rows > 0, 'positive dataset row count required');
  }
  assert.equal(new Set(value.map(entry => entry.datasetId)).size, value.length, 'dataset IDs must be unique');
  return value.map(({ datasetId, sha256, rows }) => ({ datasetId, sha256, rows }));
}

export async function parallelMap<Value>(values: Value[], concurrency: number, operation: (value: Value) => Promise<void>): Promise<void> {
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 1000);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      await operation(values[index]);
    }
  }));
}

export async function teachParallel(ctx: CliContext, manifestFile: string, options: ParallelTeachOptions): Promise<unknown> {
  assert.match(options.runId, /^[A-Za-z0-9_-]{1,40}$/);
  const manifestBytes = readFileSync(manifestFile);
  const datasets = validateParallelManifest(JSON.parse(manifestBytes.toString('utf8')));
  const concurrency = options.concurrency ?? datasets.length;
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 1000);
  const observeSeconds = options.observeSeconds ?? 120;
  assert.ok(Number.isFinite(observeSeconds) && observeSeconds >= 0 && observeSeconds <= 86400);
  const session = await TeachSession.open(ctx, { key: options.key, keyFile: options.keyFile });
  const identity = { runId: options.runId, node: session.client.baseUrl, teacher: session.key.address,
    manifestSha256: digest(manifestBytes), chainConfigSha256: digest(readFileSync(options.chainConfig)), concurrency };
  const directory = resolve(options.output);
  const filename = join(directory, 'progress.json');
  let state: { identity: typeof identity; entries: ParallelEntry[]; peakActiveJobs: number; peakTrainingJobs: number; updatedAt?: string; observationFinished?: boolean };
  if (options.resume) {
    state = JSON.parse(readFileSync(filename, 'utf8'));
    assert.deepEqual(state.identity, identity, 'resume inputs changed');
  } else {
    assert.equal(existsSync(directory), false, 'output exists; use --resume with the original manifest');
    mkdirSync(directory, { mode: 0o700 });
    state = { identity, peakActiveJobs: 0, peakTrainingJobs: 0, entries: datasets.map((entry, index) => ({ ...entry, index, name: `${options.runId}-${String(index + 1).padStart(3, '0')}`, observations: [] })) };
  }
  const save = () => { state.updatedAt = new Date().toISOString(); savePipelineJson(filename, state); };
  save();
  const recorder = new PipelineRecorder(options.chainConfig, directory);
  savePipelineJson(join(directory, 'chain-preflight.json'), await recorder.preflight());
  const policy = await session.get<{ backend: string; queue: { depth: number; max: number }; limits: { active_jobs_per_key?: number } }>('/api/teach/policy');
  savePipelineJson(join(directory, 'teach-policy.json'), policy);
  assert.equal(policy.backend, 'gradient', 'parallel training evidence requires the real gradient backend');
  assert.ok((policy.limits.active_jobs_per_key ?? 2) >= datasets.length, `set teach.activeJobsPerKey to at least ${datasets.length}`);
  assert.ok(policy.queue.max - policy.queue.depth >= state.entries.filter(entry => !entry.intent).length, 'insufficient training queue capacity');
  await parallelMap(state.entries, Math.min(concurrency, 8), async entry => {
    const response = await session.get<{ dataset: { sha256: string; rows: number; deleted_at?: number | null } }>(`/api/teach/datasets/${entry.datasetId}`);
    assert.equal(response.dataset.deleted_at ?? null, null, `dataset deleted: ${entry.datasetId}`);
    assert.equal(response.dataset.sha256, entry.sha256, 'dataset fingerprint changed');
    assert.equal(response.dataset.rows, entry.rows, 'dataset row count changed');
  });
  const observe = async (entry: ParallelEntry, job: TeachJobView) => {
    assert.equal(job.id, entry.jobId, 'job identity changed');
    assert.equal(job.dataset?.id, entry.datasetId, 'job belongs to another dataset');
    entry.status = job.status;
    const value = { run_id: options.runId, node: identity.node, teacher: identity.teacher, job_id: job.id,
      dataset_id: entry.datasetId, dataset_sha256: entry.sha256, rows: entry.rows, status: job.status,
      observed_at: new Date().toISOString(), result_sha256: job.result?.sha256 ?? null,
      progress: job.progress ?? null, error: job.error ?? null };
    const previous = entry.observations.at(-1);
    if (!previous || previous.value.status !== job.status) entry.observations.push({ value });
    save();
    for (let sequence = 0; sequence < entry.observations.length; sequence++) {
      const observation = entry.observations[sequence];
      if (!observation.receipt) {
        observation.receipt = await recorder.record(entry.index, options.runId, job.id, sequence, observation.value);
        save();
      }
    }
    entry.error = null;
    save();
  };
  const existing = await session.get<{ items: TeachJobView[] }>('/api/teach/jobs');
  assert.ok(Array.isArray(existing.items) && existing.items.length < 500, 'job list may be truncated');
  await parallelMap(state.entries, concurrency, async entry => {
    try {
      let job: TeachJobView;
      if (entry.jobId) job = (await session.get<{ job: TeachJobView }>(`/api/teach/jobs/${entry.jobId}`)).job;
      else if (entry.intent) {
        const matches = existing.items.filter(candidate => candidate.name === entry.name && candidate.dataset?.id === entry.datasetId);
        assert.equal(matches.length, 1, `uncertain submission for ${entry.name}; inspect it before retrying`);
        job = matches[0];
      } else {
        assert.ok(!existing.items.some(candidate => candidate.name === entry.name), 'run name already exists');
        entry.intent = { at: new Date().toISOString() };
        save();
        job = (await trainDataset(session, entry.datasetId, { name: entry.name, effort: 'balanced' })).job;
      }
      entry.jobId = job.id;
      entry.status = job.status;
      state.peakActiveJobs = Math.max(state.peakActiveJobs, state.entries.filter(item => item.status && active.has(item.status)).length);
      state.peakTrainingJobs = Math.max(state.peakTrainingJobs, state.entries.filter(item => item.status === 'TRAINING').length);
      save();
      await observe(entry, job);
    } catch (error) { entry.error = (error as Error).message; save(); }
  });
  const deadline = Date.now() + observeSeconds * 1000;
  while (Date.now() < deadline && state.entries.some(entry => entry.status && active.has(entry.status))) {
    const response = await session.get<{ items: TeachJobView[] }>('/api/teach/jobs');
    assert.ok(Array.isArray(response.items) && response.items.length < 500, 'job list may be truncated');
    const jobs = new Map(response.items.map(job => [job.id, job]));
    const current = state.entries.flatMap(entry => entry.jobId && jobs.has(entry.jobId) ? [jobs.get(entry.jobId)!] : []);
    state.peakActiveJobs = Math.max(state.peakActiveJobs, current.filter(job => active.has(job.status)).length);
    state.peakTrainingJobs = Math.max(state.peakTrainingJobs, current.filter(job => job.status === 'TRAINING').length);
    await parallelMap(state.entries.filter(entry => entry.jobId), concurrency, async entry => {
      try { assert.ok(jobs.has(entry.jobId!)); await observe(entry, jobs.get(entry.jobId!)!); }
      catch (error) { entry.error = (error as Error).message; save(); }
    });
    save();
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(10_000, remaining)));
  }
  state.observationFinished = true;
  save();
  const report = { runId: options.runId, requested: datasets.length, admitted: state.entries.filter(entry => entry.jobId).length,
    recorded: state.entries.filter(entry => entry.observations[0]?.receipt).length,
    peakActiveJobs: state.peakActiveJobs, peakTrainingJobs: state.peakTrainingJobs,
    terminal: state.entries.filter(entry => entry.status && !active.has(entry.status)).length,
    errors: state.entries.filter(entry => entry.error).map(entry => ({ name: entry.name, error: entry.error })),
    paths: state.entries.map(entry => ({ jobId: entry.jobId, status: entry.status, records: entry.observations.flatMap(observation => observation.receipt ? [observation.receipt] : []) })),
    scope: 'parallel teach job admission and finalized on-chain lifecycle paths; training execution uses the configured GPU slot limits' };
  savePipelineJson(join(directory, 'summary.json'), report);
  if (report.recorded !== datasets.length || report.errors.length) process.exitCode = 1;
  emit(ctx, report, value => JSON.stringify(value, null, 2));
  return report;
}
