import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildContext } from '../dist/context.js';
import { datasetUpload } from '../dist/commands/teach-dataset.js';

const [root, output, requested = '70'] = process.argv.slice(2);
const count = Number(requested);
assert.ok(root && output && Number.isInteger(count) && count > 0 && count <= 100);
const registrationRoot = join(root, 'kpi/evidence/ainize_datasets100_20260911');
const registration = JSON.parse(readFileSync(join(registrationRoot, 'progress.json'), 'utf8'));
const lifecycle = JSON.parse(readFileSync(join(root, 'kpi/evidence/ainize_lifecycle100_20260911/progress.json'), 'utf8'));
assert.equal(registration.datasets.length, 100);
const trained = new Set(lifecycle.entries.filter(entry => entry.jobId).map(entry => entry.datasetId));
const selected = registration.datasets.filter(entry => !trained.has(entry.datasetId)).slice(0, count);
assert.equal(selected.length, count, 'not enough unsubmitted datasets in the original 100');
for (const entry of selected) {
  assert.equal(entry.ok, true);
  const bytes = readFileSync(join(registrationRoot, `${entry.lessonId}-canonical.jsonl`));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.canonicalSha256);
}
mkdirSync(output, { recursive: true, mode: 0o700 });
const progressPath = join(output, 'registration.json');
const bindings = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, 'utf8')) : [];
assert.ok(bindings.length <= count);
const context = buildContext({ home: join(root, 'kpi/ainize/home-docker'), node: 'http://localhost:3410', json: true, quiet: true });
for (let index = 0; index < selected.length; index++) {
  const entry = selected[index];
  if (bindings[index]) {
    assert.equal(bindings[index].sourceDatasetId, entry.datasetId);
    assert.equal(bindings[index].sha256, entry.canonicalSha256);
    continue;
  }
  const result = await datasetUpload(context, join(registrationRoot, `${entry.lessonId}-canonical.jsonl`), { name: entry.lessonId, retention: 'keep', silent: true });
  assert.equal(result.dataset.sha256, entry.canonicalSha256);
  assert.equal(result.dataset.rows, entry.rows);
  assert.equal(result.dataset.deleted_at ?? null, null);
  bindings.push({ lessonId: entry.lessonId, sourceDatasetId: entry.datasetId, datasetId: result.dataset.id, sha256: result.dataset.sha256, rows: result.dataset.rows, created: result.created });
  writeFileSync(progressPath, JSON.stringify(bindings, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ index: index + 1, lessonId: entry.lessonId, datasetId: result.dataset.id, created: result.created }));
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify(bindings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
