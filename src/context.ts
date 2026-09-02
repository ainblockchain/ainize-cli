/**
 * CLI context: where the node config lives (NGRAM_HOME), which node URL to talk to,
 * the stored operator bearer token (cli.json) and output flags.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_HOME, configPath, loadConfig, type NodeConfig } from '@ngram/core';

export interface CliState { token?: string; nodeUrl?: string; }

/**
 * Name the binary was invoked as. The package installs two bins pointing at the same entry — `ainize` (the
 * product name: AI + -ize, "ainize your knowledge", like the 2019 `ainize` CLI that ainized GitHub repos) and
 * `ngram` (the historical name) — so help text and hints use whichever the user typed.
 */
export const PROG_NAMES = ['ainize', 'ngram'] as const;
export type ProgName = (typeof PROG_NAMES)[number];
export function progName(argv1: string | undefined = process.argv[1]): ProgName {
  const base = basename(argv1 ?? '').replace(/\.(c|m)?js$/, '');
  return (PROG_NAMES as readonly string[]).includes(base) ? (base as ProgName) : 'ainize';
}
export const PROG: ProgName = progName();

/**
 * Where `nodeUrl` came from. `default` means nobody chose it: there is no config in this home and no `--node`,
 * so the URL is the built-in `http://localhost:3402` — a node that, if it answers at all, belongs to someone else.
 * Commands that talk to a node refuse on `default` rather than report a stranger's node as yours (item 101).
 */
export type NodeUrlSource = 'flag' | 'env' | 'state' | 'config' | 'default';

export interface CliContext {
  home: string;
  nodeUrl: string;
  nodeSource: NodeUrlSource;
  /** Why `nodeUrl` cannot be used: config.json's `port` is not a port number. Commands that need a node refuse with it. */
  nodeUrlProblem: string | null;
  token: string | null;
  json: boolean;
  quiet: boolean;
  cfg: NodeConfig | null;
}

export class CliError extends Error {
  /** The node's JSON error body, when there was one — e.g. the per-line report a refused dataset upload carries. */
  details?: unknown;
  constructor(message: string, public exitCode = 1, details?: unknown) { super(message); this.details = details; }
}

export function statePath(home: string): string { return join(home, 'cli.json'); }

export function readState(home: string): CliState {
  const p = statePath(home);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) as CliState; } catch { return {}; }
}

export function writeState(home: string, state: CliState): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(statePath(home), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function resolveHome(explicit?: string): string {
  return explicit ?? process.env.NGRAM_HOME ?? DEFAULT_HOME;
}

/** A TCP port — what config.json's `port` and NGRAM_PORT must hold before a URL can be built from them. */
const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;

/** Build a context from global flags. Node URL precedence: --node > NGRAM_NODE_URL > cli.json > NGRAM_PORT > config port > default. */
export function buildContext(opts: { home?: string; node?: string; json?: boolean; quiet?: boolean } = {}): CliContext {
  const home = resolveHome(opts.home);
  const cfg = loadConfig(home);
  const state = readState(home);
  const envPort = process.env.NGRAM_PORT;
  if (envPort !== undefined && !isPort(Number(envPort))) throw new CliError(`NGRAM_PORT must be a port number (1–65535) — got ${JSON.stringify(envPort)}`, 2);
  const port = envPort !== undefined ? Number(envPort) : cfg?.port ?? 3402;
  const url = opts.node ?? process.env.NGRAM_NODE_URL ?? state.nodeUrl ?? `http://localhost:${port}`;
  const nodeSource: NodeUrlSource = opts.node ? 'flag'
    : process.env.NGRAM_NODE_URL ? 'env'
    : state.nodeUrl ? 'state'
    : envPort !== undefined ? 'env'
    : cfg ? 'config'
    : 'default';
  const nodeUrl = url.replace(/\/+$/, '');
  // A config.json whose `port` is not a number used to make every command — `config set port …`, the fix, included —
  // die with "--node must be a full URL", blaming a flag nobody passed (item 123). The URL is only checked when
  // someone typed it; a broken config is named by the commands that actually need a node (requireNodeTarget).
  let nodeUrlProblem: string | null = null;
  if (nodeSource === 'config' && !isPort(cfg!.port)) {
    nodeUrlProblem = `port in ${configPath(home)} is ${JSON.stringify(cfg!.port)}, not a port number — fix it with \`${PROG} config set port <1-65535>\``;
  } else if (nodeSource === 'flag' || nodeSource === 'env' || nodeSource === 'state') {
    // `--node localhost:3402` is the standard typo, and a scheme-less URL used to be reported as a dead node while
    // the node was serving happily on that very port (item 116).
    let parsed: URL | null = null;
    try { parsed = new URL(nodeUrl); } catch { /* not a URL at all */ }
    // note `new URL('localhost:3402')` parses — with protocol "localhost:" — so the scheme has to be checked too
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      const where = nodeSource === 'flag' ? '--node' : process.env.NGRAM_NODE_URL ? 'NGRAM_NODE_URL' : `the node URL in ${statePath(home)}`;
      throw new CliError(`${where} must be a full URL — did you mean http://${nodeUrl.replace(/^\w+:\/\//, '').replace(/^\/+/, '')}?`, 2);
    }
  }
  return { home, nodeUrl, nodeSource, nodeUrlProblem, token: process.env.NGRAM_TOKEN ?? state.token ?? null, json: !!opts.json, quiet: !!opts.quiet, cfg };
}

/**
 * Refuse to send a request nobody aimed: with no config in this home and no `--node`, every read command used to
 * report whatever answered port 3402 — a colleague's node, or the demo cluster — as yours (item 101).
 */
export function requireNodeTarget(ctx: CliContext): void {
  if (ctx.nodeUrlProblem) throw new CliError(ctx.nodeUrlProblem, 2);
  if (ctx.cfg || ctx.nodeSource !== 'default') return;
  throw new CliError(
    `no node configured in ${ctx.home} — run \`${PROG} init\` to create one, or pass --node <url> to talk to an existing node`,
    2,
  );
}
