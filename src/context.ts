/**
 * CLI context: where the node config lives (NGRAM_HOME), which node URL to talk to,
 * the stored operator bearer token (cli.json) and output flags.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_HOME, loadConfig, type NodeConfig } from '@ngram/core';

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

/** Build a context from global flags. Node URL precedence: --node > NGRAM_NODE_URL > cli.json > config port > default. */
export function buildContext(opts: { home?: string; node?: string; json?: boolean; quiet?: boolean } = {}): CliContext {
  const home = resolveHome(opts.home);
  const cfg = loadConfig(home);
  const state = readState(home);
  const port = process.env.NGRAM_PORT ? Number(process.env.NGRAM_PORT) : cfg?.port ?? 3402;
  const url = opts.node ?? process.env.NGRAM_NODE_URL ?? state.nodeUrl ?? `http://localhost:${port}`;
  const nodeSource: NodeUrlSource = opts.node ? 'flag'
    : process.env.NGRAM_NODE_URL ? 'env'
    : state.nodeUrl ? 'state'
    : cfg ? 'config'
    : process.env.NGRAM_PORT ? 'env'
    : 'default';
  return { home, nodeUrl: url.replace(/\/+$/, ''), nodeSource, token: process.env.NGRAM_TOKEN ?? state.token ?? null, json: !!opts.json, quiet: !!opts.quiet, cfg };
}

/**
 * Refuse to send a request nobody aimed: with no config in this home and no `--node`, every read command used to
 * report whatever answered port 3402 — a colleague's node, or the demo cluster — as yours (item 101).
 */
export function requireNodeTarget(ctx: CliContext): void {
  if (ctx.cfg || ctx.nodeSource !== 'default') return;
  throw new CliError(
    `no node configured in ${ctx.home} — run \`${PROG} init\` to create one, or pass --node <url> to talk to an existing node`,
    2,
  );
}
