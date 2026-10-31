import type { Argv } from 'yargs';
import { NodeClient } from '../client.js';
import { PROG, type CliContext } from '../context.js';
import { confirm, emit } from '../output.js';
import { ReviewedChainSetup, setupExitCode, type SetupStatus, type SetupOptions } from '../chain-setup.js';

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export const setupRecovery = (ctx: Pick<CliContext, 'nodeUrl'>, id?: string) => `${PROG} chain setup --status${id ? ' --request-id ' + quote(id) : ''} --node ${quote(ctx.nodeUrl)}`;
export function formatSetup(value: SetupStatus, ctx: Pick<CliContext, 'nodeUrl'>) {
  const op = value.operation;
  return [value.verification?.valid ? 'Current market rules verified.' : value.verification ? 'Current market rules are not verified.' : 'Current chain inspection unavailable.',
    `Node wallet: ${value.context.node}`, `Chain ID: ${value.context.chain_id}  Provider: ${JSON.stringify(value.context.provider)}  App: ${value.context.app}`,
    ...(op ? [`Saved request: ${op.id}  State: ${op.state}`, `Reported app creation: ${op.created === null ? 'not reported' : op.created ? 'created' : 'already existed'}`,
      ...(op.admin ? [`Reported admin: ${op.admin}`] : []), ...(op.tx ? [`Reported transaction: ${JSON.stringify(op.tx)}`] : []), ...(op.error ? [`Saved error: ${JSON.stringify(op.error)}`] : [])] : []),
    ...(value.read_error ? [`Inspection error: ${JSON.stringify(value.read_error)}`] : []), ...value.verification?.errors.map(e => `Rule: ${JSON.stringify(e)}`) ?? [],
    'Rule verification is not transaction finality, staking, app ownership or runtime readiness.',
    `Inspect: ${setupRecovery(ctx, op?.id)}`].join('\n');
}
export const chainSetupOptions = (y: Argv<any>) => y
  .option('status', { type: 'boolean', default: false, describe: 'read setup status only; never fund, stake or set rules' })
  .option('request-id', { type: 'string', describe: 'exact 32-hex request ID; with --status reads that saved request' })
  .option('retry-of', { type: 'string', describe: 'explicitly retry this terminal unconfirmed request with a new ID' })
  .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'authorize the reviewed setup without an interactive prompt' })
  .option('fund', { type: 'number', hidden: true, describe: 'removed: use chain fund separately' });
export async function chainSetup(ctx: CliContext, opts: SetupOptions & { yes?: boolean } = {}) {
  const service = new ReviewedChainSetup(new NodeClient(ctx), {
    recovery: id => setupRecovery(ctx, id),
    confirm: async (value, id, retryOf) => confirm(ctx, [formatSetup(value, ctx),
      `New request: ${id}`, ...(retryOf ? [`Explicit retry of: ${retryOf}. The earlier attempt may have incurred fees.`] : []),
      'This may create the knowledge app and update market rules using the node wallet. Chain fees may apply. No automatic funding or staking.',
      `Recovery: ${setupRecovery(ctx, id)}`, 'Apply this reviewed setup? [y/N]'].join('\n'), { yes: opts.yes, stderr: true }),
  });
  const value = await service.run(opts);
  if (ctx.quiet && !ctx.json) { if (value.operation) process.stdout.write(value.operation.id + '\n'); }
  else emit(ctx, value, data => formatSetup(data, ctx));
  process.exitCode = setupExitCode(value, opts.status);
  return value;
}
