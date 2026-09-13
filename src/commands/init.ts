/**
 * `ainize init` / `ainize config` / `ainize keys` — local node configuration (AINIZE_HOME/config.json).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  PROTECTED_CONFIG_KEYS, coerceConfigValue, configField, configFieldType, configKeys, configPath, defaultConfig, loadConfig,
  createIdentity, identityFromPrivateKey, nearestConfigKey, saveConfig, validateConfig, type NodeConfig, type NodeRole,
} from '@ainize/core';
import { NodeClient } from '../client.js';
import { promptLine, promptPassword } from './auth.js';
import { warnLedgerMismatch } from './peers.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { runningPid } from '../pid.js';
import { emit, info, kv, ok, warn, c } from '../output.js';

export interface InitArgs {
  name?: string; port?: number; ledger?: 'local' | 'ain'; ainProvider?: string; ainChainId?: number; peer?: string[];
  roles?: string; runtimeRepo?: string; runtimeApi?: string; privateKey?: string; publicUrl?: string; force?: boolean;
  newIdentity?: boolean;
  /** Interface to bind. Defaults to 127.0.0.1; `--public` is the same as `--host 0.0.0.0` (item 121). */
  host?: string; public?: boolean;
  /** Claim the node here, before it ever listens: the hash goes into config.json (item 121). */
}

/** Copy config.json aside before overwriting it — it is the only copy of the node's private key. */
function backupConfig(home: string): string {
  const from = configPath(home);
  const to = `${from}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(from, to);
  chmodSync(to, 0o600);
  return to;
}

export async function init(ctx: CliContext, a: InitArgs = {}): Promise<NodeConfig> {
  const p = configPath(ctx.home);
  const existing = existsSync(p) ? loadConfig(ctx.home) : null;
  if (existing && !a.force) {
    throw new CliError(`config already exists at ${p} — change one setting with \`${PROG} config set <key> <value>\`; \`--force\` rewrites the file (keeping this node's identity)`);
  }
  const roles = a.roles ? (a.roles.split(',').map((s) => s.trim()).filter(Boolean) as NodeRole[]) : undefined;
  for (const r of roles ?? []) if (!['seller', 'verifier', 'serving', 'gateway'].includes(r)) throw new CliError(`unknown role: ${r}`);
  /**
   * `gateway` is a name the config accepts and nothing reads (item 384).
   *
   * It is in `NodeRole` and in `ROLES`, so `--roles gateway` validates, is written to config.json and is
   * advertised to peers — and no line of code anywhere branches on it. An operator choosing it gets a node that
   * behaves exactly as if they had not. The role is what `p2p-compute-market-design.md` reserves for a node with
   * no runtime that hosts the UI and buys inference from peers; that design is accepted and not implemented, so
   * the honest thing is to keep the name (existing configs and peer records carry it) and say what it does today.
   */
  if ((roles ?? []).includes('gateway' as NodeRole)) {
    warn(ctx, 'the `gateway` role does nothing on this build: it is reserved for a node that owns no GPU and buys inference from peers, which is designed (docs/p2p-compute-market-design.md) and not built. The node will run exactly as it would without it.');
  }
  if (a.newIdentity && !existing) throw new CliError('--new-identity only means something when a config already exists; plain `init` mints a key');

  // The key in config.json owns every anchor this node published, its balance and its payout address, and it is
  // the only copy. `--force` used to replace it silently — the remedy the duplicate-init error itself named (item 120).
  let backup: string | undefined;
  if (existing) {
    if (a.newIdentity) {
      if (!ctx.quiet) {
        process.stdout.write([
          c.warn('! this replaces the node identity ') + c.bold(existing.identity.address),
          c.dim('  Every knowledge it published stays on the permanent record under an address nobody can sign for:'),
          c.dim('  it can never be superseded, retired or challenged by you again, and any balance or pending payout is'),
          c.dim(`  orphaned. Back it up first: \`${PROG} keys backup <file>\`.`),
          '',
        ].join('\n'));
      }
      const typed = await promptLine(`Type the current address to replace it (${existing.identity.address}): `);
      if (typed.toLowerCase() !== existing.identity.address.toLowerCase()) {
        throw new CliError(typed ? `that is not this node's address — nothing was changed` : 'no address typed — nothing was changed');
      }
    }
    backup = backupConfig(ctx.home);
  }

  const cfg = defaultConfig({
    home: ctx.home, name: a.name, port: a.port, ledger: a.ledger, ainProviderUrl: a.ainProvider, ainChainId: a.ainChainId,
    peers: a.peer, roles, runtimeRepo: a.runtimeRepo, runtimeApi: a.runtimeApi, privateKey: a.privateKey, publicUrl: a.publicUrl,
    host: a.public ? '0.0.0.0' : a.host,
  });
  const kept = !!existing && !a.newIdentity && !a.privateKey;
  if (kept) {
    cfg.identity = existing!.identity;
    if (existing!.operatorPasswordHash) cfg.operatorPasswordHash = existing!.operatorPasswordHash;   // not part of defaultConfig
  }
  /**
   * Nothing to claim. The node's own key is an operator by construction — it is in the file this command just
   * wrote — so there is no window in which the node is unowned and waiting for whoever asks first, and no password
   * to set. `ainize login` signs a challenge with that key; another person's address is enrolled afterwards with
   * `ainize operators add`.
   */
  saveConfig(cfg, ctx.home);
  const publicBind = cfg.host === '0.0.0.0' || cfg.host === '::';
  emit(ctx, { config: p, name: cfg.name, address: cfg.identity.address, port: cfg.port, host: cfg.host, ledger: cfg.ledger.kind, roles: cfg.roles, kept_identity: kept, backup: backup ?? null }, (d) => [
    c.ok('✓ ') + `node initialised at ${d.config}`,
    kv([['name', d.name], ['address', d.address], ['listens on', `${d.host}:${d.port}${publicBind ? c.warn('  (every interface)') : c.dim('  (this machine only)')}`], ['ledger', d.ledger], ['roles', d.roles.join(', ')],
      ['owner', c.ok("this node's own key") + c.dim(`  (\`${PROG} login\` signs in with it — no password. \`${PROG} operators add 0x…\` lets a wallet run it too)`)]]),
    ...(d.kept_identity ? [c.dim(`keeping this node's identity ${d.address} (pass --new-identity to replace it)`)] : []),
    ...(d.backup ? [c.dim(`previous config saved as ${d.backup}`)] : []),
    ...(existing ? [] : [
      c.dim(`the private key lives in ${d.config} and this is the only copy — back it up now: \`${PROG} keys backup <file>\``),
    ]),
    ...(publicBind ? [c.dim(`bound to ${cfg.host}: anyone who can reach port ${cfg.port} reaches this node's API — put it behind a proxy or a firewall (\`${PROG} config set host 127.0.0.1\` keeps it local)`)] : []),
    // Item 143: seeding writes the data directory, so it goes BEFORE the node that opens it — `seed` refuses once a
    // node is running, and the old hint told operators to do it the other way round.
    // Item 142: a node on the AIN ledger cannot announce, attest or settle until a chain is reachable, its app is
    // registered and its identity holds AIN. `next: ainize start` was the only thing ever said about any of that.
    '', ...(d.ledger === 'ain' ? [
      c.dim('next, on the AIN ledger:'),
      c.dim(`  ${PROG} chain up        the local 1-node chain in docker (skip it if ${cfg.ledger.ain?.providerUrl ?? 'the provider'} is a chain you already run)`),
      c.dim(`  ${PROG} chain setup     registers /apps/knowledge + the market rules, and funds this identity on a local chain`),
      c.dim(`  ${PROG} start && ${PROG} login`),
      c.dim(`  ${PROG} wallet          this node pays for every announce, attest and settle from its own AIN balance — check it`),
    ] : [
      c.dim(`next: \`${PROG} start\`   (then \`${PROG} login\`)`),
      c.dim(`      (demo knowledge: \`${PROG} seed\` first — it writes the data directory the node then opens)`),
    ]),
  ].join('\n'));
  // A peer on the other ledger answers everything and serves an empty record set forever — say so now, not never (item 170).
  for (const ep of cfg.peers) await warnLedgerMismatch(ctx, ep, cfg.ledger.kind);
  return cfg;
}

export function requireConfig(ctx: CliContext): NodeConfig {
  const cfg = ctx.cfg ?? loadConfig(ctx.home);
  if (!cfg) throw new CliError(`no node config at ${configPath(ctx.home)} — run \`${PROG} init\` first`);
  return cfg;
}

/**
 * Refuse a config the node could not boot on, naming every offending key — the same check `startNode` makes, made
 * here first so `start -d` does not spawn a child only to read its refusal back out of node.log (item 123).
 */
export function assertUsableConfig(cfg: NodeConfig, home: string): NodeConfig {
  const invalid = validateConfig(cfg).filter((p) => p.kind === 'invalid');
  if (invalid.length) {
    throw new CliError(`this node's config is not usable:\n${invalid.map((p) => `  ${p.key} ${p.message}`).join('\n')}\n` +
      `fix it with \`${PROG} config set <key> <value>\` (or \`${PROG} config unset <key>\` for the default) in ${configPath(home)}`);
  }
  return cfg;
}


function redact(cfg: NodeConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  const id = clone.identity as Record<string, unknown>;
  if (id) id.privateKey = `<hidden — \`${PROG} keys show --reveal\`>`;
  if (clone.operatorPasswordHash) clone.operatorPasswordHash = '<set>';
  return clone;
}

// ------------------------------------------------------------------ teach-mode overrides (item 125)

/**
 * Teach policy has TWO stores and config.json is the one that loses. The console's Teaching tab writes a
 * `settings.teach` row into node.sqlite, and `market.teach()` lets every field of that row override the file —
 * so `config set teach.enabled false`, a full restart and `config show` printed `"enabled": false` while the same
 * running node went on accepting and publishing lessons. This table is the missing link between the two names:
 * the dotted config key, the override field the store keeps, and the field `PATCH /api/me/teach/policy` takes.
 *
 * `teach.rowsPerJob` is deliberately absent: in config.json it is the {floor,ceiling,safetyFactor} block that shapes
 * the measured derivation, while the store's `rowsPerJob` is a scalar that DISABLES it. Different settings, same word.
 */
export const TEACH_OVERRIDES: { key: string; setting: string; api: string }[] = [
  { key: 'teach.enabled', setting: 'enabled', api: 'enabled' },
  { key: 'teach.publish', setting: 'publish', api: 'publish' },
  { key: 'teach.factsPerJob', setting: 'factsPerJob', api: 'facts_per_job' },
  { key: 'teach.jobsPerKeyPerDay', setting: 'jobsPerKeyPerDay', api: 'jobs_per_key_per_day' },
  { key: 'teach.jobsPerIpPerDay', setting: 'jobsPerIpPerDay', api: 'jobs_per_ip_per_day' },
  { key: 'teach.queueMax', setting: 'queueMax', api: 'queue_max' },
  { key: 'teach.contributorShare', setting: 'contributorShare', api: 'contributor_share' },
  { key: 'teach.draftTtlDays', setting: 'draftTtlDays', api: 'draft_ttl_days' },
  { key: 'teach.queuedRowsMax', setting: 'queuedRowsMax', api: 'queued_rows_max' },
  { key: 'teach.dataset.maxBytes', setting: 'datasetMaxBytes', api: 'dataset_max_bytes' },
  { key: 'teach.dataset.maxRows', setting: 'datasetMaxRows', api: 'dataset_max_rows' },
  { key: 'teach.dataset.rowsPerKeyPerDay', setting: 'rowsPerKeyPerDay', api: 'rows_per_key_per_day' },
  { key: 'teach.dataset.rowsPerIpPerDay', setting: 'rowsPerIpPerDay', api: 'rows_per_ip_per_day' },
  { key: 'teach.dataset.perKeyPerDay', setting: 'datasetsPerKeyPerDay', api: 'datasets_per_key_per_day' },
  { key: 'teach.dataset.ttlDays', setting: 'datasetTtlDays', api: 'dataset_ttl_days' },
  { key: 'teach.dataset.declarationRows', setting: 'declarationRows', api: 'declaration_rows' },
  { key: 'teach.check.callBudget', setting: 'checkCallBudget', api: 'check_call_budget' },
];
/** Overrides the console can set that config.json has no key for at all — still worth naming when they are on. */
const OVERRIDE_ONLY: { setting: string; label: string }[] = [
  { setting: 'rowsPerJob', label: 'teach.rowsPerJob (a fixed rows-per-job override; disables the measured derivation)' },
  { setting: 'pausedReason', label: 'teach paused (reason shown to visitors)' },
  { setting: 'blockedTopics', label: 'teach blocked topics (regular expression)' },
];

export interface ConfigOverride { key: string; file: unknown; effective: unknown; source: 'console' }

/**
 * What the RUNNING node is actually using, where it differs from config.json. Silent when no node answers or the
 * terminal is not logged in — an override can only be read by the operator, and `config show` must still work offline.
 */
async function teachOverrides(ctx: CliContext, cfg: NodeConfig): Promise<{ overrides: ConfigOverride[]; checked: boolean }> {
  if (!(await runningHere(ctx, cfg))) return { overrides: [], checked: false };
  const policy = await new NodeClient(ctx)
    .get<{ policy: Record<string, unknown> }>('/api/me/teach/policy', { timeoutMs: 4000 })
    .catch(() => null);
  if (!policy?.policy) return { overrides: [], checked: false };
  const at = (key: string): unknown => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), cfg);
  const out: ConfigOverride[] = [];
  for (const m of TEACH_OVERRIDES) {
    const v = policy.policy[m.setting];
    if (v === undefined || v === null) continue;
    if (JSON.stringify(v) === JSON.stringify(at(m.key))) continue;
    out.push({ key: m.key, file: at(m.key), effective: v, source: 'console' });
  }
  for (const o of OVERRIDE_ONLY) {
    const v = policy.policy[o.setting];
    if (v === undefined || v === null) continue;
    out.push({ key: o.label, file: undefined, effective: v, source: 'console' });
  }
  return { overrides: out, checked: true };
}

/** Append `// overridden …` to the line of every overridden key in a `JSON.stringify(x, null, 2)` rendering. */
function annotate(json: string, notes: Map<string, string>): string {
  const stack: string[] = [];
  return json.split('\n').map((line) => {
    const m = /^(\s*)"([^"]+)":/.exec(line);
    if (!m) return line;
    const depth = m[1].length / 2 - 1;
    stack.length = Math.max(0, depth);
    stack.push(m[2]);
    const note = notes.get(stack.join('.'));
    return note ? `${line}  ${c.warn(note)}` : line;
  }).join('\n');
}

export async function configShow(ctx: CliContext): Promise<NodeConfig> {
  const cfg = requireConfig(ctx);
  const { overrides, checked } = await teachOverrides(ctx, cfg);
  const notes = new Map(overrides.filter((o) => o.file !== undefined).map((o) => [o.key, `// overridden to ${JSON.stringify(o.effective)} in the console (settings.teach) — this file's value is not in use`]));
  const body = redact(cfg) as Record<string, unknown>;
  // The overrides go ABOVE the JSON, so the last thing on screen is still a config.json a script can read off the
  // first `{` — and so the warning is not below the fold of a 200-line config.
  emit(ctx, overrides.length ? { ...body, overrides } : body, () => [
    c.dim(configPath(ctx.home)),
    ...(overrides.length ? [
      c.warn(`! ${overrides.length} setting${overrides.length === 1 ? ' is' : 's are'} overridden in the console and outlive a restart — config.json below is not what the node uses:`),
      ...overrides.map((o) => `    ${o.key}: ${o.file === undefined ? c.dim('(not in config.json)') : JSON.stringify(o.file)} → ${c.bold(JSON.stringify(o.effective))}`),
      c.dim(`    \`${PROG} config set <key> <value>\` now writes both; \`${PROG} config unset <key>\` clears the console override.`),
      '',
    ] : checked ? [c.dim('no console overrides — the running node is using exactly this file')] : []),
    annotate(JSON.stringify(redact(cfg), null, 2), notes),
  ].join('\n'));
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

/**
 * Is a node running for this home? The pid file covers `start -d`; the port probe covers a node started in the
 * foreground or by a supervisor (the demo cluster writes no pid file). Either way the edit below only takes
 * effect at the next start, and the operator has to be told so (item 124).
 */
async function runningHere(ctx: CliContext, cfg: NodeConfig): Promise<{ pid: number | null; url: string } | null> {
  const url = `http://localhost:${cfg.port}`;
  const pid = runningPid(ctx.home);
  if (pid) return { pid, url };
  const d = await new NodeClient({ ...ctx, nodeUrl: url, token: null })
    .get<{ node: { address: string } }>('/api/info', { auth: false, timeoutMs: 1500 }).catch(() => null);
  return d && d.node.address.toLowerCase() === cfg.identity.address.toLowerCase() ? { pid: null, url } : null;
}

export async function configSet(ctx: CliContext, key: string, value: string): Promise<NodeConfig> {
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
  const running = await runningHere(ctx, cfg);
  saveConfig(cfg, ctx.home);
  ok(ctx, `${key} = ${JSON.stringify(check.data)}  ${c.dim('(the node reads config.json when it starts)')}`);
  // A teach key set here used to lose to the console's `settings.teach` row for good: config.json said `false`,
  // the running node said `true`, a restart changed nothing and `config show` never mentioned the override (item 125).
  // Write BOTH when a node is up, so the terminal switch actually is the switch.
  const mapped = TEACH_OVERRIDES.find((m) => m.key === key);
  if (running && mapped) {
    const wrote = await writeTeachOverride(ctx, mapped.api, check.data);
    if (wrote === 'ok') { ok(ctx, `applied to the running node as well ${c.dim('(the console override for this setting now matches — no restart needed)')}`); return cfg; }
    const effective = await new NodeClient({ ...ctx, token: null }).get<Record<string, unknown>>('/api/teach/policy', { auth: false, timeoutMs: 3000 }).catch(() => null);
    const live = effective?.[mapped.setting === 'enabled' ? 'enabled' : mapped.setting];
    if (live !== undefined && JSON.stringify(live) !== JSON.stringify(check.data)) {
      warn(ctx, `the running node still answers ${mapped.setting} = ${JSON.stringify(live)}: that value is a console override in node.sqlite, and it outlives a restart.\n` +
        `  ${wrote === 'unauthorised' ? `sign in and run this again to write both (\`${PROG} login\`)` : `clear it in the console's Teaching tab, or run \`${PROG} config unset ${key}\` while signed in`}`);
      return cfg;
    }
  }
  if (running) {
    warn(ctx, `the node in ${ctx.home} is running${running.pid ? ` (pid ${running.pid})` : ` on ${running.url}`} and keeps using the value it started with` +
      ` — restart it to apply this (\`${PROG} stop\` then \`${PROG} start -d\`)`);
  }
  return cfg;
}

/** PATCH one teach field on the running node. 'unauthorised' when this terminal is not signed in. */
async function writeTeachOverride(ctx: CliContext, apiField: string, value: unknown): Promise<'ok' | 'unauthorised' | 'failed'> {
  if (!ctx.token) return 'unauthorised';
  try { await new NodeClient(ctx).patch('/api/me/teach/policy', { [apiField]: value }, { timeoutMs: 5000 }); return 'ok'; }
  catch (e) { return (e as CliError).exitCode === 3 ? 'unauthorised' : 'failed'; }
}

/** One key's current value — the half of `config show` an operator actually asked for. */
export async function configGet(ctx: CliContext, key: string): Promise<unknown> {
  const cfg = requireConfig(ctx);
  if (!configField(key)) {
    const near = nearestConfigKey(key);
    throw new CliError(`unknown config key '${key}'${near ? ` — did you mean '${near}'?` : `; \`${PROG} config show\` lists every key this node has`}`);
  }
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), redact(cfg));
  // Asking for one teach key and being told the value the node is NOT using is exactly the trap of item 125.
  const override = TEACH_OVERRIDES.some((m) => m.key === key) ? (await teachOverrides(ctx, cfg)).overrides.find((o) => o.key === key) : undefined;
  if (value === undefined && !override) {
    info(ctx, c.dim(`${key} is not set in ${configPath(ctx.home)} (the node uses its built-in default)`));
    return undefined;
  }
  emit(ctx, override ? { value, effective: override.effective, overridden_by: 'console' } : value, () => [
    typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value),
    ...(override ? [c.warn(`! the running node uses ${JSON.stringify(override.effective)}: a console override (settings.teach) wins over this file, and survives a restart.`),
      c.dim(`  \`${PROG} config set ${key} <value>\` writes both; \`${PROG} config unset ${key}\` clears the override.`)] : []),
  ].join('\n'));
  return value;
}

/** Remove a key so the node falls back to its default; a key the config cannot do without is reset, not deleted. */
export async function configUnset(ctx: CliContext, key: string): Promise<NodeConfig> {
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
  // Unsetting a teach key must also clear the console override, or the node keeps the value the file no longer has (item 125).
  const mapped = TEACH_OVERRIDES.find((m) => m.key === key);
  if (mapped && (await runningHere(ctx, cfg))) {
    const wrote = await writeTeachOverride(ctx, mapped.api, null);
    if (wrote === 'ok') ok(ctx, `the console override for ${key} was cleared too ${c.dim('(the running node is back on config.json / its built-in default)')}`);
    else warn(ctx, `could not clear the console override for ${key}${wrote === 'unauthorised' ? ` — sign in (\`${PROG} login\`) and run this again` : ''}: until it is cleared the running node keeps using it, and a restart will not help`);
  }
  return cfg;
}

export async function keysShow(ctx: CliContext, reveal = false, yes = false): Promise<{ address: string; publicKey: string; privateKey?: string }> {
  const cfg = requireConfig(ctx);
  const out: { address: string; publicKey: string; privateKey?: string } = { address: cfg.identity.address, publicKey: cfg.identity.publicKey };
  if (reveal) {
    // printing the key puts it in scrollback, in shell history and in any terminal recording (item 122)
    if (!yes && !ctx.json && !ctx.quiet) {
      warn(ctx, 'this prints the node\'s private key on the screen: it will be in your scrollback and in anything recording this terminal.');
      const typed = await promptLine('Type "show" to print it (anything else cancels): ');
      if (typed.toLowerCase() !== 'show') throw new CliError('cancelled — nothing was printed');
    }
    out.privateKey = cfg.identity.privateKey;
  }
  emit(ctx, out, (d) => kv([['address', d.address], ['public key', d.publicKey], ...(d.privateKey ? [['private key', c.err(d.privateKey)] as [string, unknown]] : [])]) +
    (reveal ? `\n${c.dim(`this is the only copy unless you made one: \`${PROG} keys backup <file>\``)}`
      : `\n${c.dim(`add --reveal to print the private key, or \`${PROG} keys backup <file>\` to save it`)}`));
  return out;
}

// ------------------------------------------------------------------ keys backup / import / rotate (item 122)

/** A node-key backup file: the same shape the teach flow downloads, with the key encrypted when a passphrase is given. */
export interface KeyBackup {
  kind: 'ainize-node-key';
  version: 1;
  address: string;
  publicKey: string;
  node?: string;
  created_at: string;
  /** plaintext form */
  privateKey?: string;
  /** encrypted form (scrypt + aes-256-gcm) */
  cipher?: { alg: 'aes-256-gcm'; kdf: 'scrypt'; n: number; salt: string; iv: string; tag: string; ciphertext: string };
}

const keyFrom = (pass: string, salt: Buffer, n: number): Buffer => scryptSync(pass, salt, 32, { N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

export function encryptKey(privateKey: string, passphrase: string): NonNullable<KeyBackup['cipher']> {
  const n = 16384;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt, n), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return { alg: 'aes-256-gcm', kdf: 'scrypt', n, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') };
}

export function decryptKey(cipher: NonNullable<KeyBackup['cipher']>, passphrase: string): string {
  const d = createDecipheriv('aes-256-gcm', keyFrom(passphrase, Buffer.from(cipher.salt, 'hex'), cipher.n), Buffer.from(cipher.iv, 'hex'));
  d.setAuthTag(Buffer.from(cipher.tag, 'hex'));
  try { return Buffer.concat([d.update(Buffer.from(cipher.ciphertext, 'hex')), d.final()]).toString('utf8'); }
  catch { throw new CliError('wrong passphrase for this backup'); }
}

const passphraseOf = async (ctx: CliContext, given: string | undefined, question: string): Promise<string> => {
  const p = given ?? process.env.AINIZE_KEY_PASSPHRASE;
  if (p !== undefined) return p;
  if (!process.stdin.isTTY || ctx.quiet || ctx.json) return '';
  return promptPassword(question);
};

/** Write the node's key to a file: encrypted when there is a passphrase, always mode 0600. */
export async function keysBackup(ctx: CliContext, file: string, a: { passphrase?: string; force?: boolean } = {}): Promise<KeyBackup> {
  const cfg = requireConfig(ctx);
  if (existsSync(file) && !a.force) throw new CliError(`${file} already exists — pick another name (or pass --force to overwrite it)`);
  const pass = await passphraseOf(ctx, a.passphrase, 'Passphrase to encrypt the backup (empty = store the key in the clear): ');
  const backup: KeyBackup = {
    kind: 'ainize-node-key', version: 1, address: cfg.identity.address, publicKey: cfg.identity.publicKey, node: cfg.name,
    created_at: new Date().toISOString(),
    ...(pass ? { cipher: encryptKey(cfg.identity.privateKey, pass) } : { privateKey: cfg.identity.privateKey }),
  };
  writeFileSync(file, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
  emit(ctx, backup, () => [
    c.ok('✓ ') + `node key of ${cfg.name} (${cfg.identity.address}) written to ${file}`,
    pass ? c.dim('  encrypted (scrypt + aes-256-gcm) — without the passphrase this file is useless, including to you')
      : c.warn('  the key is in the CLEAR in this file — store it somewhere only you can read (a passphrase encrypts it: --passphrase)'),
    c.dim(`  restore it on another machine with \`${PROG} keys import ${file}\``),
  ].join('\n'));
  return backup;
}

/** Read a backup file (either shape) and return the private key it holds. */
export async function readKeyBackup(ctx: CliContext, file: string, passphrase?: string): Promise<{ privateKey: string; backup: KeyBackup }> {
  if (!existsSync(file)) throw new CliError(`no such file: ${file}`);
  let backup: KeyBackup;
  try { backup = JSON.parse(readFileSync(file, 'utf8')) as KeyBackup; } catch { throw new CliError(`${file} is not a key backup (expected the JSON \`${PROG} keys backup\` writes)`); }
  if (backup.privateKey) return { privateKey: backup.privateKey.replace(/^0x/, ''), backup };
  if (!backup.cipher) throw new CliError(`${file} carries no key (neither \`privateKey\` nor \`cipher\`)`);
  const pass = await passphraseOf(ctx, passphrase, `Passphrase for ${file}: `);
  if (!pass) throw new CliError('this backup is encrypted — pass --passphrase (or set AINIZE_KEY_PASSPHRASE)');
  return { privateKey: decryptKey(backup.cipher, pass), backup };
}

/** Replace this home's identity, after a typed confirmation and a copy of the old config. */
async function replaceIdentity(ctx: CliContext, cfg: NodeConfig, next: NodeConfig['identity'], what: string): Promise<{ backup: string; address: string }> {
  if (next.address.toLowerCase() === cfg.identity.address.toLowerCase()) throw new CliError(`${next.address} is already this node's identity — nothing to do`);
  if (!ctx.quiet) {
    process.stdout.write([
      c.warn(`! ${what} replaces the node identity `) + c.bold(cfg.identity.address),
      c.dim('  Every knowledge it published stays on the permanent record under an address nobody can sign for, and any'),
      c.dim(`  balance or pending payout is orphaned. Back it up first: \`${PROG} keys backup <file>\`.`),
      '',
    ].join('\n'));
  }
  const typed = await promptLine(`Type the current address to replace it (${cfg.identity.address}): `);
  if (typed.toLowerCase() !== cfg.identity.address.toLowerCase()) {
    throw new CliError(typed ? 'that is not this node\'s address — nothing was changed' : 'no address typed — nothing was changed');
  }
  const backup = backupConfig(ctx.home);
  cfg.identity = next;
  saveConfig(cfg, ctx.home);
  return { backup, address: next.address };
}

/** Install a backed-up key as this node's identity (the way back after a wiped disk). */
export async function keysImport(ctx: CliContext, file: string, a: { passphrase?: string } = {}): Promise<{ address: string }> {
  const cfg = requireConfig(ctx);
  const { privateKey } = await readKeyBackup(ctx, file, a.passphrase);
  let next: NodeConfig['identity'];
  try { next = identityFromPrivateKey(privateKey); } catch { throw new CliError(`${file} does not hold a valid private key`); }
  const r = await replaceIdentity(ctx, cfg, next, 'importing a key');
  ok(ctx, `this node is now ${r.address} ${c.dim(`(previous config saved as ${r.backup}; restart the node to apply)`)}`);
  return { address: r.address };
}

/** Mint a new identity for this node, keeping every other setting. */
export async function keysRotate(ctx: CliContext): Promise<{ address: string; previous: string }> {
  const cfg = requireConfig(ctx);
  const previous = cfg.identity.address;
  const r = await replaceIdentity(ctx, cfg, createIdentity(), 'rotating the key');
  ok(ctx, `new identity ${r.address} ${c.dim(`(was ${previous}; previous config saved as ${r.backup}; restart the node to apply)`)}`);
  return { address: r.address, previous };
}
