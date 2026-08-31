/**
 * `ngram init` / `ngram config` / `ngram keys` — local node configuration (NGRAM_HOME/config.json).
 */
import { existsSync } from 'node:fs';
import { configPath, defaultConfig, loadConfig, saveConfig, type NodeConfig, type NodeRole } from '@ngram/core';
import { CliError, type CliContext } from '../context.js';
import { emit, kv, ok, c } from '../output.js';

export interface InitArgs {
  name?: string; port?: number; ledger?: 'local' | 'ain'; ainProvider?: string; ainChainId?: number; peer?: string[];
  roles?: string; runtimeRepo?: string; runtimeApi?: string; privateKey?: string; publicUrl?: string; force?: boolean;
}

export async function init(ctx: CliContext, a: InitArgs = {}): Promise<NodeConfig> {
  const p = configPath(ctx.home);
  if (existsSync(p) && !a.force) throw new CliError(`config already exists at ${p} (use --force to overwrite, or \`ngram config show\`)`);
  const roles = a.roles ? (a.roles.split(',').map((s) => s.trim()).filter(Boolean) as NodeRole[]) : undefined;
  for (const r of roles ?? []) if (!['seller', 'verifier', 'serving', 'gateway'].includes(r)) throw new CliError(`unknown role: ${r}`);
  const cfg = defaultConfig({
    home: ctx.home, name: a.name, port: a.port, ledger: a.ledger, ainProviderUrl: a.ainProvider, ainChainId: a.ainChainId,
    peers: a.peer, roles, runtimeRepo: a.runtimeRepo, runtimeApi: a.runtimeApi, privateKey: a.privateKey, publicUrl: a.publicUrl,
  });
  saveConfig(cfg, ctx.home);
  emit(ctx, { config: p, name: cfg.name, address: cfg.identity.address, port: cfg.port, ledger: cfg.ledger.kind, roles: cfg.roles }, (d) => [
    c.ok('✓ ') + `node initialised at ${d.config}`,
    kv([['name', d.name], ['address', d.address], ['port', d.port], ['ledger', d.ledger], ['roles', d.roles.join(', ')]]),
    '', c.dim('next: `ngram start`   (then `ngram login`, `ngram seed`)'),
  ].join('\n'));
  return cfg;
}

export function requireConfig(ctx: CliContext): NodeConfig {
  const cfg = ctx.cfg ?? loadConfig(ctx.home);
  if (!cfg) throw new CliError(`no node config at ${configPath(ctx.home)} — run \`ngram init\` first`);
  return cfg;
}

const SECRET_KEYS = new Set(['identity.privateKey', 'operatorPasswordHash']);

function redact(cfg: NodeConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  const id = clone.identity as Record<string, unknown>;
  if (id) id.privateKey = '<hidden — `ngram keys show --reveal`>';
  if (clone.operatorPasswordHash) clone.operatorPasswordHash = '<set>';
  return clone;
}

export function configShow(ctx: CliContext): NodeConfig {
  const cfg = requireConfig(ctx);
  emit(ctx, redact(cfg), (d) => `${c.dim(configPath(ctx.home))}\n${JSON.stringify(d, null, 2)}`);
  return cfg;
}

function parseValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) { try { return JSON.parse(v); } catch { /* string */ } }
  if (v.includes(',')) return v.split(',').map((s) => s.trim());
  return v;
}

export function configSet(ctx: CliContext, key: string, value: string): NodeConfig {
  const cfg = requireConfig(ctx);
  if (SECRET_KEYS.has(key)) throw new CliError(`refusing to set ${key} via config set`);
  const parts = key.split('.');
  let cur: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  const parsed = parseValue(value);
  cur[last] = (last === 'peers' || last === 'roles') && typeof parsed === 'string' ? [parsed] : parsed;
  saveConfig(cfg, ctx.home);
  ok(ctx, `${key} = ${JSON.stringify(cur[last])}  ${c.dim('(restart the node to apply)')}`);
  return cfg;
}

export function keysShow(ctx: CliContext, reveal = false): { address: string; publicKey: string; privateKey?: string } {
  const cfg = requireConfig(ctx);
  const out: { address: string; publicKey: string; privateKey?: string } = { address: cfg.identity.address, publicKey: cfg.identity.publicKey };
  if (reveal) out.privateKey = cfg.identity.privateKey;
  emit(ctx, out, (d) => kv([['address', d.address], ['public key', d.publicKey], ...(d.privateKey ? [['private key', c.err(d.privateKey)] as [string, unknown]] : [])]) +
    (reveal ? '' : `\n${c.dim('add --reveal to print the private key')}`));
  return out;
}
