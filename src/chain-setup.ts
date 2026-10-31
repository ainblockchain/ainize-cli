import { randomBytes } from 'node:crypto';
import { CliError } from './context.js';
import { transferAddress, transferId } from './wallet-transfers.js';

export interface SetupContext { node: string; provider: string; chain_id: number; app: '/apps/knowledge' }
export interface SetupOperation {
  version: 1; id: string; context: SetupContext; actor: string; state: 'running' | 'verified' | 'unconfirmed';
  created_at: number; updated_at: number; created: boolean | null; tx: string | null; admin: string | null; error: string | null;
}
export interface SetupStatus {
  version: 1; capabilities: { exact_request_status: true; reviewed_selection: true }; context: SetupContext;
  verification: { valid: boolean; errors: string[] } | null; read_error: string | null; operation: SetupOperation | null;
}
export interface SetupOptions { status?: boolean; requestId?: string; retryOf?: string; fund?: number }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const setupContextKey = (c: SetupContext) => JSON.stringify([c.node.toLowerCase(), c.provider, c.chain_id, c.app]);
function readContext(raw: unknown): SetupContext | null {
  if (!object(raw) || !transferAddress(raw.node) || typeof raw.provider !== 'string' || !Number.isSafeInteger(raw.chain_id) || raw.chain_id < 0 || raw.app !== '/apps/knowledge') return null;
  try { const url = new URL(raw.provider); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) return null; } catch { return null; }
  return { node: raw.node, provider: raw.provider, chain_id: raw.chain_id, app: raw.app };
}
export function readSetupStatus(raw: unknown, node: string, id?: string): SetupStatus | null {
  if (!object(raw) || raw.version !== 1 || raw.capabilities?.exact_request_status !== true || raw.capabilities?.reviewed_selection !== true || raw.read_error !== null && typeof raw.read_error !== 'string') return null;
  const context = readContext(raw.context), v = raw.verification, op = raw.operation;
  if (!context || context.node.toLowerCase() !== node.toLowerCase()) return null;
  if (v !== null && (!object(v) || typeof v.valid !== 'boolean' || !Array.isArray(v.errors) || !v.errors.every((e: unknown) => typeof e === 'string') || v.valid !== (v.errors.length === 0))) return null;
  if (v === null && !raw.read_error || v !== null && raw.read_error !== null) return null;
  let operation: SetupOperation | null = null;
  if (op !== null) {
    const saved = object(op) ? readContext(op.context) : null;
    if (!object(op) || !saved || setupContextKey(saved) !== setupContextKey(context) || op.version !== 1 || !transferId(op.id) || id && op.id !== id
      || !transferAddress(op.actor) || !['running', 'verified', 'unconfirmed'].includes(op.state)
      || !Number.isSafeInteger(op.created_at) || op.created_at < 0 || !Number.isSafeInteger(op.updated_at) || op.updated_at < op.created_at
      || ![true, false, null].includes(op.created) || op.tx !== null && typeof op.tx !== 'string' || op.admin !== null && !transferAddress(op.admin) || op.error !== null && typeof op.error !== 'string') return null;
    operation = { version: 1, id: op.id, context: saved, actor: op.actor, state: op.state, created_at: op.created_at, updated_at: op.updated_at, created: op.created, tx: op.tx, admin: op.admin, error: op.error };
  } else if (id) return null;
  return { version: 1, capabilities: { exact_request_status: true, reviewed_selection: true }, context, verification: v ? { valid: v.valid, errors: [...v.errors] } : null, read_error: raw.read_error, operation };
}
const selection = (v: SetupStatus) => JSON.stringify([setupContextKey(v.context), v.operation]);
interface Client { get<T = unknown>(path: string): Promise<T>; post<T = unknown>(path: string, body?: unknown): Promise<T> }
export class ReviewedChainSetup {
  constructor(private client: Client, private deps: {
    confirm: (value: SetupStatus, requestId: string, retryOf?: string) => Promise<void>;
    recovery: (id?: string) => string; requestId?: () => string;
  }) {}
  private async owner() {
    const me = await this.client.get<unknown>('/api/auth/me');
    if (!object(me) || me.signedIn !== true || me.isOwner !== true || !transferAddress(me.address) || !transferAddress(me.subject)) throw new CliError('a current owner wallet session on the selected node is required for chain setup', 3);
    return { node: me.address, actor: me.subject };
  }
  private async read(node: string, id?: string) {
    const value = readSetupStatus(await this.client.get(`/api/chain/setup${id ? '/requests/' + id : ''}`), node, id);
    if (!value) throw new CliError(`invalid, mismatched or unsupported setup status; upgrade the node to the reviewed setup API and inspect ${this.deps.recovery(id)}`, 4, { request_id: id ?? null });
    return value;
  }
  async status(id?: string) {
    if (id !== undefined && !transferId(id)) throw new CliError('request ID must be 32 lowercase hexadecimal characters');
    const owner = await this.owner(); return this.read(owner.node, id);
  }
  async run(opts: SetupOptions = {}): Promise<SetupStatus> {
    if (opts.fund !== undefined) throw new CliError('chain setup no longer funds the node automatically. Use chain fund ADDRESS AMOUNT explicitly on a local test chain, then run setup separately.');
    if (opts.requestId !== undefined && !transferId(opts.requestId) || opts.retryOf !== undefined && !transferId(opts.retryOf)) throw new CliError('request ID and retry-of must be 32 lowercase hexadecimal characters');
    if (opts.status) {
      if (opts.retryOf) throw new CliError('--status is read-only and cannot be combined with --retry-of');
      return this.status(opts.requestId);
    }
    const owner = await this.owner(), before = await this.read(owner.node);
    if (opts.requestId && before.operation?.id === opts.requestId) return this.read(owner.node, opts.requestId);
    if (before.operation?.state === 'running') throw new CliError(`a setup request remains running; do not restart it. Inspect ${this.deps.recovery(before.operation.id)}`, 4, before);
    if (!before.verification) throw new CliError(`chain inspection is unavailable; setup was not started. Inspect ${this.deps.recovery()}`, 4, before);
    if (before.verification.valid) return before;
    const retryOf = before.operation?.state === 'unconfirmed' ? before.operation.id : undefined;
    if (retryOf !== opts.retryOf) throw new CliError(`retry selection changed or is missing; inspect ${this.deps.recovery(before.operation?.id)} and explicitly select --retry-of only for the unconfirmed attempt you intend to repeat`, 5, before);
    const id = opts.requestId ?? this.deps.requestId?.() ?? randomBytes(16).toString('hex');
    if (!transferId(id) || id === retryOf) throw new CliError('a new valid request ID is required for an explicit retry');
    await this.deps.confirm(before, id, retryOf).catch(e => {
      throw new CliError('this command did not submit a setup request; confirmation was not given', e instanceof CliError ? e.exitCode : 1, { request_id: id });
    });
    const currentOwner = await this.owner(), fresh = await this.read(currentOwner.node);
    if (owner.node.toLowerCase() !== currentOwner.node.toLowerCase() || owner.actor.toLowerCase() !== currentOwner.actor.toLowerCase()) throw new CliError('the node or operator changed during review; setup was not submitted', 3);
    if (selection(before) !== selection(fresh)) throw new CliError('the reviewed chain or previous request changed; inspect status before starting setup', 5);
    if (!fresh.verification) throw new CliError('chain inspection became unavailable; setup was not submitted', 4);
    if (fresh.verification.valid) return fresh;
    try { await this.client.post('/api/chain/setup/requests', { request_id: id, expected: before.context, expected_request: before.operation?.id ?? null, ...(retryOf ? { retry_of: retryOf } : {}) }); }
    catch { /* A lost response can follow a committed request. Never POST again. */ }
    let after: SetupStatus;
    try { after = await this.read(owner.node, id); }
    catch { throw new CliError(`setup outcome is unconfirmed; do not start a replacement. Inspect ${this.deps.recovery(id)}`, 4, { request_id: id }); }
    if (setupContextKey(after.context) !== setupContextKey(before.context) || after.operation?.actor.toLowerCase() !== owner.actor.toLowerCase()) throw new CliError(`the retained setup receipt does not match this review; inspect ${this.deps.recovery(id)}`, 4, { request_id: id });
    return after;
  }
}
export function setupExitCode(value: SetupStatus, readOnly = false) {
  if (readOnly) return 0;
  return value.verification?.valid && (!value.operation || value.operation.state === 'verified') ? 0 : 4;
}
