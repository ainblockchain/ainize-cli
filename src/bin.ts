#!/usr/bin/env node
/**
 * `ngram` — operate a knowledge-patch marketplace node (successor of ainize-cli).
 */
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { CliError, buildContext, type CliContext } from './context.js';
import * as init from './commands/init.js';
import * as node from './commands/node.js';
import * as auth from './commands/auth.js';
import * as peers from './commands/peers.js';
import * as patch from './commands/patch.js';
import * as ledger from './commands/ledger.js';
import * as branch from './commands/branch.js';
import * as drive from './commands/drive.js';
import * as chain from './commands/chain.js';

type G = { home?: string; node?: string; json?: boolean; quiet?: boolean };
const ctxOf = (a: G): CliContext => buildContext({ home: a.home, node: a.node, json: a.json, quiet: a.quiet });

const run = <A extends G>(fn: (ctx: CliContext, a: A) => Promise<unknown> | unknown, keepAlive = false) => async (a: A) => {
  try {
    await fn(ctxOf(a), a);
    if (!keepAlive) process.exitCode = 0;
  } catch (e) {
    const err = e as CliError;
    process.stderr.write(chalk.red('error: ') + (err.message ?? String(e)) + '\n');
    process.exit(err instanceof CliError ? err.exitCode : 1);
  }
};

const fail = (y: Argv) => y.fail((msg, err) => {
  process.stderr.write(chalk.red('error: ') + (err?.message ?? msg) + '\n' + chalk.gray('Specify --help for available options.') + '\n');
  process.exit(1);
});

const cli = yargs(hideBin(process.argv))
  .scriptName('ngram')
  .usage('$0 <command> [options]\n\nOperate a P2P knowledge-patch marketplace node: publish, verify, trade (x402) and apply n-gram memory patches.')
  .option('home', { type: 'string', describe: 'node home directory (NGRAM_HOME)', global: true })
  .option('node', { type: 'string', describe: 'node API URL (default: http://localhost:<config port>)', global: true })
  .option('json', { type: 'boolean', describe: 'machine-readable JSON output', global: true, default: false })
  .option('quiet', { type: 'boolean', describe: 'suppress output', global: true, default: false })
  .alias('h', 'help').help('help').version()
  .showHelpOnFail(false, 'Specify --help for available options.')
  .strict()
  .wrap(Math.min(110, process.stdout.columns || 100))
  .demandCommand(1, 'Specify a command. Try `ngram --help`.');

// ---------------------------------------------------------------- init / config / keys
cli.command('init', 'Create a node identity and config in NGRAM_HOME', (y) => fail(y)
  .option('name', { type: 'string', describe: 'node display name' })
  .option('port', { type: 'number', describe: 'HTTP port', default: undefined })
  .option('ledger', { choices: ['local', 'ain'] as const, describe: 'ledger backend: local P2P record DAG or AIN blockchain' })
  .option('ain-provider', { type: 'string', describe: 'AIN JSON-RPC URL (ain ledger)', default: undefined })
  .option('ain-chain-id', { type: 'number', describe: 'AIN chain id (0 = local/testnet)', default: undefined })
  .option('peer', { type: 'string', array: true, describe: 'seed peer URL(s)' })
  .option('roles', { type: 'string', describe: 'comma list of seller,verifier,serving,gateway' })
  .option('runtime-repo', { type: 'string', describe: 'reference runtime repo (scripts/patch.py)' })
  .option('runtime-api', { type: 'string', describe: 'serving API (OpenAI-compatible) URL' })
  .option('private-key', { type: 'string', describe: 'import an existing AIN private key (hex)' })
  .option('public-url', { type: 'string', describe: 'URL peers can reach this node at' })
  .option('force', { type: 'boolean', describe: 'overwrite existing config', default: false })
  .example('$0 init --name alice --port 3402', 'local ledger node')
  .example('$0 init --ledger ain --ain-provider http://localhost:8081', 'AIN blockchain ledger (see `ngram chain up`)'),
run((ctx, a: G & init.InitArgs & { 'ain-provider'?: string; 'ain-chain-id'?: number; 'runtime-repo'?: string; 'runtime-api'?: string; 'private-key'?: string; 'public-url'?: string }) =>
  init.init(ctx, { ...a, ainProvider: a['ain-provider'], ainChainId: a['ain-chain-id'], runtimeRepo: a['runtime-repo'], runtimeApi: a['runtime-api'], privateKey: a['private-key'], publicUrl: a['public-url'] })));

cli.command('config', 'Show or edit the node config', (y) => fail(y)
  .command('show', 'Print config.json (secrets hidden)', (yy) => yy, run((ctx) => init.configShow(ctx)))
  .command('set <key> <value>', 'Set a config key (dotted path, e.g. market.defaultPrice 0.5)', (yy) => yy
    .positional('key', { type: 'string', demandOption: true }).positional('value', { type: 'string', demandOption: true })
    .example('$0 config set ledger.kind ain', '').example('$0 config set peers http://a:3402,http://b:3403', ''),
  run((ctx, a: G & { key: string; value: string }) => init.configSet(ctx, a.key, a.value)))
  .demandCommand(1, 'Subcommand is required (show|set).'), () => undefined);

cli.command('keys', 'Node identity keys', (y) => fail(y)
  .command('show', 'Print address and public key', (yy) => yy.option('reveal', { type: 'boolean', default: false, describe: 'also print the private key' }),
    run((ctx, a: G & { reveal: boolean }) => init.keysShow(ctx, a.reveal)))
  .demandCommand(1, 'Subcommand is required (show).'), () => undefined);

// ---------------------------------------------------------------- lifecycle
cli.command('start', 'Start the node (foreground unless --detach)', (y) => fail(y)
  .option('port', { type: 'number' }).option('peer', { type: 'string', array: true, describe: 'extra peer URL(s)' })
  .option('roles', { type: 'string' }).option('public-url', { type: 'string' })
  .option('detach', { alias: 'd', type: 'boolean', default: false, describe: 'run in the background (pid in NGRAM_HOME/node.pid)' })
  .example('$0 start', '').example('$0 start -d --peer http://localhost:3402', 'second node joining the first'),
run(async (ctx, a: G & node.StartArgs & { 'public-url'?: string }) => {
  const r = await node.start(ctx, { ...a, publicUrl: a['public-url'] });
  if ('detached' in r) return r;
  process.stdout.write(chalk.gray('press Ctrl+C to stop\n'));
  await new Promise(() => undefined);   // keep alive
}, true));
cli.command('stop', 'Stop a background node', (y) => fail(y), run((ctx) => node.stop(ctx)));
cli.command('status', 'Show node / ledger / runtime status', (y) => fail(y), run((ctx) => node.status(ctx)));
cli.command('logs', 'Show node events', (y) => fail(y)
  .option('follow', { alias: 'f', type: 'boolean', default: false }).option('patch', { type: 'string', describe: 'only events of a patch' })
  .option('kind', { type: 'string', describe: 'filter by kind (p2p, verify, trade, runtime, …)' }).option('limit', { type: 'number', default: 100 }),
run((ctx, a: G & { follow: boolean; patch?: string; kind?: string; limit: number }) => node.logs(ctx, a), true));
cli.command('seed', 'Seed demo data (prototype ledger, real Qwen3.8 patches if present, synthetic branches)', (y) => fail(y)
  .option('real', { type: 'boolean', default: true, describe: 'register real patches from the runtime repo' })
  .option('synthetic', { type: 'boolean', default: true, describe: 'create synthetic law/KR vs law/US demo patches' })
  .option('prototype', { type: 'boolean', default: true, describe: 'import the reference prototype ledger' })
  .option('announce', { type: 'boolean', default: true }),
run((ctx, a: G & { real: boolean; synthetic: boolean; prototype: boolean; announce: boolean }) => node.seed(ctx, a)));
cli.command('nodes', 'List known nodes and configured peers', (y) => fail(y), run((ctx) => node.nodesTable(ctx)));

// ---------------------------------------------------------------- auth
cli.command('login', 'Log in as the node operator (sets the password on first use)', (y) => fail(y).option('password', { type: 'string', describe: 'or NGRAM_PASSWORD env' }),
  run((ctx, a: G & { password?: string }) => auth.login(ctx, a)));
cli.command('logout', 'Forget the operator session', (y) => fail(y), run((ctx) => auth.logout(ctx)));

// ---------------------------------------------------------------- peers
cli.command('peers', 'Manage peers', (y) => fail(y)
  .command('ls', 'List peers', (yy) => yy, run((ctx) => peers.peersLs(ctx)))
  .command('add <url>', 'Add a peer', (yy) => yy.positional('url', { type: 'string', demandOption: true }), run((ctx, a: G & { url: string }) => peers.peersAdd(ctx, a.url)))
  .command('rm <url>', 'Remove a peer', (yy) => yy.positional('url', { type: 'string', demandOption: true }), run((ctx, a: G & { url: string }) => peers.peersRm(ctx, a.url)))
  .demandCommand(1, 'Subcommand is required (ls|add|rm).'), () => undefined);

// ---------------------------------------------------------------- patches
cli.command('patch', 'Publish, inspect, verify, buy and apply knowledge patches', (y) => fail(y)
  .command('ls', 'List patches in the catalog', (yy) => yy
    .option('status', { type: 'string', describe: 'comma list: DRAFT,ANNOUNCED,VERIFYING,LISTED,REJECTED,CHALLENGED,SUPERSEDED' })
    .option('model', { type: 'string' }).option('schema', { type: 'string', describe: 'benchmark schema' }).option('branch', { type: 'string' })
    .option('author', { type: 'string' }).option('q', { type: 'string', describe: 'text search' })
    .option('sort', { choices: ['latest', 'popular', 'price', 'rows'] as const, default: 'latest' })
    .option('limit', { type: 'number', default: 100 }).option('mine', { type: 'boolean', default: false, describe: 'only my patches (needs login)' })
    .option('drafts', { type: 'boolean', default: false, describe: 'include my drafts (needs login)' }),
  run((ctx, a: G & patch.LsArgs) => patch.patchLs(ctx, a)))
  .command('get <id>', 'Show a patch in detail', (yy) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchGet(ctx, a.id)))
  .command('publish <file>', 'Register a .npz patch body as a draft (and optionally announce it)', (yy) => yy
    .positional('file', { type: 'string', demandOption: true, describe: 'path to .npz on the node machine' })
    .option('name', { type: 'string', demandOption: true }).option('model', { type: 'string', demandOption: true, describe: 'target model id_M' })
    .option('benchmark', { type: 'string', demandOption: true, describe: 'benchmark JSON file or inline JSON ({schema, queries, format, samples})' })
    .option('id', { type: 'string' }).option('price', { type: 'string' }).option('description', { type: 'string' })
    .option('parents', { type: 'string', describe: 'comma list of parent patch ids (lineage/royalty)' }).option('branch', { type: 'string' })
    .option('topic', { type: 'string', describe: 'ain-js knowledge topic path (e.g. finance/krx)' }).option('license', { type: 'string' })
    .option('billing', { choices: ['per_download', 'per_apply_hour', 'per_hit'] as const })
    .option('announce', { type: 'boolean', default: false, describe: 'announce to the network immediately' })
    .example('$0 patch publish ./rows.npz --name "KRX tickers" --model Qwen3.8-Flash-Next --benchmark bench.json --price 25 --announce', ''),
  run((ctx, a: G & patch.PublishArgs) => patch.patchPublish(ctx, a)))
  .command('announce <id>', 'DRAFT → ANNOUNCED (anchor on the ledger)', (yy) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchAnnounce(ctx, a.id)))
  .command('verify <id>', 'Run this node\'s verifier on a patch and publish an attestation', (yy) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchVerify(ctx, a.id)))
  .command('challenge <id>', 'Open a re-verification challenge', (yy) => yy.positional('id', { type: 'string', demandOption: true }).option('reason', { type: 'string', demandOption: true }),
    run((ctx, a: G & { id: string; reason: string }) => patch.patchChallenge(ctx, a.id, a.reason)))
  .command('buy <id>', 'Buy a listed patch via HTTP 402 (x402) and download its body', (yy) => yy.positional('id', { type: 'string', demandOption: true })
    .option('apply', { type: 'boolean', default: false, describe: 'apply to the serving runtime after download' }),
  run((ctx, a: G & { id: string; apply: boolean }) => patch.patchBuy(ctx, a.id, a.apply)))
  .command('apply <id>', 'Apply a held patch to the serving runtime (no restart)', (yy) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchApply(ctx, a.id)))
  .command('remove <id>', 'Restore original rows (un-apply)', (yy) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchRemove(ctx, a.id)))
  .command('conflicts <id>', 'Address-set overlaps with other patches', (yy) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchConflicts(ctx, a.id)))
  .command('records <id>', 'Ledger records about a patch', (yy) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchRecords(ctx, a.id)))
  .command('rm <id>', 'Delete a draft', (yy) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchRm(ctx, a.id)))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);

// ---------------------------------------------------------------- ledger
cli.command('ledger', 'Inspect the ledger', (y) => fail(y)
  .command('ls', 'List records', (yy) => yy.option('kind', { type: 'string', describe: 'anchor|attest|settle|challenge|branch|node|supersede|subscribe' }).option('limit', { type: 'number', default: 50 }),
    run((ctx, a: G & { kind?: string; limit: number }) => ledger.ledgerLs(ctx, a)))
  .command('verify', 'Verify hashes, signatures and chain linkage', (yy) => yy, run((ctx) => ledger.ledgerVerify(ctx)))
  .command('graph', 'ASCII lineage tree', (yy) => yy, run((ctx) => ledger.ledgerGraph(ctx)))
  .command('export <file>', 'Export records as JSON lines', (yy) => yy.positional('file', { type: 'string', demandOption: true }), run((ctx, a: G & { file: string }) => ledger.ledgerExport(ctx, a.file)))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);

// ---------------------------------------------------------------- branches / routing / wallet
cli.command('branch', 'Knowledge branches (parallel, possibly contradictory patch sets)', (y) => fail(y)
  .command('ls', 'List branches', (yy) => yy, run((ctx) => branch.branchLs(ctx)))
  .command('create <name>', 'Create a branch', (yy) => yy.positional('name', { type: 'string', demandOption: true })
    .option('description', { type: 'string' }).option('context', { type: 'string', array: true, describe: 'k=v routing attributes (e.g. jurisdiction=KR)' })
    .option('patch', { type: 'string', array: true, describe: 'patch id(s) in the branch' })
    .example('$0 branch create law/KR --context jurisdiction=KR --patch law-kr-2025', ''),
  run((ctx, a: G & { name: string; description?: string; context?: string[]; patch?: string[] }) => branch.branchCreate(ctx, a.name, a)))
  .command('add <name> <patchId>', 'Add a patch to a branch you own', (yy) => yy.positional('name', { type: 'string', demandOption: true }).positional('patchId', { type: 'string', demandOption: true }),
    run((ctx, a: G & { name: string; patchId: string }) => branch.branchAdd(ctx, a.name, a.patchId)))
  .command('subscribe <name>', 'Subscribe this node (acquire + apply the branch\'s patches)', (yy) => yy.positional('name', { type: 'string', demandOption: true }), run((ctx, a: G & { name: string }) => branch.branchSubscribe(ctx, a.name, 'subscribe')))
  .command('unsubscribe <name>', 'Unsubscribe (restore rows)', (yy) => yy.positional('name', { type: 'string', demandOption: true }), run((ctx, a: G & { name: string }) => branch.branchSubscribe(ctx, a.name, 'unsubscribe')))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);
cli.command('route <context..>', 'Gateway routing: which branch/nodes serve a request context', (y) => fail(y).positional('context', { type: 'string', array: true, demandOption: true, describe: 'k=v pairs' })
  .example('$0 route jurisdiction=KR', ''), run((ctx, a: G & { context: string[] }) => branch.route(ctx, a.context)));
cli.command('wallet', 'Balance, sales and royalties of this node', (y) => fail(y), run((ctx) => branch.wallet(ctx)));

// ---------------------------------------------------------------- drive
cli.command('drive', 'aindrive: files & change history of this node', (y) => fail(y)
  .command('status', 'Drive status (pairing, agent, files)', (yy) => yy.option('files', { type: 'boolean', default: false }), run((ctx, a: G & { files: boolean }) => drive.driveStatus(ctx, a)))
  .command('up', 'Start the aindrive agent for the node\'s drive folder', (yy) => yy, run((ctx) => drive.driveAction(ctx, 'up')))
  .command('stop', 'Stop the aindrive agent', (yy) => yy, run((ctx) => drive.driveAction(ctx, 'stop')))
  .command('sync', 'Rewrite the drive mirror from the current market state', (yy) => yy, run((ctx) => drive.driveAction(ctx, 'sync')))
  .command('login', 'One-time browser pairing of the drive folder (interactive)', (yy) => yy.option('server', { type: 'string', describe: `aindrive server (default ${drive.DEFAULT_AINDRIVE_SERVER})` })
    .option('name', { type: 'string', describe: 'drive name' }).option('no-open', { type: 'boolean', default: false }),
  run(async (ctx, a: G & { server?: string; name?: string; 'no-open': boolean }) => { const code = await drive.driveLogin(ctx, { server: a.server, name: a.name, noOpen: a['no-open'] }); process.exit(code); }, true))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);

// ---------------------------------------------------------------- chain
cli.command('chain', 'Local AIN blockchain (docker) for the ain ledger', (y) => fail(y)
  .command('up', 'Start (or attach to) a local 1-node AIN chain on :8081', (yy) => yy.option('wait', { type: 'number', default: 90, describe: 'seconds to wait for SERVING' }), run((ctx, a: G & { wait: number }) => chain.chainUp(ctx, a)))
  .command('down', 'Remove the local chain container', (yy) => yy, run((ctx) => chain.chainDown(ctx)))
  .command('status', 'Chain health and last block', (yy) => yy.option('provider', { type: 'string' }), run((ctx, a: G & { provider?: string }) => chain.chainStatus(ctx, a.provider)))
  .command('fund <address> [amount]', 'Transfer AIN from the local genesis account (local chain only)', (yy) => yy.positional('address', { type: 'string', demandOption: true }).positional('amount', { type: 'number', default: 1000 }).option('provider', { type: 'string' }),
    run((ctx, a: G & { address: string; amount: number; provider?: string }) => chain.chainFund(ctx, a.address, a.amount, a.provider)))
  .command('setup', 'Register the knowledge app + market rules on-chain (funds the node identity first on a local chain)', (yy) => yy.option('fund', { type: 'number', describe: 'AIN to fund the node identity with' }),
    run((ctx, a: G & { fund?: number }) => chain.chainSetup(ctx, a)))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);

fail(cli);
await cli.parseAsync();
