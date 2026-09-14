import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultConfig, teachConfig } from '@ainize/core';
import { startNode } from '@ainize/node';

test('teach <file> creates one dataset-backed job and preserves explicit subcommands', { timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-teach-direct-'));
  const config = defaultConfig({ home, name: 'direct-teach-test', port: 3400, ledger: 'local', roles: ['serving'] });
  config.runtime = { api: 'http://127.0.0.1:1' };
  config.teach = { ...teachConfig(config), enabled: true, backend: 'stub', stubOffline: true };
  const node = await startNode(config, { home, quiet: true, listen: false, serveWeb: false });
  try {
    await new Promise<void>(resolve => node.server.listen(0, '127.0.0.1', resolve));
    const port = (node.server.address() as { port: number }).port;
    const invoke = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/bin.ts',
        ...args, '--home', home, '--node', `http://127.0.0.1:${port}`, '--json'], { timeout: 15000 });
      return JSON.parse(stdout);
    };
    const file = join(home, 'questions.jsonl');
    writeFileSync(file, JSON.stringify({ prompt: 'What is the test island capital?', answer: 'Test Harbor' }) + '\n');
    const result = await invoke('teach', file, '--effort', 'quick');
    assert.ok(result.job.id);
    assert.ok(result.dataset_id);
    const jobs = await invoke('teach', 'jobs', '--dataset', result.dataset_id);
    assert.equal(jobs.items.length, 1);
    assert.equal(jobs.items[0].id, result.job.id);
    const dataset = await invoke('teach', 'dataset', 'get', result.dataset_id);
    assert.equal(dataset.dataset.rows, 1);
    const retrained = await invoke('teach', result.dataset_id, '--effort', 'quick');
    assert.equal(retrained.dataset_id, result.dataset_id);
    assert.notEqual(retrained.job.id, result.job.id);
    const legacy = await invoke('teach', 'train', file, '--effort', 'quick');
    assert.equal(legacy.dataset_id, result.dataset_id);
    const status = await invoke('teach', 'status', result.job.id);
    assert.equal(status.job.id, result.job.id);
  } finally {
    await node.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
