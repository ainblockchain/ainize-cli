/**
 * `ainize init` / `ainize config` / `ainize keys` — local node configuration (NGRAM_HOME/config.json).
 */
import { existsSync } from 'node:fs';
import {
  PROTECTED_CONFIG_KEYS, coerceConfigValue, configField, configFieldType, configKeys, configPath, defaultConfig, loadConfig,
  nearestConfigKey, saveConfig, validateConfig, type NodeConfig, type NodeRole,
} from '@ngram/core';
import { CliError, PROG, type CliContext } from '../context.js';
import { emit, info, kv, ok, c } from '../output.js';

export interface InitArgs {
  name?: string; port?: number; ledger?: 'local' | 'ain'; ainProvider?: string; ainChainId?: number; peer?: string[];
  roles?: string; runtimeRepo?: string; runtimeApi?: string; privateKey?: string; publicUrl?: string; force?: boolean;
}

export async function init(ctx: CliContext, a: InitArgs = {}): Promise<NodeConfig> {
  const p = configPath(ctx.home);
  if (existsSync(p) && !a.force) throw new CliError(`config already exists at ${p} (use --force to overwrite, or \`${PROG} config show\`)`);
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
    '', c.dim(`next: \`${PROG} start\`   (then \`${PROG} login\`, \`${PROG} seed\`)`),
  ].join('\n'));
  return cfg;
}

export function requireConfig(ctx: CliContext): NodeConfig {
  const cfg = ctx.cfg ?? loadConfig(ctx.home);
  if (!cfg) throw new CliError(`no node config at ${configPath(ctx.home)} — run \`${PROG} init\` first`);
  return cfg;
}


function redact(cfg: NodeConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  const id = clone.identity as Record<string, unknown>;
  if (id) id.privateKey = `<hidden — \`${PROG} keys show --reveal\`>`;
  if (clone.operatorPasswordHash) clone.operatorPasswordHash = '<set>';
  return clone;
}

export function configShow(ctx: CliContext): NodeConfig {
  const cfg = requireConfig(ctx);
  emit(ctx, redact(cfg), (d) => `${c.dim(configPath(ctx.home))}\n${JSON.stringify(d, null, 2)}`);
  return cfg;
}

/** Walk a dotted path, without creating anything on the way (an unknown key is refused, not invented). */
function containerOf(cfg: NodeConfig, key: string): { parent: Record<string, unknown>; last: string } {
  const parts = key.split('.');
  let cur = cfg as unknown as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  return { parent: cur, last: parts[parts.length - 1] };
}

/** The schema of a settable key, or a CliError naming the nearest real key / the group's children. */
function settableField(key: string) {
  if (PROTECTED_CONFIG_KEYS.includes(key)) {
    throw new CliError(key.startsWith('identity')
      ? `refusing to set ${key}: the identity is this node's only key pair — see \`${PROG} keys\``
      : `refusing to set ${key}: the operator password is set by \`${PROG} login\``);
  }
  const field = configField(key);
  if (!field) {
    const near = nearestConfigKey(key);
    throw new CliError(`unknown config key '${key}'${near ? ` — did you mean '${near}'?` : `; \`${PROG} config show\` lists every key this node has`}`);
  }
  if (field.def.type === 'object') {
    const children = configKeys().filter((k) => k.startsWith(`${key}.`) && !k.slice(key.length + 1).includes('.'));
    throw new CliError(`${key} is a group of keys, not a value — set one of: ${children.join(', ')}`);
  }
  return field;
}

export function configSet(ctx: CliContext, key: string, value: string): NodeConfig {
  const cfg = requireConfig(ctx);
  const field = settableField(key);
  const parsed = coerceConfigValue(field, value);
  const check = field.safeParse(parsed);
  if (!check.success) {
    // the schema's own wording when it has one ("must be a fraction between 0 and 1"), else the field's type
    const why = check.error.issues.map((i) => i.message).find((m) => /^must /.test(m)) ?? `must be ${configFieldType(field)}`;
    throw new CliError(`${key} ${why} — got ${JSON.stringify(value)}`);
  }
  const { parent, last } = containerOf(cfg, key);
  parent[last] = check.data;
  saveConfig(cfg, ctx.home);
  ok(ctx, `${key} = ${JSON.stringify(check.data)}  ${c.dim('(the node reads config.json when it starts)')}`);
  return cfg;
}

/** One key's current value — the half of `config show` an operator actually asked for. */
export function configGet(ctx: CliContext, key: string): unknown {
  const cfg = requireConfig(ctx);
  if (!configField(key)) {
    const near = nearestConfigKey(key);
    throw new CliError(`unknown config key '${key}'${near ? ` — did you mean '${near}'?` : `; \`${PROG} config show\` lists every key this node has`}`);
  }
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), redact(cfg));
  if (value === undefined) {
    info(ctx, c.dim(`${key} is not set in ${configPath(ctx.home)} (the node uses its built-in default)`));
    return undefined;
  }
  emit(ctx, value, (d) => (typeof d === 'object' && d !== null ? JSON.stringify(d, null, 2) : String(d)));
  return value;
}

/** Remove a key so the node falls back to its default; a key the config cannot do without is reset, not deleted. */
export function configUnset(ctx: CliContext, key: string): NodeConfig {
  const cfg = requireConfig(ctx);
  settableField(key);
  const { parent, last } = containerOf(cfg, key);
  if (!(last in parent)) throw new CliError(`${key} is not set in ${configPath(ctx.home)}`);
  const had = parent[last];
  delete parent[last];
  // deleting a required key would leave a config the node refuses to boot on — put the built-in default back instead
  const required = validateConfig(cfg).some((p) => p.key === key && p.kind === 'invalid');
  let restored: unknown;
  if (required) {
    const fresh = defaultConfig({ home: ctx.home, privateKey: cfg.identity.privateKey }) as unknown as Record<string, unknown>;
    restored = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), fresh);
    parent[last] = restored;
  }
  saveConfig(cfg, ctx.home);
  ok(ctx, required
    ? `${key} reset to the default ${JSON.stringify(restored)} ${c.dim(`(was ${JSON.stringify(had)}; it cannot be absent)`)}`
    : `${key} unset ${c.dim(`(was ${JSON.stringify(had)} — the node falls back to its built-in default)`)}`);
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
