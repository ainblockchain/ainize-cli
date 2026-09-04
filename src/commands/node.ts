/**
 * `ainize start|stop|status|logs|seed` — node lifecycle.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { applyEnv, type NodeConfig } from '@ngram/core';
import { startNode, seedDemo, humanBytes, type DiskReport, type GcCandidate, type RunningNode, type SeedOptions, type SeedReport } from '@ngram/node';
import { NodeClient, query } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { logFile, pidFile, runningPid } from '../pid.js';
import { c, emit, fmtTime, info, kv, ok, shortAddr, table, warn } from '../output.js';
import { blockedLines, peerColumns, ledgerMismatchLines, type BlockedPeer, type PeerRow, type PeerStatus } from './peers.js';
import { assertUsableConfig, requireConfig } from './init.js';
import { promptLine } from './auth.js';

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

/** Above this, `start -d` rolls node.log aside before appending (item 128: nothing ever rotated it). */
export const LOG_MAX_BYTES = Number(process.env.NGRAM_LOG_MAX_BYTES ?? 32 * 1000 ** 2);
/** How many rolled generations are kept (node.log.1 … node.log.N). */
export const LOG_GENERATIONS = 2;

/**
 * Roll node.log when it has grown past `LOG_MAX_BYTES`, keeping `LOG_GENERATIONS` older copies (item 128).
 * `start -d` opened the file with 'a' and nothing ever truncated it, so a long-lived node's only crash log was
 * also an unbounded consumer of the same volume as the blob store.
 */
export function rotateLog(home: string): boolean {
  const file = logFile(home);
  let size = 0;
  try { size = statSync(file).size; } catch { return false; }
  if (size < LOG_MAX_BYTES) return false;
  try { unlinkSync(`${file}.${LOG_GENERATIONS}`); } catch { /* there may be none */ }
  for (let i = LOG_GENERATIONS - 1; i >= 1; i--) {
    try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* there may be none */ }
  }
  try { renameSync(file, `${file}.1`); return true; } catch { return false; }
}

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
  const cfg = assertUsableConfig(applyArgs(applyEnv(requireConfig(ctx)), a), ctx.home);
  const existing = runningPid(ctx.home);
  // (the child `start -d` spawns finds its own pid in node.pid — the parent wrote it before the child ran)
  if (existing && existing !== process.pid) throw new CliError(`node already running in the background (pid ${existing}) — \`${PROG} stop\` first`);
  // Whoever already answers the port is not the child about to be spawned. When it is this home's own node —
  // started in the foreground or by a supervisor, so there is no pid file — the start-up probe below would have
  // matched the identity and printed the tick for a child that died on EADDRINUSE a moment later (item 118).
  const probe = new NodeClient({ ...ctx, nodeUrl: `http://localhost:${cfg.port}`, token: null });
  const holder = await probe.get<InfoResponse>('/api/info', { auth: false, timeoutMs: 2000 }).catch(() => null);
  if (holder) {
    throw new CliError(holder.node.address.toLowerCase() === cfg.identity.address.toLowerCase()
      ? `this node is already serving on http://localhost:${cfg.port} — it was not started by \`${PROG} start -d\` (foreground, or a supervisor), so stop it where it was started before starting it here`
      : `port ${cfg.port} is already answered by "${holder.node.name}" (${shortAddr(holder.node.address, 8)}), not the node in ${ctx.home} — stop that node, or move this one: \`${PROG} config set port <1-65535>\``);
  }
  if (a.detach) {
    mkdirSync(ctx.home, { recursive: true });
    rotateLog(ctx.home);
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
  /** item 170: how many peers ANSWERED, how many of those verify, and which are on a ledger this node cannot read. */
  peer_status?: PeerStatus;
  /** item 128: bytes held on disk, and what is free on the volume. Absent on nodes older than this CLI. */
  disk?: DiskReport;
}

/** `1.1 GB (bodies 932 MB · sets 0 B · uploads 115 MB · db 9 MB) · 12 GB free` — item 128. */
export function diskLine(d: DiskReport | undefined, showReclaimable = true): string {
  if (!d) return c.dim('not reported by this node (older build)');
  const parts = `bodies ${humanBytes(d.blobs)} · sets ${humanBytes(d.datasets)} · uploads ${humanBytes(d.uploads)} · db ${humanBytes(d.db)}${d.log ? ` · log ${humanBytes(d.log)}` : ''}`;
  const tight = d.free !== null && d.size !== null && (d.free < 2 * 1000 ** 3 || d.free / d.size < 0.05);
  const free = d.free === null ? '' : `${c.dim(' · ')}${tight ? c.warn(`${humanBytes(d.free)} free`) : `${humanBytes(d.free)} free`}`;
  const reclaim = showReclaimable && d.reclaimable_bytes > 0
    ? c.dim(`\n${humanBytes(d.reclaimable_bytes)} in ${d.reclaimable_files} verification cop${d.reclaimable_files === 1 ? 'y' : 'ies'} — \`${PROG} gc\` frees it`) : '';
  return `${humanBytes(d.total)} ${c.dim(`(${parts})`)}${free}${reclaim}`;
}

/** `2 published here, 1 bought, 1 fetched too recently` — why the bodies that stayed, stayed. */
const keptLine = (kept: Record<string, number>): string => {
  const label: Record<string, string> = {
    authored: 'published by this node', purchased: 'bought', applied: 'loaded in the model', draft: 'unpublished drafts',
    unlisted: 'not on the record', too_new: 'fetched too recently', sole_copy: 'the only copy left',
  };
  const parts = Object.entries(kept).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${label[k] ?? k.replace(/_/g, ' ')}`);
  return parts.length ? c.dim(`kept: ${parts.join(', ')}`) : '';
};

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

/** `3 known · 3 answered · 2 verifiers` — the peer count alone said nothing about whether anyone was there (item 170). */
export function peersLine(st: PeerStatus | undefined, fallback: number): string {
  if (!st) return String(fallback);
  const parts = [`${st.known} known`, st.reachable === st.known ? c.ok(`${st.reachable} answered`) : c.warn(`${st.reachable} answered`)];
  parts.push(st.verifiers ? `${st.verifiers} verifier${st.verifiers === 1 ? '' : 's'}` : c.warn('0 verifiers'));
  if (st.ledger_mismatch) parts.push(c.warn(`${st.ledger_mismatch} on another ledger`));
  return parts.join(c.dim(' · '));
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
      ['peers', peersLine(x.peer_status, x.peers)], ['patches', `${x.counts.patches} (${x.counts.listed} listed)`], ['quorum', x.quorum], ['currency', x.currency],
      ['branches', x.node.branches.join(', ') || '-'], ['blobs held', `${x.node.blobs.length}${x.disk ? c.dim(` of ${x.disk.blob_files} files on disk`) : ''}`],
      ['disk', diskLine(x.disk)],
    ]),
    ...ledgerMismatchLines(x.peer_status),
  ].filter(Boolean).join('\n'));
  // exit 2 = "the node you asked about is not there" — the same code the client uses for an unreachable node,
  // so a health check built on `ainize status` fails when this home's node is down and a stranger holds its port.
  if (stranger) process.exitCode = 2;
  return d;
}

/** `18s` / `12m` / `4h 03m` / `9d` — an age a column can hold, for the SEEN column and the peer state. */
export function relAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.round(h / 24)}d`;
}

export interface EventRow { seq: number; ts: number; level: string; kind: string; patch_id: string | null; message: string; data: unknown; }

/** warn is "warnings and worse", the question an operator asks — the same floor `/api/events` applies. */
const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * The event table read straight from `<dataDir>/node.sqlite` (item 131).
 *
 * `ainize logs` fetched `/api/events` over HTTP, so it worked only while the node was up — and a crash is precisely
 * when the log is needed. The rows are in the node's own database either way; this reads them with no node. Opened
 * read-only when SQLite allows it (a WAL left behind by a kill needs a writable open to be replayed).
 */
export function offlineEvents(dataDir: string, a: { limit?: number; kind?: string; level?: string; patch?: string } = {}): EventRow[] {
  const file = join(dataDir, 'node.sqlite');
  if (!existsSync(file)) throw new CliError(`no node database at ${file} — no node has ever run in this home`, 2);
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { readOnly: true }); }
  catch { db = new DatabaseSync(file); }
  try {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (a.patch) { where.push('patch_id = ?'); args.push(a.patch); }
    if (a.kind) { where.push('kind = ?'); args.push(a.kind); }
    if (a.level && LEVELS.includes(a.level)) {
      const wanted = LEVELS.slice(LEVELS.indexOf(a.level));
      where.push(`level IN (${wanted.map(() => '?').join(', ')})`);
      args.push(...wanted);
    }
    const sql = `SELECT seq, ts, level, kind, patch_id, message, data FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ${Number(a.limit ?? 100)}`;
    const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: r.seq as number, ts: r.ts as number, level: r.level as string, kind: r.kind as string,
      patch_id: (r.patch_id as string) ?? null, message: r.message as string,
      data: r.data ? (() => { try { return JSON.parse(r.data as string); } catch { return null; } })() : null,
    })).sort((x, y) => x.seq - y.seq);
  } finally { db.close(); }
}

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
  let rows: EventRow[];
  try {
    rows = await fetchEvents();
  } catch (e) {
    // exit 2 from the client is "nothing answered at that URL" — the post-mortem case. The events are still in the
    // node's own database, so read them from there rather than leaving the operator with a fetch error (item 131).
    const dataDir = ctx.cfg?.dataDir;
    if (!(e instanceof CliError) || e.exitCode !== 2 || !dataDir) throw e;
    const offline = offlineEvents(dataDir, { limit: a.limit ?? 100, kind: a.kind, level: a.level, patch: a.patch });
    info(ctx, c.dim(`node is not running — reading ${join(dataDir, 'node.sqlite')}`));
    emit(ctx, offline, (r) => (r.length ? render(r) : empty()));
    if (a.follow) warn(ctx, `--follow needs a running node; showing what is on disk (\`${PROG} start -d\` to bring it back)`);
    return offline;
  }
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
  const cfg = assertUsableConfig(applyEnv(requireConfig(ctx)), ctx.home);
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

// ---------------------------------------------------------------- disk: what is held, and what may go (item 128)

export interface BlobRowView {
  sha256: string; path: string; size_bytes: number; rows: number; imported_at: number;
  patch_id: string | null; name: string | null; status: string | null;
  mine: boolean; purchased: boolean; applied: boolean; reclaimable: boolean; holders: number;
}

/** Why this node is holding a body — the column that decides whether `gc` may take it. */
const heldFor = (b: BlobRowView): string =>
  b.mine ? c.ok('published here') : b.applied ? c.ok('loaded') : b.purchased ? c.ok('bought') : b.reclaimable ? c.warn('verification') : c.dim('verification (sole copy)');

export async function blobsLs(ctx: CliContext): Promise<{ items: BlobRowView[]; disk: DiskReport; kept: Record<string, number> }> {
  const d = await new NodeClient(ctx).get<{ items: BlobRowView[]; disk: DiskReport; reclaimable_bytes: number; kept: Record<string, number> }>('/api/me/blobs');
  emit(ctx, d, (x) => [
    table(x.items, [
      { key: 'id', title: 'KNOWLEDGE', get: (b) => b.name ?? c.dim(b.sha256.slice(0, 12)) },
      { key: 'sha', title: 'SHA256', get: (b) => c.dim(b.sha256.slice(0, 12)) },
      { key: 'size', title: 'SIZE', get: (b) => humanBytes(b.size_bytes), align: 'right' },
      { key: 'rows', title: 'ROWS', get: (b) => String(b.rows), align: 'right' },
      { key: 'held', title: 'HELD FOR', get: heldFor },
      { key: 'holders', title: 'PEERS', get: (b) => String(b.holders), align: 'right' },
      { key: 'when', title: 'FETCHED', get: (b) => fmtTime(b.imported_at) },
    ], 'no knowledge files on this node yet'),
    '',
    kv([['disk', diskLine(x.disk, false)]]),
    x.reclaimable_bytes > 0
      ? c.dim(`\`${PROG} gc --dry-run\` lists what would go; every one of them is re-fetchable from a peer that holds it.`)
      : x.items.length ? c.dim('nothing here is reclaimable: every body is published here, bought, loaded, or the only copy left.') : '',
    keptLine(x.kept),
  ].filter(Boolean).join('\n'));
  return d;
}

export interface GcArgs { dryRun?: boolean; keepPurchased?: boolean; olderThan?: string; allowSoleCopy?: boolean; yes?: boolean }

/** `--older-than 30d` / `12h` / `90` (days). */
export function parseAge(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i.exec(v.trim());
  if (!m) throw new CliError(`--older-than must be a duration like 30d, 12h or 90m — got ${JSON.stringify(v)}`);
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000, w: 7 * 86_400_000, '': 86_400_000 };
  return Math.round(Number(m[1]) * mult[m[2].toLowerCase()]);
}

export interface GcResponse {
  candidates: GcCandidate[]; removed: GcCandidate[]; freed: number; bytes: number; dry_run: boolean;
  kept: Record<string, number>; disk: DiskReport;
}

/**
 * `ainize gc` — give back the disk that verification duty cost (item 128). A dry run first, always: the operator
 * sees every body and its size before anything is deleted, and `--yes` is what turns the plan into a deletion.
 */
export async function gc(ctx: CliContext, a: GcArgs = {}): Promise<GcResponse> {
  const client = new NodeClient(ctx);
  const body = {
    keep_purchased: a.keepPurchased !== false,
    older_than_ms: parseAge(a.olderThan) ?? null,
    allow_sole_copy: !!a.allowSoleCopy,
  };
  const plan = await client.post<GcResponse>('/api/me/blobs/gc', { ...body, dry_run: true });
  const listPlan = (x: GcResponse) => [
    table(x.candidates, [
      { key: 'id', title: 'KNOWLEDGE', get: (b) => b.name },
      { key: 'pid', title: 'ID', get: (b) => c.id(b.patch_id) },
      { key: 'size', title: 'SIZE', get: (b) => humanBytes(b.bytes), align: 'right' },
      { key: 'peers', title: 'PEERS HOLDING', get: (b) => String(b.holders), align: 'right' },
      { key: 'when', title: 'FETCHED', get: (b) => fmtTime(b.imported_at) },
    ], 'nothing to reclaim with these filters'),
    keptLine(x.kept),
  ].filter(Boolean).join('\n');

  if (!plan.candidates.length || a.dryRun) {
    emit(ctx, plan, (x) => [listPlan(x), '', kv([['would free', humanBytes(x.bytes)], ['disk', diskLine(x.disk, false)]])].join('\n'));
    return plan;
  }
  if (!a.yes) {
    info(ctx, listPlan(plan));
    info(ctx, `\nthis removes ${plan.candidates.length} knowledge file(s) and frees ${humanBytes(plan.bytes)}.`);
    const typed = await promptLine('Type "yes" to delete them (anything else cancels): ');
    if (typed.toLowerCase() !== 'yes') throw new CliError('cancelled — nothing was deleted');
  }
  const done = await client.post<GcResponse>('/api/me/blobs/gc', { ...body, dry_run: false });
  emit(ctx, done, (x) => [
    c.ok('✓ ') + `removed ${x.removed.length} knowledge file(s), freed ${humanBytes(x.freed)}`,
    ...(x.removed.length < x.candidates.length ? [c.warn(`${x.candidates.length - x.removed.length} could not be deleted — they are still on disk`)] : []),
    kv([['disk', diskLine(x.disk, false)]]),
    c.dim('every one of them is re-fetchable from a peer that holds it; verification will fetch it again if it is needed.'),
  ].join('\n'));
  return done;
}

export interface NodesArgs { all?: boolean; limit?: number }

/** How recently a node must have been heard from to make the default `ainize nodes` list (item 140). */
export const NODES_RECENT_MS = 3600_000;

export async function nodesTable(ctx: CliContext, a: NodesArgs = {}): Promise<{ nodes: unknown[]; peers: unknown[]; self: string }> {
  const client = new NodeClient(ctx);
  type NodeRow = InfoResponse['node'] & { last_seen?: number; blobs_advertised?: number; ledger_mismatch?: boolean; duplicate_endpoints?: string[] };
  // Ask for everything and filter here, so `--all` needs no second round trip and the cut-off is the CLI's own.
  const d = await client.get<{ nodes: NodeRow[]; peers: PeerRow[]; blocked?: BlockedPeer[]; self: string; peer_status?: PeerStatus }>('/api/nodes?all=1', { auth: false });
  // The peers table carries the state that actually diagnoses a gossip problem, and it used to be printed BELOW a
  // wall of 122 dead node records (item 140). It goes first.
  const recent = d.nodes.filter((n) => n.address === d.self || Date.now() - (n.last_seen ?? 0) < NODES_RECENT_MS);
  const shown = (a.all ? d.nodes : recent).slice(0, a.limit && a.limit > 0 ? a.limit : undefined);
  const hidden = d.nodes.length - shown.length;
  // One line per colliding ADDRESS, not per row: both rows carry the same endpoint pair (item 139).
  const dupes = new Map<string, NodeRow>();
  for (const n of d.nodes) if (n.duplicate_endpoints?.length && !dupes.has(n.address.toLowerCase())) dupes.set(n.address.toLowerCase(), n);
  emit(ctx, { ...d, nodes: shown, nodes_total: d.nodes.length, nodes_hidden: hidden }, (x) => [
    c.head('peers'),
    table(x.peers, peerColumns),
    ...blockedLines(x.blocked),
    '', c.head(`known nodes${a.all ? '' : ' (seen in the last hour)'}`),
    table(shown, [
      { key: 'name', title: 'NAME', get: (n) => (n.address === x.self ? c.bold(n.name + ' (self)') : n.name) + (n.duplicate_endpoints?.length ? c.err(' DUPLICATE') : '') },
      { key: 'addr', title: 'ADDRESS', get: (n) => shortAddr(n.address, 8) },
      { key: 'ep', title: 'ENDPOINT', get: (n) => n.endpoint },
      { key: 'roles', title: 'ROLES', get: (n) => n.roles.join(',') },
      { key: 'ledger', title: 'LEDGER', get: (n) => (n.ledger_mismatch ? c.warn(`${n.ledger} ≠ ours`) : n.ledger) },
      { key: 'branches', title: 'BRANCHES', get: (n) => n.branches.join(',') || '-' },
      // what the node ITSELF says it holds: `blobs` is filtered through this node's catalogue, so a peer on another
      // ledger showed 0 while holding four (item 170)
      { key: 'blobs', title: 'BLOBS', get: (n) => String(n.blobs_advertised ?? n.blobs.length), align: 'right' },
      { key: 'seen', title: 'SEEN', get: (n) => (n.address === x.self ? c.dim('now') : n.last_seen ? `${relAge(Date.now() - n.last_seen)} ago` : c.dim('never')) },
    ], 'no node records yet'),
    ...(hidden > 0 ? [c.dim(`… and ${hidden} node record(s) not seen for over an hour — \`${PROG} nodes --all\` lists them`)] : []),
    // item 139: two endpoints answering for one identity. Whichever spoke last owns the address in every registry.
    ...[...dupes.values()].map((n) => c.err('! ') + `${shortAddr(n.address, 8)} is answering at ${n.duplicate_endpoints!.join(' and ')} — two nodes are running on one identity, so buyers and verifiers reach one of them at random. Stop one, or give it its own key (\`${PROG} keys rotate\`).`),
    // "configured peers" was a lie on this table: gossip adds every endpoint any peer advertises, so an operator was
    // shown other people's nodes under a heading that said they had configured them (item 136). SOURCE says which is
    // which, and STATE carries the reason a peer is not answering instead of a raw counter (item 138).
    ...ledgerMismatchLines(x.peer_status),
  ].join('\n'));
  return d;
}

export { warn };
