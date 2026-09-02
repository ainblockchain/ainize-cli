/**
 * `ainize start|stop|status|logs|seed` — node lifecycle.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEnv, type NodeConfig } from '@ngram/core';
import { startNode, seedDemo, type RunningNode, type SeedOptions, type SeedReport } from '@ngram/node';
import { NodeClient, query } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, fmtTime, info, kv, ok, shortAddr, table, warn } from '../output.js';
import { requireConfig } from './init.js';

export interface StartArgs { port?: number; peer?: string[]; detach?: boolean; roles?: string; publicUrl?: string; }

const pidFile = (home: string) => join(home, 'node.pid');
const logFile = (home: string) => join(home, 'node.log');

function binPath(): string {
  // dist/commands/node.js → dist/bin.js  (or src/commands/node.ts → src/bin.ts under tsx)
  const here = dirname(fileURLToPath(import.meta.url));
  const js = resolve(here, '..', 'bin.js');
  return existsSync(js) ? js : resolve(here, '..', 'bin.ts');
}

function applyArgs(cfg: NodeConfig, a: StartArgs): NodeConfig {
  if (a.port) cfg.port = a.port;
  if (a.peer?.length) cfg.peers = [...new Set([...cfg.peers, ...a.peer])];
  if (a.roles) cfg.roles = a.roles.split(',').map((s) => s.trim()).filter(Boolean) as NodeConfig['roles'];
  if (a.publicUrl) cfg.publicUrl = a.publicUrl;
  return cfg;
}

export function runningPid(home: string): number | null {
  const p = pidFile(home);
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, 'utf8').trim());
  if (!Number.isFinite(pid)) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

/** Start the node in-process (returns when it is listening; caller keeps the event loop alive) or detached. */
export async function start(ctx: CliContext, a: StartArgs = {}): Promise<RunningNode | { detached: true; pid: number; log: string }> {
  const cfg = applyArgs(applyEnv(requireConfig(ctx)), a);
  if (a.detach) {
    const existing = runningPid(ctx.home);
    if (existing) throw new CliError(`node already running in the background (pid ${existing}) — \`${PROG} stop\` first`);
    mkdirSync(ctx.home, { recursive: true });
    const out = openSync(logFile(ctx.home), 'a');
    const args = [...process.execArgv, binPath(), 'start', '--home', ctx.home];
    if (a.port) args.push('--port', String(a.port));
    for (const p of a.peer ?? []) args.push('--peer', p);
    if (a.roles) args.push('--roles', a.roles);
    if (a.publicUrl) args.push('--public-url', a.publicUrl);
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env: { ...process.env, NGRAM_HOME: ctx.home } });
    child.unref();
    writeFileSync(pidFile(ctx.home), String(child.pid));
    ok(ctx, `node started in the background (pid ${child.pid}) — port ${cfg.port}\n  ${c.dim(`logs: ${logFile(ctx.home)}   stop: ${PROG} stop`)}`);
    return { detached: true, pid: child.pid!, log: logFile(ctx.home) };
  }
  const node = await startNode(cfg, { home: ctx.home, quiet: ctx.quiet });
  writeFileSync(pidFile(ctx.home), String(process.pid));
  const cleanup = async () => { try { unlinkSync(pidFile(ctx.home)); } catch { /* ignore */ } await node.stop(); process.exit(0); };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  return node;
}

export async function stop(ctx: CliContext): Promise<{ stopped: boolean; pid: number | null }> {
  const pid = runningPid(ctx.home);
  if (!pid) {
    try { unlinkSync(pidFile(ctx.home)); } catch { /* ignore */ }
    info(ctx, c.dim('no background node running for this NGRAM_HOME'));
    return { stopped: false, pid: null };
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { break; }
  }
  try { unlinkSync(pidFile(ctx.home)); } catch { /* ignore */ }
  ok(ctx, `stopped node (pid ${pid})`);
  return { stopped: true, pid };
}

export interface InfoResponse {
  node: { address: string; name: string; endpoint: string; roles: string[]; ledger: string; model?: string; branches: string[]; blobs: string[]; version: string };
  ledger: { kind: string; network: string; height?: number; records: number; provider?: string; head?: string };
  runtime: { available: boolean; api: string | null; model: string | null; hook: boolean; repo: string | null; error?: string };
  quorum: number; currency: string; peers: number; counts: { patches: number; listed: number };
}

export async function status(ctx: CliContext): Promise<InfoResponse> {
  const client = new NodeClient(ctx);
  const d = await client.get<InfoResponse>('/api/info', { auth: false });
  const pid = runningPid(ctx.home);
  emit(ctx, { ...d, pid }, (x) => [
    c.bold(`${x.node.name}`) + c.dim(`  ${x.node.endpoint}${pid ? `  (pid ${pid})` : ''}`),
    kv([
      ['address', x.node.address], ['roles', x.node.roles.join(', ')], ['version', x.node.version],
      ['ledger', `${x.ledger.kind} · ${x.ledger.network}${x.ledger.provider ? ` · ${x.ledger.provider}` : ''} · ${x.ledger.records} records${x.ledger.height !== undefined ? ` · height ${x.ledger.height}` : ''}`],
      ['runtime', x.runtime.available ? c.ok(`available · ${x.runtime.model} · hook ok`) : c.warn(`unavailable${x.runtime.error ? ` (${x.runtime.error})` : ''}`)],
      ['peers', x.peers], ['patches', `${x.counts.patches} (${x.counts.listed} listed)`], ['quorum', x.quorum], ['currency', x.currency],
      ['branches', x.node.branches.join(', ') || '-'], ['blobs held', x.node.blobs.length],
    ]),
  ].join('\n'));
  return d;
}

export interface EventRow { seq: number; ts: number; level: string; kind: string; patch_id: string | null; message: string; data: unknown; }

export async function logs(ctx: CliContext, a: { follow?: boolean; patch?: string; limit?: number; kind?: string } = {}): Promise<EventRow[]> {
  const client = new NodeClient(ctx);
  const fetchEvents = async (since?: number) => {
    const path = a.patch ? `/api/patches/${encodeURIComponent(a.patch)}/events${query({ limit: a.limit ?? 100 })}` : `/api/events${query({ limit: a.limit ?? 100, kind: a.kind, since })}`;
    const r = await client.get<{ events: EventRow[] }>(path, { auth: false });
    return [...r.events].sort((x, y) => x.seq - y.seq);
  };
  const render = (rows: EventRow[]) => rows.map((e) => {
    const lvl = e.level === 'error' ? c.err(e.level.padEnd(5)) : e.level === 'warn' ? c.warn(e.level.padEnd(5)) : c.dim(e.level.padEnd(5));
    return `${c.dim(fmtTime(e.ts))} ${lvl} ${c.id(e.kind.padEnd(9))} ${e.patch_id ? c.dim(`[${e.patch_id}] `) : ''}${e.message}`;
  }).join('\n');
  let rows = await fetchEvents();
  if (!a.follow) { emit(ctx, rows, render); return rows; }
  emit(ctx, rows, render);
  let since = rows.length ? rows[rows.length - 1].ts : Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const more = (await fetchEvents(since)).filter((e) => e.ts > since);
    if (more.length) { emit(ctx, more, render); since = more[more.length - 1].ts; rows = rows.concat(more); }
  }
}

export async function seed(ctx: CliContext, opts: SeedOptions = {}): Promise<SeedReport> {
  const cfg = applyEnv(requireConfig(ctx));
  const client = new NodeClient(ctx);
  if (await client.alive()) {
    throw new CliError(`a node is running at ${ctx.nodeUrl}; seeding writes to its data directory — stop it first (\`${PROG} stop\`) or seed from the web console`);
  }
  const node = await startNode(cfg, { home: ctx.home, listen: false, quiet: true, serveWeb: false });
  try {
    const rep = await seedDemo(node.market, opts);
    emit(ctx, rep, (r) => [
      c.ok('✓ ') + `seeded: ${r.created.length} patch(es), ${r.branches.length} branch(es), ${r.imported_prototype} prototype record(s) imported`,
      r.created.length ? '  created:  ' + r.created.join(', ') : '',
      r.branches.length ? '  branches: ' + r.branches.join(', ') : '',
      r.skipped.length ? c.dim('  skipped (already present): ' + r.skipped.join(', ')) : '',
    ].filter(Boolean).join('\n'));
    return rep;
  } finally {
    await node.stop();
  }
}

export async function nodesTable(ctx: CliContext): Promise<{ nodes: unknown[]; peers: unknown[]; self: string }> {
  const client = new NodeClient(ctx);
  const d = await client.get<{ nodes: InfoResponse['node'][] & { last_seen?: number }[]; peers: { endpoint: string; address: string | null; last_seen: number; failures: number }[]; self: string }>('/api/nodes', { auth: false });
  emit(ctx, d, (x) => [
    c.head('known nodes'),
    table(x.nodes as (InfoResponse['node'] & { last_seen?: number })[], [
      { key: 'name', title: 'NAME', get: (n) => (n.address === x.self ? c.bold(n.name + ' (self)') : n.name) },
      { key: 'addr', title: 'ADDRESS', get: (n) => shortAddr(n.address, 8) },
      { key: 'ep', title: 'ENDPOINT', get: (n) => n.endpoint },
      { key: 'roles', title: 'ROLES', get: (n) => n.roles.join(',') },
      { key: 'ledger', title: 'LEDGER', get: (n) => n.ledger },
      { key: 'branches', title: 'BRANCHES', get: (n) => n.branches.join(',') || '-' },
      { key: 'blobs', title: 'BLOBS', get: (n) => String(n.blobs.length), align: 'right' },
      { key: 'seen', title: 'LAST SEEN', get: (n) => fmtTime(n.last_seen) },
    ]),
    '', c.head('configured peers'),
    table(x.peers, [
      { key: 'ep', title: 'ENDPOINT', get: (p) => p.endpoint },
      { key: 'addr', title: 'ADDRESS', get: (p) => shortAddr(p.address, 8) },
      { key: 'seen', title: 'LAST SEEN', get: (p) => fmtTime(p.last_seen) },
      { key: 'fail', title: 'FAILURES', get: (p) => (p.failures ? c.warn(String(p.failures)) : '0'), align: 'right' },
    ]),
  ].join('\n'));
  return d;
}

export { warn };
