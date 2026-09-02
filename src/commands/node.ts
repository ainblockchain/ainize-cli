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
import { logFile, pidFile, runningPid } from '../pid.js';
import { c, emit, fmtTime, info, kv, ok, shortAddr, table, warn } from '../output.js';
import { requireConfig } from './init.js';

export { runningPid };

export interface StartArgs { port?: number; peer?: string[]; detach?: boolean; roles?: string; publicUrl?: string; }


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

/** How long `start -d` waits for the child to answer /api/info before it reports the failure in node.log. */
const startTimeoutMs = () => Number(process.env.NGRAM_START_TIMEOUT_MS ?? 20_000);
/** How long `stop` waits for a SIGTERMed node to exit before escalating to SIGKILL. */
const stopGraceMs = () => Number(process.env.NGRAM_STOP_GRACE_MS ?? 10_000);

/** Last `n` lines of the node log — the only place a failed start ever wrote its reason. */
export function logTail(home: string, n = 20): string {
  try {
    const lines = readFileSync(logFile(home), 'utf8').replace(/\n$/, '').split('\n');
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

/** `start -d` could not confirm the node: drop the pid file nothing owns and show what node.log says. */
function startFailed(ctx: CliContext, why: string): never {
  try { unlinkSync(pidFile(ctx.home)); } catch { /* ignore */ }
  const tail = logTail(ctx.home, 20);
  throw new CliError(`${why} — it is not running.\n${c.dim(`${logFile(ctx.home)} (last ${tail ? tail.split('\n').length : 0} lines):`)}\n${tail || c.dim('(the log is empty)')}`);
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
    type Exit = { code: number | null; signal: NodeJS.Signals | null };
    const exited: Exit[] = [];
    child.once('exit', (code, signal) => { exited.push({ code, signal }); });
    writeFileSync(pidFile(ctx.home), String(child.pid));
    // Wait for the child to actually answer before claiming it started: a port already in use, a config the node
    // refuses, an unreachable chain — all of those used to print a green tick and a pid that was dead a
    // millisecond later, with the reason in node.log and nothing on screen (item 118).
    const probe = new NodeClient({ ...ctx, nodeUrl: `http://localhost:${cfg.port}`, token: null });
    const timeoutMs = startTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const exit = exited[0];
      if (exit) {
        child.unref();
        startFailed(ctx, `node exited while starting (${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`})`);
      }
      const info = await probe.get<InfoResponse>('/api/info', { auth: false, timeoutMs: 2000 }).catch(() => null);
      if (info && info.node.address.toLowerCase() === cfg.identity.address.toLowerCase()) break;
      if (Date.now() > deadline) {
        child.unref();
        startFailed(ctx, info
          ? `port ${cfg.port} is answered by "${info.node.name}" (${shortAddr(info.node.address, 8)}), not by the node in ${ctx.home}`
          : `node did not answer on http://localhost:${cfg.port} within ${timeoutMs / 1000} s`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    child.unref();
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

/** Poll until the process is gone; false when it is still alive after `ms`. */
async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function stop(ctx: CliContext): Promise<{ stopped: boolean; pid: number | null; killed?: boolean }> {
  const pid = runningPid(ctx.home);
  if (!pid) {
    try { unlinkSync(pidFile(ctx.home)); } catch { /* ignore */ }
    info(ctx, c.dim('no background node running for this NGRAM_HOME'));
    // …but something may still be serving this home's node (started in the foreground, or by a supervisor):
    // saying nothing at all is how an operator ends up with a node no command of theirs can manage (item 119).
    const cfg = ctx.cfg;
    if (cfg) {
      const probe = new NodeClient({ ...ctx, nodeUrl: `http://localhost:${cfg.port}`, token: null });
      const d = await probe.get<InfoResponse>('/api/info', { auth: false, timeoutMs: 1500 }).catch(() => null);
      if (d && d.node.address.toLowerCase() === cfg.identity.address.toLowerCase()) {
        warn(ctx, `this node is still serving on http://localhost:${cfg.port} — it was not started by \`${PROG} start -d\` (foreground, or a supervisor), so stop it where it was started`);
      }
    }
    return { stopped: false, pid: null };
  }
  process.kill(pid, 'SIGTERM');
  // The wait loop's outcome was never checked: `stop` printed the tick and deleted the pid file even when the
  // process was still there, leaving a node nothing could manage afterwards (item 119).
  let killed = false;
  const grace = stopGraceMs();
  if (!(await waitGone(pid, grace))) {
    warn(ctx, `node ${pid} is still running ${grace / 1000} s after SIGTERM — sending SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* it exited in between */ }
    killed = true;
    if (!(await waitGone(pid, 5000))) {
      throw new CliError(`node ${pid} did not stop (still running after SIGTERM and SIGKILL) — kill it manually (\`kill -9 ${pid}\`); ${pidFile(ctx.home)} kept so \`${PROG} stop\` can try again`);
    }
  }
  try { unlinkSync(pidFile(ctx.home)); } catch { /* ignore */ }
  ok(ctx, `stopped node (pid ${pid})${killed ? c.dim(' — it ignored SIGTERM, so it was killed') : ''}`);
  return { stopped: true, pid, killed };
}

export interface InfoResponse {
  node: { address: string; name: string; endpoint: string; roles: string[]; ledger: string; model?: string; branches: string[]; blobs: string[]; version: string; build?: string; config_version?: string };
  ledger: { kind: string; network: string; height?: number; records: number; provider?: string; head?: string };
  runtime: { available: boolean; api: string | null; model: string | null; hook: boolean; repo: string | null; error?: string };
  quorum: number; currency: string; peers: number; counts: { patches: number; listed: number };
}

/** What build is actually running — with the config's own version only when it differs (item 141). */
export function nodeVersion(n: InfoResponse['node']): string {
  const built = n.build ? ` · built ${fmtTime(Date.parse(n.build))}` : '';
  const written = n.config_version && n.config_version !== n.version ? c.dim(`  (config.json written by ${n.config_version})`) : '';
  return `${n.version}${built}${written}`;
}

export interface ReadyResponse {
  ok: boolean; node: string; address: string; version: string;
  checks: {
    ledger: { ok: boolean; kind: string; height: number | null; records: number | null; error?: string };
    runtime: { ok: boolean; required: boolean; available: boolean; model: string | null; error?: string };
    peers: { ok: boolean; configured: number; unreachable: number };
  };
}

/**
 * `status --check`: the node's own readiness, for a monitor or a deploy script. Exit 1 when a check fails —
 * `/api/info` answers 200 whether the model server is up or down, so it could never be a health check (item 134).
 */
export async function statusCheck(ctx: CliContext): Promise<ReadyResponse> {
  const res = await new NodeClient(ctx).get<Response>('/readyz', { auth: false, raw: true });
  if (res.status === 404) throw new CliError(`${ctx.nodeUrl} has no /readyz — it is running a build older than this CLI`, 2);
  const d = (await res.json()) as ReadyResponse;
  emit(ctx, d, (x) => [
    (x.ok ? c.ok('✓ ') : c.err('✗ ')) + c.bold(x.node) + c.dim(`  ${ctx.nodeUrl}`) + (x.ok ? '' : c.err('  NOT READY')),
    kv([
      ['ledger', x.checks.ledger.ok ? c.ok(`ok · ${x.checks.ledger.kind}${x.checks.ledger.height === null ? '' : ` · height ${x.checks.ledger.height}`}`) : c.err(x.checks.ledger.error ?? 'unreachable')],
      ['runtime', !x.checks.runtime.required ? c.dim('not required by this node\'s roles')
        : x.checks.runtime.ok ? c.ok(`ok · ${x.checks.runtime.model}`) : c.err(x.checks.runtime.error ?? 'unavailable')],
      ['peers', `${x.checks.peers.configured} configured${x.checks.peers.unreachable ? c.warn(` · ${x.checks.peers.unreachable} unreachable`) : ''}`],
    ]),
  ].join('\n'));
  if (!d.ok) process.exitCode = 1;
  return d;
}

export async function status(ctx: CliContext): Promise<InfoResponse> {
  const client = new NodeClient(ctx);
  const d = await client.get<InfoResponse>('/api/info', { auth: false });
  const pid = runningPid(ctx.home);
  // Whatever answers the configured port is not necessarily this home's node: after a failed start it is usually
  // someone else's, and the whole block below — address, roles, ledger height, catalogue — would be theirs (item 118).
  const mine = ctx.cfg?.identity.address;
  const stranger = !!mine && d.node.address.toLowerCase() !== mine.toLowerCase();
  if (stranger) {
    warn(ctx, `${ctx.nodeUrl} is answered by "${d.node.name}" (${shortAddr(d.node.address, 8)}), not the node in ${ctx.home} (${shortAddr(mine!, 8)}) — that node is not running.\n  ${c.dim('everything below belongs to that other node.')}`);
  }
  emit(ctx, { ...d, pid, is_this_home: !stranger }, (x) => [
    c.bold(`${x.node.name}`) + c.dim(`  ${x.node.endpoint}${pid ? `  (pid ${pid})` : ''}`),
    kv([
      ['address', x.node.address], ['roles', x.node.roles.join(', ')], ['version', nodeVersion(x.node)],
      ['ledger', `${x.ledger.kind} · ${x.ledger.network}${x.ledger.provider ? ` · ${x.ledger.provider}` : ''} · ${x.ledger.records} records${x.ledger.height !== undefined ? ` · height ${x.ledger.height}` : ''}`],
      ['runtime', x.runtime.available ? c.ok(`available · ${x.runtime.model} · hook ok`) : c.warn(`unavailable${x.runtime.error ? ` (${x.runtime.error})` : ''}`)],
      ['peers', x.peers], ['patches', `${x.counts.patches} (${x.counts.listed} listed)`], ['quorum', x.quorum], ['currency', x.currency],
      ['branches', x.node.branches.join(', ') || '-'], ['blobs held', x.node.blobs.length],
    ]),
  ].join('\n'));
  // exit 2 = "the node you asked about is not there" — the same code the client uses for an unreachable node,
  // so a health check built on `ainize status` fails when this home's node is down and a stranger holds its port.
  if (stranger) process.exitCode = 2;
  return d;
}

export interface EventRow { seq: number; ts: number; level: string; kind: string; patch_id: string | null; message: string; data: unknown; }

export async function logs(ctx: CliContext, a: { follow?: boolean; patch?: string; limit?: number; kind?: string; level?: string } = {}): Promise<EventRow[]> {
  const client = new NodeClient(ctx);
  const fetchEvents = async (since?: number) => {
    const path = a.patch
      ? `/api/patches/${encodeURIComponent(a.patch)}/events${query({ limit: a.limit ?? 100 })}`
      : `/api/events${query({ limit: a.limit ?? 100, kind: a.kind, level: a.level, since })}`;
    // send the operator token: without it the operator's own terminal was served the redacted visitor stream,
    // where every `draft …` line is dropped — so `logs --kind patch` printed a blank screen on a busy node (item 132)
    const r = await client.get<{ events: EventRow[] }>(path);
    return [...r.events].sort((x, y) => x.seq - y.seq);
  };
  const render = (rows: EventRow[]) => rows.map((e) => {
    const lvl = e.level === 'error' ? c.err(e.level.padEnd(5)) : e.level === 'warn' ? c.warn(e.level.padEnd(5)) : c.dim(e.level.padEnd(5));
    return `${c.dim(fmtTime(e.ts))} ${lvl} ${c.id(e.kind.padEnd(9))} ${e.patch_id ? c.dim(`[${e.patch_id}] `) : ''}${e.message}`;
  }).join('\n');
  const filters = [a.patch && `patch ${a.patch}`, a.kind && `kind '${a.kind}'`, a.level && `level ${a.level} or worse`].filter(Boolean).join(', ');
  const empty = () => c.dim(filters ? `(no events match ${filters}${ctx.token ? '' : ` — and you are not logged in, so teach and draft lines are hidden; run \`${PROG} login\``})` : '(no events yet)');
  let rows = await fetchEvents();
  if (!a.follow) { emit(ctx, rows, (r) => (r.length ? render(r) : empty())); return rows; }
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
