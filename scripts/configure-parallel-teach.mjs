import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [home, backup, requested = '70'] = process.argv.slice(2);
const count = Number(requested);
assert.ok(home && backup && Number.isInteger(count) && count >= 1 && count <= 1000);
mkdirSync(backup, { mode: 0o700 });
const destination = join(backup, 'config-before.json');
copyFileSync(join(home, 'config.json'), destination);
chmodSync(destination, 0o600);
for (const [key, value] of [['teach.activeJobsPerKey', count], ['teach.dataset.createsPerIpPerMin', 120]]) {
  execFileSync(process.execPath, ['/opt/ainize/ainize-cli/dist/bin.js', '--home', home, 'config', 'set', key, String(value)], { stdio: 'inherit' });
}
