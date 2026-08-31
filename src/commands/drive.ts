/**
 * `ngram drive status|up|stop|sync|login` — aindrive integration (files & change history of the node).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { NodeClient } from '../client.js';
import { CliError, type CliContext } from '../context.js';
import { c, emit, fmtBytes, fmtTime, kv, ok, table } from '../output.js';
import { requireConfig } from './init.js';

const require = createRequire(import.meta.url);

export const DEFAULT_AINDRIVE_SERVER = process.env.AINDRIVE_SERVER ?? 'https://aindrive.ainetwork.ai';

export function aindriveBin(): string {
  try { return require.resolve('aindrive/dist/aindrive.mjs'); } catch { throw new CliError('aindrive CLI not installed (npm install aindrive)'); }
}

export interface DriveStatus { configured: boolean; running: boolean; pid: number | null; folder: string; server: string | null; drive_id: string | null; url: string | null; login_hint: string; files: { path: string; size: number; mtime: number }[]; cli?: string; }

export async function driveStatus(ctx: CliContext, a: { files?: boolean } = {}): Promise<DriveStatus> {
  const d = await new NodeClient(ctx).get<DriveStatus>('/api/drive', { auth: false });
  emit(ctx, d, (x) => [
    kv([
      ['folder', x.folder], ['paired', x.configured ? c.ok('yes') : c.warn('no — run `ngram drive login`')], ['agent', x.running ? c.ok(`running (pid ${x.pid})`) : c.dim('stopped')],
      ['server', x.server ?? '-'], ['drive id', x.drive_id ?? '-'], ['url', x.url ? c.id(x.url) : '-'], ['files', x.files.length],
    ]),
    a.files ? '\n' + table(x.files.slice(0, 200), [
      { key: 'p', title: 'PATH', get: (f) => f.path }, { key: 's', title: 'SIZE', get: (f) => fmtBytes(f.size), align: 'right' }, { key: 't', title: 'MODIFIED', get: (f) => fmtTime(f.mtime) },
    ]) : '',
  ].filter(Boolean).join('\n'));
  return d;
}

export async function driveAction(ctx: CliContext, action: 'up' | 'stop' | 'sync' | 'status'): Promise<unknown> {
  const r = await new NodeClient(ctx).post<{ ok?: boolean; message?: string; written?: number }>('/api/drive', { action }, { timeoutMs: 120_000 });
  emit(ctx, r, (x) => {
    if (action === 'sync') return c.ok('✓ ') + `drive folder synced (${x.written ?? 0} file(s) written)`;
    return (x.ok === false ? c.warn('! ') : c.ok('✓ ')) + (x.message ?? JSON.stringify(x));
  });
  return r;
}

/** One-time browser pairing: runs `aindrive login` interactively inside the node's drive folder. */
export async function driveLogin(ctx: CliContext, a: { server?: string; name?: string; noOpen?: boolean } = {}): Promise<number> {
  const cfg = requireConfig(ctx);
  const folder = join(cfg.dataDir, 'drive');
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  const server = a.server ?? DEFAULT_AINDRIVE_SERVER;
  const args = [aindriveBin(), 'login', '--server', server];
  if (a.name) args.push('--name', a.name);
  if (a.noOpen || !process.env.DISPLAY) args.push('--no-open');
  process.stdout.write([
    c.head('aindrive pairing'),
    `  folder : ${folder}`, `  server : ${server}`,
    c.dim('  A browser sign-in link will be printed — open it, click Authorize, and this folder becomes a drive.'),
    c.dim('  After pairing, Ctrl+C here and run `ngram drive up` to serve it in the background.'), '',
  ].join('\n'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: folder, stdio: 'inherit', env: { ...process.env, AINDRIVE_SERVER: server } });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

export { ok };
