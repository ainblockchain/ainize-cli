import { NodeClient } from '../client.js';
import { PROG, type CliContext } from '../context.js';
import { confirm, emit, info } from '../output.js';
import { WalletTransfers, transferExitCode, type TransferStatus, type TransferReceipt, type TransferHistory } from '../wallet-transfers.js';

const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export const transferRecoveryCommand = (ctx: Pick<CliContext, 'nodeUrl'>, id?: string) => `${PROG} wallet status${id ? ' ' + shellQuote(id) : ''} --node ${shellQuote(ctx.nodeUrl)}`;
const labels = {
  prepared: 'Prepared; not submitted', submitted: 'Outcome unconfirmed; do not send again',
  confirmed: 'Finalized successfully on the chain', rejected: 'Finalized with an execution failure; fees may have been charged',
  cancelled: 'Preparation cancelled without submission',
};
export function formatTransfer(value: TransferStatus, ctx: Pick<CliContext, 'nodeUrl'>): string {
  const op = value.operation;
  if (!op) return 'No saved manual transfer on this node.';
  return [labels[op.state], `Request: ${op.id}`, `${op.amount} AIN → ${op.to}`, `Node wallet: ${op.context.node}`,
    `Chain ID: ${op.context.chain_id}  RPC: ${JSON.stringify(op.context.rpc_url)}`, `Transaction: ${op.tx_hash}`,
    ...(op.memo !== null ? [`Memo (node record only): ${JSON.stringify(op.memo)}`] : []),
    ...(value.read_error ? [`Status read: ${JSON.stringify(value.read_error)}`] : []),
    `Inspect: ${transferRecoveryCommand(ctx, op.id)}`].join('\n');
}
function service(ctx: CliContext, yes = false) {
  return new WalletTransfers(new NodeClient(ctx), {
    recovery: id => transferRecoveryCommand(ctx, id),
    preparing: id => info(ctx, `Preparing request ${id}. Recovery: ${transferRecoveryCommand(ctx, id)}`),
    confirm: async (op: TransferReceipt) => {
      const review = [formatTransfer({ version: 1, context: op.context, operation: op, read_error: null }, ctx),
        'This spends the node wallet, not your personal wallet. Chain transfers are irreversible; additional fees may apply.'].join('\n');
      await confirm(ctx, `${review}\nSubmit this reviewed ${op.amount} AIN transfer to ${op.to}? [y/N]`, { yes, stderr: true });
    },
  });
}
export function emitTransfer(ctx: CliContext, value: TransferStatus, action: 'read' | 'prepare' | 'submit' | 'cancel') {
  if (ctx.quiet && !ctx.json) { if (value.operation) process.stdout.write(value.operation.id + '\n'); }
  else emit(ctx, value, data => formatTransfer(data, ctx));
  process.exitCode = transferExitCode(value, action);
  return value;
}
export async function walletPrepare(ctx: CliContext, to: string, amount: string, opts: { memo?: string; requestId?: string } = {}) {
  return emitTransfer(ctx, await service(ctx).prepare(to, amount, opts), 'prepare');
}
export async function walletSend(ctx: CliContext, to: string, amount: string, opts: { memo?: string; requestId?: string; yes?: boolean } = {}) {
  return emitTransfer(ctx, await service(ctx, opts.yes).send(to, amount, opts), 'submit');
}
export async function walletSubmit(ctx: CliContext, id: string, opts: { yes?: boolean } = {}) {
  return emitTransfer(ctx, await service(ctx, opts.yes).submit(id), 'submit');
}
export async function walletCancel(ctx: CliContext, id: string) {
  return emitTransfer(ctx, await service(ctx).cancel(id), 'cancel');
}
export async function walletStatus(ctx: CliContext, id?: string) {
  return emitTransfer(ctx, await service(ctx).status(id), 'read');
}
export async function walletHistory(ctx: CliContext, opts: { cursor?: string; limit?: number } = {}) {
  const value = await service(ctx).history(opts);
  if (ctx.quiet && !ctx.json) { for (const item of value.items) process.stdout.write(item.id + '\n'); }
  else emit(ctx, value, (data: TransferHistory) => [
    'Saved manual transfer states (open a request to check its chain outcome):',
    ...data.items.map(op => `${op.id}  ${op.amount} AIN → ${op.to}\n  ${labels[op.state]}`),
    ...(!data.items.length ? [data.cursor ? 'No older transfers.' : 'No saved transfers.'] : []),
    ...(data.next_cursor ? [`Older page: ${PROG} wallet history --cursor ${shellQuote(data.next_cursor)} --limit ${opts.limit ?? 20} --node ${shellQuote(ctx.nodeUrl)}`] : []),
    `Inspect a request: ${transferRecoveryCommand(ctx, '<request-id>')}`,
  ].join('\n'));
  return value;
}
