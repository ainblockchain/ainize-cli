/**
 * CLI context: where the node config lives (NGRAM_HOME), which node URL to talk to,
 * the stored operator bearer token (cli.json) and output flags.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HOME, loadConfig, type NodeConfig } from '@ngram/core';

export interface CliState { token?: string; nodeUrl?: string; }

export interface CliContext {
  home: string;
  nodeUrl: string;
  token: string | null;
  json: boolean;
  quiet: boolean;
  cfg: NodeConfig | null;
}

export class CliError extends Error {
  constructor(message: string, public exitCode = 1) { super(message); }
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

/** Build a context from global flags. Node URL precedence: --node > cli.json > config port > default. */
export function buildContext(opts: { home?: string; node?: string; json?: boolean; quiet?: boolean } = {}): CliContext {
  const home = resolveHome(opts.home);
  const cfg = loadConfig(home);
  const state = readState(home);
  const port = process.env.NGRAM_PORT ? Number(process.env.NGRAM_PORT) : cfg?.port ?? 3402;
  const nodeUrl = (opts.node ?? process.env.NGRAM_NODE_URL ?? state.nodeUrl ?? `http://localhost:${port}`).replace(/\/+$/, '');
  return { home, nodeUrl, token: process.env.NGRAM_TOKEN ?? state.token ?? null, json: !!opts.json, quiet: !!opts.quiet, cfg };
}
