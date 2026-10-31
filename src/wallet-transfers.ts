import { randomBytes } from 'node:crypto';
import { CliError } from './context.js';

export interface TransferContext { node: string; rpc_url: string; chain_id: number; gas_price: number }
export interface TransferReceipt {
  version: 1; id: string; context: TransferContext; actor: string; to: string; amount: string; memo: string | null;
  currency: 'AIN'; tx_hash: string; state: 'prepared' | 'submitted' | 'confirmed' | 'rejected' | 'cancelled'; created_at: number; updated_at: number;
}
export interface TransferStatus { version: 1; context: TransferContext; operation: TransferReceipt | null; read_error: string | null }
export interface TransferHistory { version: 1; context: TransferContext; cursor: string | null; items: TransferReceipt[]; next_cursor: string | null }
type Owner = { node: string; actor: string };
interface Client { get<T = unknown>(path: string): Promise<T>; post<T = unknown>(path: string, body?: unknown): Promise<T> }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const transferAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
export const transferId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
export const transferContextKey = (c: TransferContext) => JSON.stringify([c.node.toLowerCase(), c.rpc_url, c.chain_id, c.gas_price]);
export function transferAmount(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$/.test(raw)) return null;
  const canonical = raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
  const value = Number(canonical);
  return value > 0 && value <= Number.MAX_SAFE_INTEGER && String(value) === canonical ? canonical : null;
}
function readContext(v: unknown): TransferContext | null {
  if (!object(v) || !transferAddress(v.node) || typeof v.rpc_url !== 'string' || !Number.isSafeInteger(v.chain_id) || v.chain_id < 0 || !Number.isFinite(v.gas_price) || v.gas_price < 0) return null;
  try { const u = new URL(v.rpc_url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) return null; } catch { return null; }
  return { node: v.node, rpc_url: v.rpc_url, chain_id: v.chain_id, gas_price: v.gas_price };
}
export function readTransferStatus(raw: unknown, node: string, requestedId?: string): TransferStatus | null {
  if (!object(raw) || raw.version !== 1 || 'signature' in raw || 'tx_body' in raw || raw.read_error !== null && typeof raw.read_error !== 'string') return null;
  const context = readContext(raw.context), op = raw.operation;
  if (!context || context.node.toLowerCase() !== node.toLowerCase()) return null;
  if (op === null) return requestedId ? null : { version: 1, context, operation: null, read_error: raw.read_error };
  if (!object(op) || op.version !== 1 || !transferId(op.id) || requestedId && op.id !== requestedId || 'signature' in op || 'tx_body' in op) return null;
  const savedContext = readContext(op.context);
  if (!savedContext || savedContext.node.toLowerCase() !== node.toLowerCase() || !transferAddress(op.actor) || !transferAddress(op.to)
    || op.to.toLowerCase() === node.toLowerCase() || typeof op.amount !== 'string' || transferAmount(op.amount) !== op.amount
    || op.memo != null && (typeof op.memo !== 'string' || op.memo.length > 200) || op.currency !== 'AIN'
    || typeof op.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(op.tx_hash) || !['prepared', 'submitted', 'confirmed', 'rejected', 'cancelled'].includes(op.state)
    || !Number.isSafeInteger(op.created_at) || op.created_at < 0 || !Number.isSafeInteger(op.updated_at) || op.updated_at < op.created_at) return null;
  return { version: 1, context, read_error: raw.read_error, operation: {
    version: 1, id: op.id, context: savedContext, actor: op.actor, to: op.to, amount: op.amount, memo: op.memo ?? null, currency: 'AIN',
    tx_hash: op.tx_hash, state: op.state, created_at: op.created_at, updated_at: op.updated_at,
  } };
}
const intentKey = (op: TransferReceipt) => JSON.stringify([op.id, transferContextKey(op.context), op.actor.toLowerCase(), op.to.toLowerCase(), op.amount, op.memo, op.tx_hash, op.created_at]);
const pending = (op: TransferReceipt | null) => op?.state === 'prepared' || op?.state === 'submitted';
const message = (e: unknown) => e instanceof Error ? e.message : 'request failed';

/** No fallback to unreviewed send, no background retries, and no inference that a missing receipt means no spend. */
export class WalletTransfers {
  constructor(private client: Client, private deps: {
    requestId?: () => string;
    confirm: (receipt: TransferReceipt) => Promise<void>;
    preparing?: (id: string) => void;
    recovery: (id?: string) => string;
  }) {}
  private async owner(): Promise<Owner> {
    const me = await this.client.get<unknown>('/api/auth/me');
    if (!object(me) || me.signedIn !== true || me.isOwner !== true || !transferAddress(me.subject) || !transferAddress(me.address)) throw new CliError('a signed-in wallet that owns this node is required; node linking alone cannot authorize a transfer', 3);
    return { node: me.address, actor: me.subject };
  }
  private async inspect(id?: string): Promise<{ owner: Owner; value: TransferStatus }> {
    if (id !== undefined && !transferId(id)) throw new CliError('request ID must be 32 lowercase hexadecimal characters', 1);
    const owner = await this.owner();
    const value = await this.read(owner, id);
    return { owner, value };
  }
  private async read(owner: Owner, id?: string): Promise<TransferStatus> {
    const raw = await this.client.get<unknown>(`/api/me/wallet/send-requests${id ? '/' + id : ''}`);
    const value = readTransferStatus(raw, owner.node, id);
    if (!value) throw new CliError(`the node returned an invalid or mismatched transfer receipt; inspect with ${this.deps.recovery(id)}`, 4, { request_id: id ?? null });
    return value;
  }
  async status(id?: string): Promise<TransferStatus> { return (await this.inspect(id)).value; }
  async prepare(to: string, amountInput: string, opts: { memo?: string; requestId?: string } = {}): Promise<TransferStatus> {
    const amount = transferAmount(amountInput), memo = opts.memo ?? null;
    if (!transferAddress(to) || !amount || memo !== null && (typeof memo !== 'string' || memo.length > 200)) throw new CliError('use an AIN recipient and a positive exact decimal amount with up to six places; memo is at most 200 characters', 1);
    const id = opts.requestId ?? this.deps.requestId?.() ?? randomBytes(16).toString('hex');
    if (!transferId(id)) throw new CliError('request ID must be 32 lowercase hexadecimal characters', 1);
    const { owner, value: before } = await this.inspect();
    if (to.toLowerCase() === owner.node.toLowerCase()) throw new CliError('recipient is the node’s own wallet; choose another address', 1);
    const matches = (op: TransferReceipt | null) => !!op && op.id === id && op.to.toLowerCase() === to.toLowerCase() && op.amount === amount && op.memo === memo && op.actor.toLowerCase() === owner.actor.toLowerCase() && transferContextKey(op.context) === transferContextKey(before.context);
    if (pending(before.operation)) {
      if (opts.requestId && matches(before.operation)) return before;
      throw new CliError(`another transfer is unresolved; inspect ${this.deps.recovery(before.operation!.id)} before preparing another`, 5, before);
    }
    this.deps.preparing?.(id);
    try { await this.client.post('/api/me/wallet/send-requests', { request_id: id, expected: before.context, to, amount, ...(memo !== null ? { memo } : {}) }); }
    catch { /* Preparation may have committed; only read the retained request. */ }
    let after: TransferStatus;
    try { after = await this.read(owner, id); }
    catch { throw new CliError(`preparation could not be confirmed. This command has not submitted a transfer. Inspect ${this.deps.recovery(id)} and wallet history; do not create another send blindly`, 4, { request_id: id }); }
    if (!matches(after.operation) || transferContextKey(after.context) !== transferContextKey(before.context)) throw new CliError(`prepared receipt does not match the reviewed intent; inspect ${this.deps.recovery(id)}`, 4, { request_id: id });
    return after;
  }
  async submit(id: string): Promise<TransferStatus> {
    const before = await this.inspect(id), op = before.value.operation!;
    if (op.state !== 'prepared') return before.value;
    this.canSubmit(before.owner, before.value);
    try { await this.deps.confirm(op); }
    catch (e) {
      throw new CliError(`this command did not submit the transfer. Prepared request ${id} remains saved; inspect ${this.deps.recovery(id)} or explicitly cancel it. ${e instanceof CliError && e.exitCode === 130 ? 'Confirmation declined.' : message(e)}`, e instanceof CliError ? e.exitCode : 1, { request_id: id, receipt: before.value });
    }
    const fresh = await this.inspect(id);
    if (fresh.owner.actor.toLowerCase() !== before.owner.actor.toLowerCase() || fresh.owner.node.toLowerCase() !== before.owner.node.toLowerCase()) throw new CliError('the signed-in operator or node changed during review; no submit was made', 3);
    if (intentKey(fresh.value.operation!) !== intentKey(op)) throw new CliError('the prepared transfer changed during review; no submit was made', 4, { request_id: id });
    if (fresh.value.operation!.state !== 'prepared') return fresh.value;
    this.canSubmit(fresh.owner, fresh.value);
    return this.writeThenInspect(fresh.owner, op, 'submit');
  }
  private canSubmit(owner: Owner, value: TransferStatus) {
    if (value.operation!.actor.toLowerCase() !== owner.actor.toLowerCase()) throw new CliError('only the operator who prepared this transfer can submit it; another owner may cancel the preparation', 3);
    if (transferContextKey(value.operation!.context) !== transferContextKey(value.context)) throw new CliError('the chain connection changed; inspect the saved transfer or cancel its preparation before continuing', 1);
  }
  async cancel(id: string): Promise<TransferStatus> {
    const { owner, value } = await this.inspect(id);
    if (value.operation!.state !== 'prepared') return value;
    return this.writeThenInspect(owner, value.operation!, 'cancel');
  }
  private async writeThenInspect(owner: Owner, op: TransferReceipt, action: 'submit' | 'cancel'): Promise<TransferStatus> {
    let failure: unknown;
    try { await this.client.post(`/api/me/wallet/send-requests/${op.id}/${action}`, {}); } catch (e) { failure = e; }
    let after: TransferStatus;
    try { after = await this.read(owner, op.id); }
    catch { throw new CliError(`the ${action} outcome is unconfirmed; do not send again. Inspect ${this.deps.recovery(op.id)}`, 4, { request_id: op.id }); }
    if (intentKey(after.operation!) !== intentKey(op)) throw new CliError(`the returned receipt is not the reviewed transfer; inspect ${this.deps.recovery(op.id)}`, 4, { request_id: op.id });
    if (after.operation!.state === 'prepared') throw new CliError(`request remains prepared; ${action} was not confirmed. ${failure ? message(failure) : ''} Inspect ${this.deps.recovery(op.id)}`, 4, after);
    return after;
  }
  async send(to: string, amount: string, opts: { memo?: string; requestId?: string } = {}): Promise<TransferStatus> {
    const prepared = await this.prepare(to, amount, opts);
    return this.submit(prepared.operation!.id);
  }
  async history(opts: { cursor?: string; limit?: number } = {}): Promise<TransferHistory> {
    const limit = opts.limit ?? 20, cursor = opts.cursor ?? null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))) throw new CliError('history needs a limit from 1 to 50 and an unchanged cursor from the previous page', 1);
    const owner = await this.owner(), params = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    const raw = await this.client.get<unknown>('/api/me/wallet/send-history?' + params);
    if (!object(raw) || raw.version !== 1 || raw.cursor !== cursor || !Array.isArray(raw.items) || raw.items.length > limit
      || raw.next_cursor !== null && (typeof raw.next_cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw.next_cursor) || raw.next_cursor === cursor || raw.items.length !== limit)) throw new CliError('invalid transfer history page', 1);
    const root = readTransferStatus({ version: 1, context: raw.context, operation: null, read_error: null }, owner.node);
    if (!root) throw new CliError('transfer history belongs to another node or has no valid chain context', 1);
    const items: TransferReceipt[] = [], ids = new Set<string>();
    for (const item of raw.items) {
      const row = readTransferStatus({ version: 1, context: root.context, operation: item, read_error: null }, owner.node)?.operation, prev = items.at(-1);
      if (!row || ids.has(row.id) || prev && (row.created_at > prev.created_at || row.created_at === prev.created_at && row.id >= prev.id)) throw new CliError('invalid, duplicated or unordered transfer history', 1);
      ids.add(row.id); items.push(row);
    }
    return { version: 1, context: root.context, cursor, items, next_cursor: raw.next_cursor };
  }
}

export function transferExitCode(value: TransferStatus, action: 'read' | 'prepare' | 'submit' | 'cancel'): number {
  if (action === 'read') return 0;
  const state = value.operation?.state;
  if (action === 'prepare' && state === 'prepared' || action === 'submit' && state === 'confirmed' || action === 'cancel' && state === 'cancelled') return 0;
  return state === 'cancelled' || state === 'rejected' || state === 'confirmed' ? 1 : 4;
}
