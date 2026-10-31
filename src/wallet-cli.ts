import type { Argv } from 'yargs';
import type { CliContext } from './context.js';
import { wallet } from './commands/branch.js';
import * as transfers from './commands/wallet-transfers.js';

type Y = Argv<any>;
type Run = (fn: (ctx: CliContext, args: any) => unknown | Promise<unknown>) => (args: any) => void | Promise<void>;
/** Shared with parser tests, so tests exercise the actual commands and preserve decimal strings. */
export function walletCommands(y: Y, run: Run): Y {
  const amount = (yy: Y) => yy
    .positional('address', { type: 'string', demandOption: true, describe: 'recipient AIN address' })
    .positional('amount', { type: 'string', demandOption: true, describe: 'exact positive AIN decimal, up to six places; never rounded' })
    .option('memo', { type: 'string', describe: 'a note retained on the node, not on the chain (max 200 characters)' })
    .option('request-id', { type: 'string', describe: '32 lowercase hex characters; retain for recovery, never reuse for another intent' });
  const request = (yy: Y) => yy.positional('requestId', { type: 'string', demandOption: true, describe: 'exact retained transfer request ID' });
  const approval = (yy: Y) => yy.option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'authorize the reviewed transfer without an interactive prompt' });
  return y
    .command(['show', '$0'], 'Balance, sales, royalties and pending payouts', (yy: Y) => yy, run(ctx => wallet(ctx)))
    .command('prepare <address> <amount>', 'Save a reviewed AIN transfer without submitting it', amount, run((ctx, a) => transfers.walletPrepare(ctx, a.address, a.amount, { memo: a.memo, requestId: a.requestId })))
    .command('send <address> <amount>', 'Prepare, review and submit one AIN transfer', (yy: Y) => approval(amount(yy)), run((ctx, a) => transfers.walletSend(ctx, a.address, a.amount, { memo: a.memo, requestId: a.requestId, yes: a.yes })))
    .command('submit <requestId>', 'Review and explicitly submit a saved prepared transfer', (yy: Y) => approval(request(yy)), run((ctx, a) => transfers.walletSubmit(ctx, a.requestId, { yes: a.yes })))
    .command('cancel <requestId>', 'Cancel preparation only; submitted transfers cannot be cancelled', request, run((ctx, a) => transfers.walletCancel(ctx, a.requestId)))
    .command('status [requestId]', 'Read the exact retained transfer or latest request; never sends', (yy: Y) => yy.positional('requestId', { type: 'string', describe: 'exact request ID; omitted reads the latest' }), run((ctx, a) => transfers.walletStatus(ctx, a.requestId)))
    .command('history', 'List saved manual transfers, newest first; never sends', (yy: Y) => yy
      .option('cursor', { type: 'string', describe: 'unchanged next_cursor from the preceding history page' })
      .option('limit', { type: 'number', default: 20, describe: 'page size from 1 to 50' }), run((ctx, a) => transfers.walletHistory(ctx, { cursor: a.cursor, limit: a.limit })));
}
