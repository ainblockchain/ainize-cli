#!/usr/bin/env node
/**
 * `ainize` (alias `ngram`) — operate an Ainize knowledge-marketplace node.
 *
 * Ainize = AI + -ize, "make it usable by AI". The 2019 `ainize` CLI ainized GitHub repos into running AI
 * services; this one ainizes *knowledge*: publish verified knowledge patches, test them live against the model
 * (`chat`), trade them with automatic payment and load them into a running model in seconds.
 */
import './quiet.js';
import yargs, { type Argv, type ArgumentsCamelCase } from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { CliError, PROG, buildContext, requireNodeTarget, type CliContext } from './context.js';
import { explainUsageError } from './help.js';
import { flushJson, jsonError, setWide } from './output.js';
import * as init from './commands/init.js';
import * as node from './commands/node.js';
import * as auth from './commands/auth.js';
import * as peers from './commands/peers.js';
import * as patch from './commands/patch.js';
import * as ledger from './commands/ledger.js';
import * as branch from './commands/branch.js';
import * as drive from './commands/drive.js';
import * as chain from './commands/chain.js';
import * as chat from './commands/chat.js';
import * as teach from './commands/teach.js';
import * as teachData from './commands/teach-dataset.js';
import * as dataset from './commands/dataset.js';
import { EVENT_KINDS, EVENT_LEVELS } from '@ngram/node';
import { RECORD_KINDS, type RecordKind } from '@ngram/core';

type G = { home?: string; node?: string; json?: boolean; quiet?: boolean; wide?: boolean };
// yargs' generic inference gets unwieldy with nested command groups; handlers receive the parsed args untyped
// and cast to the shape their builder guarantees.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Y = Argv<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = ArgumentsCamelCase<any>;
const ctxOf = (a: G): CliContext => buildContext({ home: a.home, node: a.node, json: a.json, quiet: a.quiet });

/** `teach status <target>`: a target that carries a host names its own node, so no config is needed for it. */
const namesItsOwnNode = (a: Raw): boolean => {
  try { return !!teach.parseTeachTarget(a.target as string | undefined, '').nodeUrl; } catch { return false; }
};

/**
 * `local` = the command never talks to a node (init, config, keys, chain, logout), so it runs without a config;
 * a predicate = the command names its own node in an argument (`teach status <node url>`). Everything else refuses
 * to guess a node when this home has no config (item 101).
 */
type NoConfig = boolean | ((a: Raw) => boolean);

/** Was `--json` asked for? Read from argv, because a parse failure never reaches a context (item 104). */
const jsonMode = (): boolean => { const v = hideBin(process.argv); return v.includes('--json') && !v.includes('--no-json'); };

/** `patch get` — the command a JSON error names, taken from what yargs matched rather than from a second list. */
const commandOf = (raw: Raw): string => (raw._ ?? []).map(String).join(' ') || null as unknown as string;

const run = <A extends G>(fn: (ctx: CliContext, a: A) => Promise<unknown> | unknown, keepAlive = false, noConfig: NoConfig = false) => async (raw: Raw) => {
  const a = raw as unknown as A;
  let ctx: CliContext | null = null;
  try {
    ctx = ctxOf(a);
    setWide(!!(a as G).wide);
    if (!(typeof noConfig === 'function' ? noConfig(raw) : noConfig)) requireNodeTarget(ctx);
    await fn(ctx, a);
    // a command whose only output was `ok()` still owes `--json` one document (item 104)
    flushJson(ctx);
    // a command that finished but found something wrong (e.g. `status` on a port a stranger answers) sets its own code
    if (!keepAlive && !process.exitCode) process.exitCode = 0;
  } catch (e) {
    const err = e as CliError;
    const code = err instanceof CliError ? err.exitCode : 1;
    // Item 104: under `--json` the failure is a document too — with the node's own error body, which `CliError`
    // has been carrying and nothing ever printed. A CI job reads the reason instead of matching `error:` prose.
    if (ctx?.json ?? !!a.json) jsonError(err, commandOf(raw), code);
    else process.stderr.write(chalk.red('error: ') + (err.message ?? String(e)) + '\n');
    process.exit(code);
  }
};

/**
 * Every failure of the command line itself (item 103). yargs' own strings — `Not enough non-option arguments: got 0,
 * need at least 1` for a bare `ainize publish`, `Unknown argument: statsu` for a typo — are rewritten from the help
 * of the command that failed: what is missing, in its own words, with its usage line and first worked example.
 */
const usageError = (msg: string | null, err: Error | undefined, yy: Y): never => {
  let help = '';
  // yargs renders the help of the level that failed synchronously into this callback; an older/odd path leaves it
  // empty, and the explanation degrades to yargs' own sentence rather than to nothing.
  try { yy.showHelp((s: string) => { help = s; }); } catch { /* the message below stands on its own */ }
  const e = explainUsageError(msg, err, help, hideBin(process.argv));
  if (jsonMode()) jsonError({ message: e.message, details: e.hints.length ? { help: e.hints } : undefined }, e.command, 1);
  else process.stderr.write(chalk.red('error: ') + e.message + '\n' + e.hints.map((h) => chalk.gray('  ' + h) + '\n').join(''));
  process.exit(1);
};

const fail = (y: Y): Y => y.fail((msg, err, yy) => usageError(msg, err, yy as Y));

const cli: Y = yargs(hideBin(process.argv))
  .scriptName(PROG)
  .usage([
    '$0 <command> [options]', '',
    'Ainize — ainize your knowledge (AI + -ize: make it usable by AI).',
    'Run an Ainize knowledge-marketplace node: publish knowledge patches, let independent nodes',
    'verify them, test them live (`$0 chat`), trade them with automatic payment (x402) and load',
    'them into a running model without restart.',
    ...(PROG === 'ainize' ? [] : ['(`ngram` is the historical name of this binary; `ainize` is the same program.)']),
  ].join('\n'))
  .option('home', { type: 'string', describe: 'node home directory (NGRAM_HOME)', global: true })
  .option('node', { type: 'string', describe: 'node API URL (default: http://localhost:<config port>)', global: true })
  .option('json', { type: 'boolean', describe: 'machine-readable JSON output — one document per command, errors included, on failure to stderr', global: true, default: false })
  .option('quiet', { type: 'boolean', describe: 'print nothing but the id of whatever was created or changed', global: true, default: false })
  .option('wide', { type: 'boolean', describe: 'do not fit tables to the terminal width (piped output is never fitted)', global: true, default: false })
  .alias('h', 'help').help('help').version()
  .showHelpOnFail(false, `Specify --help for available options.`)
  .strict()
  // a one-character typo answers with the command it meant instead of "Unknown argument" (item 103)
  .recommendCommands()
  .wrap(Math.min(110, process.stdout.columns || 100))
  .demandCommand(1, `Specify a command. Try \`${PROG} --help\`.`)
  // Item 104: the codes that make a failure legible to a script were documented nowhere at all.
  .epilogue([
    'Exit codes:',
    '  0    it worked',
    '  1    the command ran and failed (the node refused it, a file was missing)',
    '  2    no node to talk to: no config here, a bad --node, or nothing answering',
    '  3    not yours to ask: log in (`' + PROG + ' login`), or you may not read it',
    '  4    the node did not answer in time — it may be running the work anyway',
    '  5    in the way: the shared model lock, or an incomplete subscription',
    '  130  cancelled at a confirmation prompt',
    '  `' + PROG + ' teach train --wait` sets 4-8 from the lesson\'s own outcome.',
    '',
    'Docs: <node url>/docs   ·   one command: `' + PROG + ' <command> --help`',
  ].join('\n'));

// ---------------------------------------------------------------- init / config / keys
cli.command('init', 'Create a node identity and config in NGRAM_HOME', (y: Y) => fail(y)
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
  .option('host', { type: 'string', describe: 'interface to bind (default 127.0.0.1 — this machine only)' })
  .option('public', { type: 'boolean', default: false, describe: 'bind 0.0.0.0 (every interface) — only behind a firewall or proxy' })
  .option('password', { type: 'string', describe: 'operator password, set now so nobody else can claim this node (or NGRAM_PASSWORD)' })
  .option('no-password', { type: 'boolean', default: false, describe: `leave the node unclaimed; \`${PROG} login\` claims it later (loopback only)` })
  .option('force', { type: 'boolean', describe: 'rewrite an existing config.json (the node identity and operator password are kept; the old file is copied aside)', default: false })
  .option('new-identity', { type: 'boolean', describe: 'with --force: mint a NEW node key, orphaning everything the old one published (asks you to type the current address)', default: false })
  .example('$0 init --name alice --port 3402', 'local ledger node')
  .example('$0 init --name alice --password "…" --host 0.0.0.0', 'a node others can reach, claimed before it listens')
  .example('$0 init --ledger ain --ain-provider http://localhost:8081', `AIN blockchain ledger (see \`${PROG} chain up\`)`),
run((ctx, a: G & init.InitArgs & { 'ain-provider'?: string; 'ain-chain-id'?: number; 'runtime-repo'?: string; 'runtime-api'?: string; 'private-key'?: string; 'public-url'?: string; 'new-identity'?: boolean; 'no-password'?: boolean }) =>
  init.init(ctx, { ...a, ainProvider: a['ain-provider'], ainChainId: a['ain-chain-id'], runtimeRepo: a['runtime-repo'], runtimeApi: a['runtime-api'], privateKey: a['private-key'], publicUrl: a['public-url'], newIdentity: a['new-identity'], noPassword: a['no-password'] }), false, true));

cli.command('config', 'Show or edit the node config', (y: Y) => fail(y)
  .command('show', 'Print config.json (secrets hidden)', (yy: Y) => yy, run((ctx) => init.configShow(ctx), false, true))
  .command('get <key>', 'Print one config key (dotted path)', (yy: Y) => yy.positional('key', { type: 'string', demandOption: true })
    .example('$0 config get market.defaultPrice', ''),
  run((ctx, a: G & { key: string }) => init.configGet(ctx, a.key), false, true))
  .command('set <key> <value>', 'Set a config key (dotted path, e.g. market.defaultPrice 0.5)', (yy: Y) => yy
    .positional('key', { type: 'string', demandOption: true }).positional('value', { type: 'string', demandOption: true })
    .example('$0 config set ledger.kind ain', '').example('$0 config set peers http://a:3402,http://b:3403', ''),
  run((ctx, a: G & { key: string; value: string }) => init.configSet(ctx, a.key, a.value), false, true))
  .command('unset <key>', 'Remove a config key so the node uses its built-in default', (yy: Y) => yy.positional('key', { type: 'string', demandOption: true })
    .example('$0 config unset teach.trainer.gpus', ''),
  run((ctx, a: G & { key: string }) => init.configUnset(ctx, a.key), false, true))
  .demandCommand(1, 'Subcommand is required (show|get|set|unset).'), () => undefined);

cli.command('keys', 'Node identity: the key that owns everything this node published', (y: Y) => fail(y)
  .command('show', 'Print address and public key', (yy: Y) => yy
    .option('reveal', { type: 'boolean', default: false, describe: 'also print the private key (asks first)' })
    .option('yes', { type: 'boolean', default: false, describe: 'with --reveal: skip the confirmation' }),
  run((ctx, a: G & { reveal: boolean; yes: boolean }) => init.keysShow(ctx, a.reveal, a.yes), false, true))
  .command(['backup <file>', 'export <file>'], 'Save the node key to a file (encrypted with --passphrase) — the only way back after a wiped disk', (yy: Y) => yy
    .positional('file', { type: 'string', demandOption: true })
    .option('passphrase', { type: 'string', describe: 'encrypt with this passphrase (or NGRAM_KEY_PASSPHRASE); without one the key is stored in the clear' })
    .option('force', { type: 'boolean', default: false, describe: 'overwrite an existing file' })
    .example('$0 keys backup ~/node-key.json --passphrase "…"', ''),
  run((ctx, a: G & { file: string; passphrase?: string; force: boolean }) => init.keysBackup(ctx, a.file, a), false, true))
  .command('import <file>', 'Make a backed-up key this node\'s identity (asks you to type the current address)', (yy: Y) => yy
    .positional('file', { type: 'string', demandOption: true }).option('passphrase', { type: 'string', describe: 'or NGRAM_KEY_PASSPHRASE' }),
  run((ctx, a: G & { file: string; passphrase?: string }) => init.keysImport(ctx, a.file, a), false, true))
  .command('rotate', 'Mint a NEW node identity, keeping every other setting (asks you to type the current address)', (yy: Y) => yy,
    run((ctx) => init.keysRotate(ctx), false, true))
  .demandCommand(1, 'Subcommand is required (show|backup|import|rotate).'), () => undefined);

// ---------------------------------------------------------------- lifecycle
cli.command('start', 'Start the node (foreground unless --detach)', (y: Y) => fail(y)
  .option('port', { type: 'number', describe: 'HTTP port for this run (default: the port in config.json)' })
  .option('peer', { type: 'string', array: true, describe: 'extra peer URL(s)' })
  .option('roles', { type: 'string', describe: 'comma list of seller,verifier,serving,gateway for this run (default: the config value)' })
  .option('public-url', { type: 'string', describe: 'URL peers should reach this node at — an address on this machine is useless to them (default: the config value)' })
  .option('detach', { alias: 'd', type: 'boolean', default: false, describe: 'run in the background (pid in NGRAM_HOME/node.pid)' })
  .example('$0 start', '').example('$0 start -d --peer http://localhost:3402', 'second node joining the first'),
run(async (ctx, a: G & node.StartArgs & { 'public-url'?: string }) => {
  const r = await node.start(ctx, { ...a, publicUrl: a['public-url'] });
  if ('detached' in r) return r;
  // Only to a terminal: `start -d` spawns this same foreground path with stdout redirected into node.log, so this
  // line used to end every detached run's log with an instruction nobody can carry out there (item 131).
  if (process.stdout.isTTY) process.stdout.write(chalk.gray('press Ctrl+C to stop\n'));
  await new Promise(() => undefined);   // keep alive
}, true, true));
cli.command('stop', 'Stop a background node', (y: Y) => fail(y), run((ctx) => node.stop(ctx), false, true));
cli.command('status', 'Show node / ledger / runtime status', (y: Y) => fail(y)
  .option('check', { type: 'boolean', default: false, describe: 'readiness only (GET /readyz): exits 1 when a check fails' })
  .example('$0 status --check', 'for a monitor or a deploy script'),
run((ctx, a: G & { check: boolean }) => (a.check ? node.statusCheck(ctx) : node.status(ctx))));
cli.command('logs', 'Show node events', (y: Y) => fail(y)
  .option('follow', { alias: 'f', type: 'boolean', default: false, describe: 'keep printing events as they happen (Ctrl-C to stop)' })
  .option('patch', { type: 'string', describe: 'only events of a patch' })
  .option('kind', { choices: EVENT_KINDS, describe: 'only this kind of event' })
  .option('level', { choices: EVENT_LEVELS, describe: 'this level and worse (warn shows warn + error)' })
  .option('limit', { type: 'number', default: 100, describe: 'how many past events to print, newest last' })
  .example('$0 logs --level warn', 'everything that went wrong, newest last')
  .example('$0 logs --kind trade --limit 20', ''),
run((ctx, a: G & { follow: boolean; patch?: string; kind?: string; level?: string; limit: number }) => node.logs(ctx, a), true));
cli.command('seed', 'Seed demo data (prototype ledger, real Qwen3.8 patches if present, synthetic branches)', (y: Y) => fail(y)
  .option('real', { type: 'boolean', default: true, describe: 'register real patches from the runtime repo' })
  .option('synthetic', { type: 'boolean', default: false, describe: 'create synthetic law/KR vs law/US demo patches' })
  .option('prototype', { type: 'boolean', default: false, describe: 'import the reference prototype ledger' })
  .option('announce', { type: 'boolean', default: true, describe: 'announce the seeded knowledge on the ledger (--no-announce leaves drafts)' }),
run((ctx, a: G & { real: boolean; synthetic: boolean; prototype: boolean; announce: boolean }) => node.seed(ctx, a), false, true));
cli.command('nodes', 'List the peers this node talks to and the nodes it knows of', (y: Y) => fail(y)
  .option('all', { type: 'boolean', default: false, describe: 'include node records not seen for over an hour (they are permanent, so there are many)' })
  .option('limit', { type: 'number', describe: 'show at most this many node records' })
  .example('$0 nodes', 'peers first, then the nodes seen in the last hour')
  .example('$0 nodes --all', 'every node record this node has ever read'),
run((ctx, a: G & node.NodesArgs) => node.nodesTable(ctx, a)));
cli.command('blobs', 'Knowledge files this node holds on disk, and what they cost', (y: Y) => fail(y)
  .command(['ls', 'list'], 'List every knowledge file with its size and why it is held', (yy: Y) => yy, run((ctx) => node.blobsLs(ctx)))
  .demandCommand(1, 'Subcommand is required (ls).'), () => undefined);
cli.command('gc', 'Delete knowledge files this node neither published nor bought (verification copies)', (y: Y) => fail(y)
  .option('dry-run', { type: 'boolean', default: false, describe: 'list what would go and delete nothing' })
  .option('keep-purchased', { type: 'boolean', default: true, describe: 'keep bodies bought through the market (--no-keep-purchased includes them)' })
  .option('older-than', { type: 'string', describe: 'only files fetched longer ago than this (30d, 12h, 90m)' })
  .option('allow-sole-copy', { type: 'boolean', default: false, describe: 'also delete bodies no peer advertises (this node may be the last copy)' })
  .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'do not ask for confirmation' })
  .example('$0 gc --dry-run', 'what would be freed')
  .example('$0 gc --older-than 30d', 'verification copies older than a month'),
  run((ctx, a: G & { 'dry-run': boolean; 'keep-purchased': boolean; 'older-than'?: string; 'allow-sole-copy': boolean; yes: boolean }) =>
    node.gc(ctx, { dryRun: a['dry-run'], keepPurchased: a['keep-purchased'], olderThan: a['older-than'], allowSoleCopy: a['allow-sole-copy'], yes: a.yes })));

// ---------------------------------------------------------------- auth
cli.command('login', 'Log in as the node operator (sets the password on first use)', (y: Y) => fail(y)
  .option('password', { type: 'string', describe: 'the operator password, at least 4 characters — or NGRAM_PASSWORD. Without either you are asked; a script with no terminal can also pipe it in' })
  .option('setup-token', { type: 'string', describe: 'claim a node over the network with the one-time token in its NGRAM_HOME/setup-token (or NGRAM_SETUP_TOKEN)' })
  .example('$0 login', 'asks for the password (it is not echoed)')
  .example('NGRAM_PASSWORD="…" $0 login', 'in a script, a cron line or over ssh — as does --password, and so does piping it in')
  .example('$0 login --setup-token "$(ssh host cat ~/.ngram/setup-token)"', 'claim a node that has no password yet, from another machine'),
  run((ctx, a: G & { password?: string; 'setup-token'?: string }) => auth.login(ctx, { password: a.password, setupToken: a['setup-token'] })));
cli.command('password', 'Change the operator password (--reset rewrites it in config.json when you have forgotten it)', (y: Y) => fail(y)
  .option('password', { type: 'string', describe: 'the new password, at least 4 characters (or NGRAM_NEW_PASSWORD)' })
  .option('current', { type: 'string', describe: 'the current password (or NGRAM_PASSWORD)' })
  .option('reset', { type: 'boolean', default: false, describe: 'forgotten password: write a new hash into config.json (the node must be stopped)' })
  .example('$0 password', 'change it on the running node')
  .example('$0 stop && $0 password --reset', 'the way back when it is forgotten'),
  run((ctx, a: G & { password?: string; current?: string; reset: boolean }) => auth.password(ctx, a), false, true));
cli.command('logout', 'Forget the operator session', (y: Y) => fail(y), run((ctx) => auth.logout(ctx), false, true));

// ---------------------------------------------------------------- peers
cli.command('peers', 'Manage peers', (y: Y) => fail(y)
  .command('ls', 'List peers', (yy: Y) => yy, run((ctx) => peers.peersLs(ctx)))
  .command('add <url>', 'Add a peer', (yy: Y) => yy.positional('url', { type: 'string', demandOption: true }), run((ctx, a: G & { url: string }) => peers.peersAdd(ctx, a.url)))
  .command('rm <url>', 'Remove a peer', (yy: Y) => yy.positional('url', { type: 'string', demandOption: true }), run((ctx, a: G & { url: string }) => peers.peersRm(ctx, a.url)))
  .demandCommand(1, 'Subcommand is required (ls|add|rm).'), () => undefined);

/**
 * `ainize publish <file>` and `ainize patch publish <file>` are ONE operation with two names (item 112). They used
 * to be two near-identical builders with opposite `--announce` defaults and different flags on each, so which of
 * the two you happened to type decided whether your knowledge landed on the permanent ledger — and neither help
 * mentioned the other. One option list now, declared here; the two commands differ in exactly one thing, the
 * default of `--announce`, which each of them declares and states in its own words.
 */
const publishOpts = (y: Y): Y => y
  .option('name', { type: 'string', demandOption: true, describe: 'what buyers see in the catalogue' })
  .option('model', { type: 'string', demandOption: true, describe: 'target model id_M (e.g. Qwen3.8-Flash-Next)' })
  .option('benchmark', { type: 'string', demandOption: true, describe: 'bench.json path or inline JSON {schema, queries, format, samples:[{prompt,expect}]}' })
  .option('id', { type: 'string', describe: 'catalog id — permanent (default: a slug of --name)' })
  .option('price', { type: 'string', describe: `price per download in this node's currency, AIN or node credit (default: \`${PROG} config get market.defaultPrice\`); editable while it is a draft, fixed for good at announce` })
  .option('description', { type: 'string', describe: 'one or two sentences about what it knows' })
  .option('parents', { type: 'string', describe: `comma list of the knowledge ids this was built on — their creators are paid the lineage share (\`${PROG} config get market.royaltyShare\`) out of every sale of this one` })
  .option('branch', { type: 'string', describe: `knowledge track to publish it on (see \`${PROG} branch ls\`)` })
  .option('topic', { type: 'string', describe: 'ain-js knowledge topic path (e.g. finance/krx); default: patches/<model>' })
  .option('license', { type: 'string', describe: 'licence written onto the public record: an SPDX id (CC-BY-4.0, MIT, Proprietary) or free text. Omitted: no licence on the record' })
  .option('billing', { choices: ['per_download', 'per_apply_hour', 'per_hit'] as const, describe: 'how buyers are charged (default: per_download)' })
  .option('contributor', { type: 'string', array: true, describe: 'data provider credited and paid on the record: addr:name:share — share = fraction of YOUR share of each sale (repeatable, ≤ 4, Σ ≤ 1)' })
  .option('dataset', { type: 'string', describe: 'the training set behind this knowledge (.jsonl/.csv on the node machine) — pinned and served under --dataset-access' })
  .option('dataset-access', { choices: ['public', 'derivative', 'private'] as const, describe: 'who may read those questions: anyone / people building on this knowledge (default) / nobody' })
  .option('dataset-license', { type: 'string', describe: 'licence for the questions: CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, ODC-By-1.0, Proprietary' })
  .option('supersede', { type: 'string', array: true, describe: 'with --announce: the listing(s) of yours this publish may retire (required when it would retire any)' })
  .option('force', { type: 'boolean', default: false, describe: 'publish bytes this node already published on this subject, or for a model it cannot test (never another author\'s bytes)' })
  .option('test', { type: 'boolean', default: false, describe: 'hidden test listing (not shown in public catalogs)' });

/** The one handler behind both names. `--announce` is the only thing the two commands decide differently. */
const publishRun = run((ctx, a: G & patch.PublishArgs & { 'dataset-access'?: 'public' | 'derivative' | 'private'; 'dataset-license'?: string }) =>
  patch.patchPublish(ctx, { ...a, datasetAccess: a['dataset-access'], datasetLicense: a['dataset-license'], announce: !!a.announce }));

// ---------------------------------------------------------------- patches
cli.command('patch', 'Publish, inspect, verify, buy and apply knowledge patches', (y: Y) => fail(y)
  .command('ls', 'List patches in the catalog', (yy: Y) => yy
    .option('status', { type: 'string', describe: 'comma list: DRAFT,ANNOUNCED,VERIFYING,LISTED,REJECTED,CHALLENGED,SUPERSEDED,RETIRED (retired knowledge is hidden unless you ask for it)' })
    .option('model', { type: 'string', describe: 'only knowledge for this model id_M (e.g. Qwen3.8-Flash-Next)' })
    .option('schema', { type: 'string', describe: 'benchmark schema' })
    .option('branch', { type: 'string', describe: `only knowledge on this track (see \`${PROG} branch ls\`)` })
    .option('author', { type: 'string', describe: 'only knowledge published by this node address' })
    .option('q', { type: 'string', describe: 'text search' })
    .option('sort', { choices: ['latest', 'popular', 'price', 'rows'] as const, default: 'latest', describe: 'newest first, most sold, cheapest, or biggest' })
    .option('limit', { type: 'number', default: 100, describe: 'how many rows' }).option('mine', { type: 'boolean', default: false, describe: 'only my patches (needs login)' })
    .option('drafts', { type: 'boolean', default: false, describe: 'include my drafts (needs login)' }),
  run((ctx, a: G & patch.LsArgs) => patch.patchLs(ctx, a)))
  .command('get <id>', 'Show a patch in detail', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchGet(ctx, a.id)))
  .command('publish <file>', `Register a .npz patch body as a draft — it stays a DRAFT until --announce (\`${PROG} publish\` is the same operation, announcing at once)`, (yy: Y) => publishOpts(yy)
    .positional('file', { type: 'string', demandOption: true, describe: 'path to the learned knowledge (.npz: addrs/before/after) on the node machine' })
    .option('announce', { type: 'boolean', default: false, describe: `announce to the network immediately — the permanent record, and the one step with no undo (default here: no. \`${PROG} publish\` announces by default)` })
    .example('$0 patch publish ./rows.npz --name "KRX tickers" --model Qwen3.8-Flash-Next --benchmark bench.json --price 25', 'a draft nobody can see yet')
    .example('$0 patch publish ./rows.npz --name "KRX tickers" --model Qwen3.8-Flash-Next --benchmark bench.json --price 25 --announce', 'draft and announce in one line — the same thing `$0 publish` does'),
  publishRun)
  .command('import <file>', 'Import a downloaded lesson (.npz + recipe.json) as a PRIVATE draft: no announce, no ledger record', (yy: Y) => yy
    .positional('file', { type: 'string', demandOption: true, describe: 'lesson-<slug>.npz on the node machine (stays in place)' })
    .option('recipe', { type: 'string', demandOption: true, describe: 'recipe.json downloaded with the lesson (benchmark, model, facts)' })
    .option('id', { type: 'string', describe: 'draft id (default: the lesson\'s draft id, taught-<slug>)' })
    .option('name', { type: 'string', describe: 'name for the draft (default: the lesson\'s own name)' })
    .option('model', { type: 'string', describe: 'target model id_M when the recipe names none' })
    .option('price', { type: 'string', describe: `price if you later publish it (default: this node's market.defaultPrice)` })
    .option('license', { type: 'string', describe: 'licence for the draft: an SPDX id or free text' })
    .option('description', { type: 'string', describe: 'one or two sentences about what it knows' })
    .option('drop-lineage', { type: 'boolean', default: false, describe: 'import as a ROOT even though the lesson names a base this node does not have — no credit and no royalty to the base creator' })
    .example('$0 patch import ./lesson-pixelplus-1a2b3c.npz --recipe ./recipe.json', `then: ${PROG} patch apply taught-pixelplus-1a2b3c`),
  run((ctx, a: G & patch.ImportArgs) => patch.patchImport(ctx, a)))
  .command('announce <id>', 'DRAFT → ANNOUNCED (anchor on the ledger)', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true })
    .option('supersede', { type: 'string', array: true, describe: 'the listing(s) of yours this announce may retire — it refuses until every one of them is named' })
    .example('$0 patch announce krx-codes-v3 --supersede krx-codes-v2', 'v2 goes off sale the moment v3 is verified'),
  run((ctx, a: G & { id: string; supersede?: string[] }) => patch.patchAnnounce(ctx, a.id, { supersede: a.supersede })))
  .command('retire <id>', 'Take your published knowledge off sale for good (the record stays; buyers keep their copy)', (yy: Y) => yy
    .positional('id', { type: 'string', demandOption: true })
    .option('reason', { type: 'string', describe: 'why, in one line — shown to anyone who asks for it afterwards' })
    .example('$0 patch retire krx-codes-2026-08 --reason "the source feed changed; use krx-codes-2026-09"', ''),
  run((ctx, a: G & { id: string; reason?: string }) => patch.patchRetire(ctx, a.id, { reason: a.reason })))
  .command('verify <id>', 'Run this node\'s verifier on a patch and publish an attestation', (yy: Y) => yy
    .positional('id', { type: 'string', demandOption: true })
    // Item 339 — a verifier with a doubt had two options: stay silent, or challenge, which takes the seller off
    // sale. Most operators stay silent, which is the opposite of what the trust story needs.
    .option('recheck', { type: 'boolean', describe: 'measure it again and record the result WITHOUT taking it off sale — a failing recheck withdraws this node\'s earlier PASS, a passing one confirms it' })
    .example('$0 patch verify krx-codes-2026-08 --recheck', 'you doubt a result you signed: re-measure it and put that on the record, instead of challenging the seller'),
  run((ctx, a: G & { id: string; recheck?: boolean }) => patch.patchVerify(ctx, a.id, { recheck: a.recheck })))
  .command('challenge <id>', 'Dispute a verification: takes the knowledge off sale until a verifier re-runs it', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true })
    .option('reason', { type: 'string', demandOption: true, describe: 'why, in one line — it goes on the public record next to your address' }),
    run((ctx, a: G & { id: string; reason: string }) => patch.patchChallenge(ctx, a.id, a.reason)))
  .command('buy <ids..>', 'Buy listed knowledge via HTTP 402 (x402) and download the body — several ids buy them in the order given', (yy: Y) => yy
    .positional('ids', { type: 'string', array: true, demandOption: true, describe: 'knowledge id(s) — `a b` or `a,b`, bought in the order given' })
    .option('apply', { type: 'boolean', default: false, describe: 'apply to the serving runtime after download' })
    // Item 102: the price is quoted and confirmed before anything is spent. `--yes` answers in advance; a
    // non-terminal without it is refused, never taken as a yes. `--max-price` is the FAMILY total (item 270).
    .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'skip the confirmation (answer yes in advance)' })
    .option('max-price', { type: 'number', describe: 'refuse if the total for one knowledge (it + the bases it needs) is above this' })
    .option('bundle', { type: 'boolean', default: false, describe: 'buy the bases this knowledge needs underneath it too, deepest first (one payment each). Without it you are asked' })
    .option('with-base', { type: 'boolean', default: false, describe: 'the older name of --bundle', hidden: true })
    // Item 271: without this, a knowledge this node has already paid for is collected, not bought a second time.
    .option('again', { type: 'boolean', default: false, describe: 'pay again for something this node already bought (per-hit / per-apply-hour billing)' })
    // Item 236: a superseded version is bought on purpose or not at all — a script must not stack last month's build in silence.
    .option('allow-superseded', { type: 'boolean', default: false, describe: 'buy a version that has been superseded by a newer one on the same subject (otherwise you are asked)' })
    .example('$0 patch buy krx-all-2761', 'quote the price, ask, then pay')
    .example('$0 patch buy krx-all-2761 pixelplus-087600', 'two knowledges, one quote and one confirmation each')
    .example('$0 patch buy krx-all-2761 --bundle', 'the add-on and the knowledge it needs underneath, in one go')
    .example('$0 patch buy krx-all-2761 --yes --max-price 30', 'unattended, with a budget for the whole family'),
  run((ctx, a: G & { ids: string[]; apply: boolean; yes: boolean; again: boolean; 'max-price'?: number; bundle?: boolean; 'with-base'?: boolean; 'allow-superseded'?: boolean }) => {
    const ids = patch.parseIds(a.ids);
    return patch.overIds(ctx, ids, 'bought', (id, batched) =>
      patch.patchBuy(ctx, id, { apply: a.apply, yes: a.yes, again: a.again, maxPrice: a['max-price'], withRequired: a.bundle || a['with-base'], allowSuperseded: a['allow-superseded'], batched }));
  }))
  // Item 278: an anchor is immutable, and before this the only way to re-price a listing was to publish a new one
  // that superseded it — restarting verification and splitting the sales history to run a discount.
  .command('price <id> <price>', 'Change what a published knowledge sells for (0 makes it free)', (yy: Y) => yy
    .positional('id', { type: 'string', demandOption: true, describe: 'the knowledge to re-price (you must be its author)' })
    .positional('price', { type: 'string', demandOption: true, describe: `the new price in this node's currency, e.g. 2.5 — "0" makes it free` })
    .option('reason', { type: 'string', describe: 'why, in your words — shown to buyers on the price history' })
    .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'skip the confirmation' })
    .example('$0 patch price krx-all-2761 1.5 --reason "launch price"', 'a discount, on the public record')
    .example('$0 patch price krx-all-2761 0', 'make an obsolete knowledge free'),
    run((ctx, a: G & { id: string; price: string; reason?: string; yes: boolean }) => patch.patchPrice(ctx, a.id, a.price, { reason: a.reason, yes: a.yes })))
  .command('download <id>', 'Collect a knowledge this node already paid for — no second payment', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true })
    .example('$0 patch download krx-all-2761', 'after a lost manifest, a forgotten body or a purchase that died mid-payment'),
  run((ctx, a: G & { id: string }) => patch.patchDownload(ctx, a.id)))
  .command('apply <ids..>', 'Load held knowledge into the serving model (no restart) — several ids load in the order given, the last winning on any entry they share',
    (yy: Y) => yy.positional('ids', { type: 'string', array: true, demandOption: true, describe: 'knowledge id(s) — `a b` or `a,b`, loaded in the order given' })
      .option('with-base', { type: 'boolean', default: false, describe: 'also load everything this knowledge was trained on top of, underneath it' })
      .example('$0 patch apply krx-all-2761 pixelplus-087600', 'the set, in that order'),
    run((ctx, a: G & { ids: string[]; withBase?: boolean }) => patch.overIds(ctx, patch.parseIds(a.ids), 'loaded',
      (id, batched) => patch.patchApply(ctx, id, { withBase: a.withBase, batched }))))
  .command('remove <ids..>', 'Unload knowledge from the serving model, putting back whatever was underneath',
    (yy: Y) => yy.positional('ids', { type: 'string', array: true, demandOption: true, describe: 'knowledge id(s) — `a b` or `a,b`' })
      .option('cascade', { type: 'boolean', default: false, describe: 'also unload everything that is loaded on top of it' }),
    run((ctx, a: G & { ids: string[]; cascade?: boolean }) => patch.overIds(ctx, patch.parseIds(a.ids), 'unloaded',
      (id, batched) => patch.patchRemove(ctx, id, { cascade: a.cascade, batched }))))
  .command('stack', 'What is loaded in the serving model, bottom first', (yy: Y) => yy, run((ctx) => patch.patchStack(ctx)))
  .command('fork <id>', 'Copy this knowledge\'s questions into your own training set, and continue from there', (yy: Y) => yy
    .positional('id', { type: 'string', demandOption: true })
    .option('name', { type: 'string', describe: 'name for your copy' })
    .option('key-file', { type: 'string', describe: 'teaching key file (default: <home>/teaching-key.json)' })
    .option('key', { type: 'string', describe: 'teaching key as hex / json (or NGRAM_TEACH_KEY)' })
    .example('$0 patch fork krx-all-2761 --name "KRX + biotech"', 'start from its questions')
    .example('$0 teach train <dataset> --on krx-all-2761', 'then teach your additions on top of it'),
  run((ctx, a: G & { id: string; name?: string; key?: string; 'key-file'?: string }) => teachData.patchFork(ctx, a.id, { name: a.name, key: a.key, keyFile: a['key-file'] })))
  .command('merge <a> <b>', 'Combine two knowledges into one: what overlaps, what they answer differently, and how to build it', (yy: Y) => yy
    .positional('a', { type: 'string', demandOption: true, describe: 'the first knowledge' })
    .positional('b', { type: 'string', demandOption: true, describe: 'the second one — where they disagree, this one is the alternative answer' })
    .option('preview', { type: 'boolean', default: false, describe: 'only measure: questions, rows and which builds are possible' })
    .option('resolve', { type: 'string', describe: 'JSON file of {"<question key>": "a" | "b" | "drop" | {"answer": "…"}}' })
    .option('tier', { type: 'string', choices: ['union', 'retrain', 'rebuild'], describe: 'union = just combine (no training) · retrain = teach the disagreeing questions on top of both · rebuild = train everything from the combined questions' })
    .option('name', { type: 'string', describe: 'name for the combined knowledge' })
    .option('wait', { type: 'boolean', default: false, describe: 'wait for the build and exit with its status' })
    .option('key-file', { type: 'string', describe: 'teaching key file (default: <home>/teaching-key.json)' })
    .option('key', { type: 'string', describe: 'teaching key as hex / json (or NGRAM_TEACH_KEY)' })
    .example('$0 patch merge krx-all-2761 pixelplus --preview', 'what combining them would mean')
    .example('$0 patch merge krx-all-2761 pixelplus --resolve answers.json --tier retrain', 'after choosing an answer for each disagreement (unresolved ones print as JSON, exit 3)'),
  run((ctx, a: G & { a: string; b: string; preview?: boolean; resolve?: string; tier?: string; name?: string; wait?: boolean; key?: string; 'key-file'?: string }) =>
    teachData.patchMerge(ctx, a.a, a.b, { preview: a.preview, resolve: a.resolve, tier: a.tier, name: a.name, wait: a.wait, key: a.key, keyFile: a['key-file'] })))
  .command('tree <id>', 'The family tree: what this was built on, what was built on it, and what each one added', (yy: Y) => yy
    .positional('id', { type: 'string', demandOption: true })
    .option('depth', { type: 'number', default: 4, describe: 'how many hops in each direction (max 8)' })
    .option('dir', { type: 'string', choices: ['up', 'down', 'both'], default: 'both', describe: 'ancestors, descendants, or both' })
    .example('$0 patch tree krx-all-2761 --depth 6', 'the whole line, with what each knowledge added'),
  run((ctx, a: G & { id: string; depth?: number; dir?: 'up' | 'down' | 'both' }) => patch.patchTree(ctx, a.id, { depth: a.depth, dir: a.dir })))
  .command('missing <id>', 'Open questions: what people asked this knowledge that it could not answer', (yy: Y) => yy
    .positional('id', { type: 'string', demandOption: true })
    .option('kind', { type: 'string', choices: ['own_miss', 'preflight', 'free_wrong', 'request', 'gap'], describe: 'only one source' })
    .option('all', { type: 'boolean', default: false, describe: 'include the ones a later knowledge already answered' })
    .option('limit', { type: 'number', default: 50, describe: 'how many questions to print' })
    .example('$0 patch missing krx-all-2761', 'what to add on top of it'),
  run((ctx, a: G & { id: string; kind?: string; all?: boolean; limit?: number }) => patch.patchMissing(ctx, a.id, { kind: a.kind, all: a.all, limit: a.limit })))
  .command('signals <id>', 'How a knowledge is doing: network facts, and this node\'s last 30 days', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }),
    run((ctx, a: G & { id: string }) => patch.patchSignals(ctx, a.id)))
  .command('conflicts <id>', 'Address-set overlaps with other patches', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchConflicts(ctx, a.id)))
  .command('records <id>', 'Ledger records about a patch', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchRecords(ctx, a.id)))
  .command('rm <id>', 'Delete a draft (says what goes, and asks first)', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true, describe: 'draft id (`$0 patch ls --drafts`)' })
    .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'answer the confirmation in advance (a script has no terminal to be asked in)' }),
  run((ctx, a: G & { id: string; yes: boolean }) => patch.patchRm(ctx, a.id, { yes: a.yes })))
  .command('forget <id>', 'Delete this node\'s copy of the knowledge file. NOT a takedown: it stays listed and the gateway keeps charging — use `patch retire` for that', (yy: Y) => yy
    .positional('id', { type: 'string', demandOption: true })
    .option('all-sharing', { type: 'boolean', default: false, describe: 'also stop serving every other knowledge built from the same file (the command lists them first)' }),
  run((ctx, a: G & { id: string; 'all-sharing': boolean }) => patch.patchForget(ctx, a.id, { allSharing: a['all-sharing'] })))
  .demandCommand(1, 'Subcommand is required (ls|get|publish|import|announce|retire|verify|challenge|buy|download|apply|remove|stack|fork|merge|tree|missing|signals|conflicts|records|rm|forget).'), () => undefined);

// ---------------------------------------------------------------- one-liners (publish / use)
cli.command('publish <file>', `One line to sell knowledge: register a .npz + benchmark and announce it at once — the network verifies, you get paid per sale (\`${PROG} patch publish\` is the same operation, stopping at a draft)`, (y: Y) => publishOpts(fail(y))
  .positional('file', { type: 'string', demandOption: true, describe: 'path to the learned knowledge (.npz: addrs/before/after)' })
  .option('announce', { type: 'boolean', default: true, describe: `announce immediately — the permanent record, and the one step with no undo (--no-announce keeps a draft, which is what \`${PROG} patch publish\` does by default)` })
  .example('$0 publish ./my-knowledge.npz --name "KRX ticker codes" --model Qwen3.8-Flash-Next --benchmark ./bench.json --price 25', '')
  .example('$0 publish ./lesson.npz --name "…" --model … --benchmark ./bench.json --contributor 0xAbC…:Alice:0.7', 'Alice (data provider) gets 70 % of your share of every sale'),
publishRun);

// ---------------------------------------------------------------- teach (visitor-taught lessons)
/**
 * The teaching key every teach request is signed with. There is no account: the key IS the identity. Without one of
 * these the CLI keeps its own at `<NGRAM_HOME>/teaching-key.json` and creates it on first use.
 */
const keyOpts = (y: Y): Y => y
  .option('key', { type: 'string', describe: 'teaching key (64-hex) — or NGRAM_TEACH_KEY' })
  .option('key-file', { type: 'string', describe: 'the key backup JSON from the browser (ainize-teaching-key-….json); default: <home>/teaching-key.json, created on first use' });

cli.command('teach', 'Teach mode: turn your own questions and answers into knowledge. Two doors, one pipeline — a dataset file here, or corrections collected in the browser (<node>/chat?teach=1)', (y: Y) => fail(y)
  .command('status [target]', 'Teaching policy of a node, the status of a lesson, or a data provider\'s lessons and earnings', (yy: Y) => yy
    .positional('target', { type: 'string', describe: 'node URL · lesson URL (…/chat?lesson=<id>) or job id · teacher page (…/teacher/<address>) or 0x address; default: this node' })
    .option('key', { type: 'string', describe: 'teaching key (64-hex) — or NGRAM_TEACH_KEY; shows the full lesson body for your own lessons' })
    .option('key-file', { type: 'string', describe: 'the key backup JSON downloaded from the browser (ainize-teaching-key-….json)' })
    .example('$0 teach status http://localhost:3402', 'is this node accepting lessons? publish mode, trainer, queue')
    .example('$0 teach status "http://localhost:3402/chat?lesson=8f0c…" --key-file ainize-teaching-key-1a2b3c4d.json', 'your lesson: progress, checks, before/after')
    .example('$0 teach status http://localhost:3402/teacher/0xAbC…', 'a data provider\'s lessons and earnings'),
  run((ctx, a: G & { target?: string; key?: string; 'key-file'?: string }) => teach.teachStatus(ctx, a.target, { key: a.key, keyFile: a['key-file'] }),
    false, namesItsOwnNode))

  // ---- teach mode v2: the file door. One pipeline (dataset → validate → train → check → lesson), two entry points.
  .command('dataset', 'The questions a lesson is trained from: upload a file, list, inspect, download, delete', (yy: Y) => yy
    .command(['upload <file>', '$0 <file>'], 'Validate a dataset file and upload it (nothing is trained until you say so)', (z: Y) => keyOpts(z)
      .positional('file', { type: 'string', demandOption: true, describe: '.jsonl · .json · .csv · .tsv · .txt with one question and its answer per row' })
      .option('name', { type: 'string', describe: 'name for the dataset (default: the file name)' })
      .option('format', { choices: ['jsonl', 'json', 'csv', 'tsv', 'txt'] as const, describe: 'override the detected format' })
      .option('delimiter', { type: 'string', describe: 'csv/tsv separator when it is not detected (e.g. ";" or "\\t")' })
      .option('header', { type: 'boolean', describe: '--no-header when the first row is already a question' })
      .option('columns', { type: 'string', describe: 'JSON mapping when the column names are unusual: \'{"prompt":0,"answer":2}\'' })
      .option('encoding', { type: 'string', describe: 'force an encoding (utf-8, euc-kr, …) when the preview looks like mojibake' })
      .option('retention', { choices: ['keep', 'delete_after_training'] as const, describe: 'delete_after_training removes the questions from this node as soon as the lesson finishes' })
      .option('train', { type: 'boolean', default: false, describe: 'queue a lesson from it right away' })
      .option('effort', { choices: ['quick', 'balanced', 'thorough'] as const, describe: 'with --train: how hard to train' })
      .option('check', { type: 'boolean', describe: 'with --train: --no-check skips the side-effect check (publishing then stays blocked)' })
      .option('rows', { type: 'number', describe: 'with --train: train only the first N questions' })
      .option('wait', { type: 'boolean', default: false, describe: 'with --train: follow the lesson until it is ready and exit with its outcome (0 ready · 4 did not stick · 5 failed · 6 declined · 7 timed out · 8 never measured) — the same wait as `teach train --wait`' })
      .option('timeout', { type: 'number', describe: 'with --wait: give up after this many minutes and exit 7 (default 60)' })
      .example('$0 teach dataset ./questions.csv', 'validate + upload, print every line that will not train')
      .example('$0 teach dataset ./qa.jsonl --train --effort thorough', 'upload and teach it in one line')
      .example('$0 teach dataset ./data.csv --columns \'{"prompt":"질문","answer":"답"}\'', 'unusual column names')
      .example('$0 teach dataset ./today.csv --train --wait && $0 teach publish <id> …', 'a nightly bake that only publishes when the lesson stuck'),
    run((ctx, a: G & { file: string; key?: string; 'key-file'?: string; name?: string; format?: string; delimiter?: string; header?: boolean; columns?: string; encoding?: string; retention?: 'keep' | 'delete_after_training'; train: boolean; effort?: teachData.TrainOpts['effort']; check?: boolean; rows?: number; wait: boolean; timeout?: number }) =>
      teachData.datasetUpload(ctx, a.file, { key: a.key, keyFile: a['key-file'], name: a.name, format: a.format, delimiter: a.delimiter, header: a.header, columns: a.columns, encoding: a.encoding, retention: a.retention, train: a.train, effort: a.effort, check: a.check, rows: a.rows, wait: a.wait, timeout: a.timeout })))
    .command('ls', 'My datasets on this node', (z: Y) => keyOpts(z),
      run((ctx, a: G & { key?: string; 'key-file'?: string }) => teachData.datasetLs(ctx, { key: a.key, keyFile: a['key-file'] })))
    .command(['get <id>', 'download <id>'], 'One dataset: every source line with the reason it was or was not used; -o writes the questions to a file', (z: Y) => keyOpts(z)
      .positional('id', { type: 'string', demandOption: true })
      .option('out', { alias: 'o', type: 'string', describe: 'write the questions to this file (re-uploading it lands on the same dataset)' })
      .option('format', { choices: ['jsonl', 'csv'] as const, default: 'jsonl', describe: 'download format (the .jsonl bytes are the fingerprint subject)' })
      .option('rows', { type: 'number', describe: 'how many source lines to print (default 50, max 200)' })
      .option('offset', { type: 'number', describe: 'start at this source line' })
      .option('status', { type: 'string', describe: 'only lines with this status: ok|rejected|duplicate|conflict|too_long|empty|blocked|not_parsed|over_cap' })
      .option('all', { type: 'boolean', default: false, describe: 'print every line, not only the ones that will not train' })
      .example('$0 teach dataset get 6f2c… -o questions.jsonl', 'exactly what a lesson was trained on'),
    run((ctx, a: G & { id: string; key?: string; 'key-file'?: string; out?: string; format: 'jsonl' | 'csv'; rows?: number; offset?: number; status?: string; all: boolean }) =>
      teachData.datasetGet(ctx, a.id, { key: a.key, keyFile: a['key-file'], out: a.out, format: a.format, rows: a.rows, offset: a.offset, status: a.status, all: a.all })))
    .command('rm <id>', 'Delete a dataset (the lessons trained from it are kept)', (z: Y) => keyOpts(z).positional('id', { type: 'string', demandOption: true }),
      run((ctx, a: G & { id: string; key?: string; 'key-file'?: string }) => teachData.datasetRm(ctx, a.id, { key: a.key, keyFile: a['key-file'] })))
    .demandCommand(1, 'Give a dataset file, or a subcommand (ls|get|rm).'), () => undefined)

  .command('train <target>', 'Teach a lesson from a dataset id or a dataset file', (yy: Y) => keyOpts(yy)
    .positional('target', { type: 'string', demandOption: true, describe: `dataset id (\`${PROG} teach dataset ls\`) or a dataset file, which is uploaded first` })
    .option('effort', { choices: ['quick', 'balanced', 'thorough'] as const, describe: `how hard to train (see \`${PROG} teach status <node>\`)` })
    .option('check', { type: 'boolean', describe: '--no-check skips the side-effect check on the live model (publishing then stays blocked until a recheck)' })
    .option('alt', { type: 'boolean', describe: '--no-alt trains only the wording in the file, not the second phrasing' })
    .option('rows', { type: 'number', describe: 'train only the first N questions of the dataset' })
    .option('name', { type: 'string', describe: 'name for the lesson (and for the dataset, when a file is uploaded here)' })
    .option('patch', { type: 'string', describe: 'knowledge id(s) loaded while teaching, comma-separated — for comparison only' })
    .option('on', { type: 'string', describe: 'the knowledge this lesson is trained ON TOP OF: its questions are kept as known answers, it is recorded as the base, and buyers need it too' })
    .option('inherit', { type: 'boolean', describe: '--no-inherit checks against the base without keeping its questions as known answers' })
    .option('yes-change', { type: 'boolean', default: false, describe: 'my answers are meant to replace the base\'s where they differ' })
    .option('wait', { type: 'boolean', default: false, describe: 'follow it until it is ready (prints each stage). Exit code says what happened: 0 ready · 4 did not stick (NEEDS_MORE) · 5 failed/cancelled/expired · 6 declined by the operator · 7 still running when the wait ran out · 8 ready but never measured on the live model' })
    .option('timeout', { type: 'number', describe: 'with --wait: give up after this many minutes and exit 7 (default 60)' })
    .example('$0 teach train 6f2c1b2a-…', 'train an uploaded dataset')
    .example('$0 teach train ./questions.csv --effort quick --wait', 'file → lesson in one line')
    .example('$0 teach train 6f2c1b2a-… --on krx-all-2761', 'teach it on top of someone else\'s knowledge')
    .example('$0 teach train 6f2c1b2a-… --effort thorough', 'the same questions again, harder'),
  run((ctx, a: G & { target: string; key?: string; 'key-file'?: string; effort?: teachData.TrainOpts['effort']; check?: boolean; alt?: boolean; rows?: number; name?: string; patch?: string; on?: string; inherit?: boolean; 'yes-change': boolean; wait: boolean; timeout?: number }) =>
    teachData.teachTrain(ctx, a.target, { key: a.key, keyFile: a['key-file'], effort: a.effort, check: a.check, alt: a.alt, rows: a.rows, name: a.name, patch: a.patch, on: a.on, inherit: a.inherit, yesChange: a['yes-change'], wait: a.wait, timeout: a.timeout })))

  .command('jobs', 'My lessons on this node and the dataset each came from', (yy: Y) => keyOpts(yy)
    .option('dataset', { type: 'string', describe: 'only lessons trained from this dataset' }),
  run((ctx, a: G & { key?: string; 'key-file'?: string; dataset?: string }) => teachData.teachJobs(ctx, { key: a.key, keyFile: a['key-file'], dataset: a.dataset })))

  // Item 245 — a lesson saved unchecked because the model server was down cannot be published, and the only way to
  // measure it again was a button in the browser.
  .command('recheck <job-id>', 'Measure a lesson that was saved unchecked (the model server was unavailable)', (yy: Y) => keyOpts(yy)
    .positional('job-id', { type: 'string', demandOption: true, describe: `lesson id (\`${PROG} teach jobs\`)` })
    .option('wait', { type: 'boolean', default: false, describe: 'follow it until it is measured (same exit codes as `teach train --wait`)' })
    .example('$0 teach recheck 3a417bb4-… --wait', 'the morning after a night when the model server was off'),
  run((ctx, a: G & { 'job-id': string; key?: string; 'key-file'?: string; wait: boolean }) =>
    teachData.teachRecheck(ctx, a['job-id'], { key: a.key, keyFile: a['key-file'], wait: a.wait })))

  // ---- item 238: the last step of the loop, which only the browser could do. The consents are the publisher's own
  // and are never defaulted: without both flags the command refuses and quotes what is being consented to.
  .command('publish <job-id>', 'Publish a READY lesson as knowledge (the last step of `teach train` — needs both consent flags)', (yy: Y) => keyOpts(yy)
    .positional('job-id', { type: 'string', demandOption: true, describe: `lesson id (\`${PROG} teach jobs\`)` })
    .option('name', { type: 'string', demandOption: true, describe: 'what buyers see, 2-80 characters' })
    .option('price', { type: 'string', describe: 'price per download in this node\'s currency (default 0 = free)' })
    .option('license', { type: 'string', describe: 'licence for the knowledge (CC-BY-4.0, CC0-1.0, Proprietary, …)' })
    .option('description', { type: 'string', describe: 'one or two sentences about what it knows' })
    .option('payout', { type: 'string', describe: 'AIN address to be paid at, or `none` for credit without payment (default: this teaching key)' })
    .option('access', { choices: ['public', 'derivative', 'private'] as const, describe: 'who may read the training set: anyone, only people who declare they build on this (default), nobody' })
    .option('dataset-license', { type: 'string', describe: 'licence for the questions themselves' })
    .option('include-notes', { type: 'boolean', default: false, describe: 'include your per-row notes in the shared questions' })
    .option('declare', { choices: ['own', 'public', 'licensed'] as const, describe: 'where the questions came from: your own work, a public source, or licensed to you (the node requires this above a few hundred rows)' })
    .option('consent-permanent', { type: 'boolean', default: false, describe: 'I understand this becomes a permanent public record that cannot be edited or deleted' })
    .option('consent-rights', { type: 'boolean', default: false, describe: 'I have the right to share this information, and it is not private or personal data' })
    .example('$0 teach publish 8f0c… --name "KRX codes" --price 2 --consent-permanent --consent-rights', 'the last line of a nightly bake')
    .example('$0 teach train today.jsonl --wait && $0 teach publish <id> --name … --consent-permanent --consent-rights', 'train, then publish only if the lesson stuck (--wait exits non-zero otherwise)'),
  run((ctx, a: G & { 'job-id': string; key?: string; 'key-file'?: string; name: string; price?: string; license?: string; description?: string; payout?: string;
    access?: 'public' | 'derivative' | 'private'; 'dataset-license'?: string; 'include-notes': boolean; declare?: 'own' | 'public' | 'licensed'; 'consent-permanent': boolean; 'consent-rights': boolean }) =>
    teachData.teachPublish(ctx, a['job-id'], {
      key: a.key, keyFile: a['key-file'], name: a.name, price: a.price, license: a.license, description: a.description, payout: a.payout,
      access: a.access, datasetLicense: a['dataset-license'], includeNotes: a['include-notes'], declare: a.declare,
      consentPermanent: a['consent-permanent'], consentRights: a['consent-rights'],
    })))

  .demandCommand(1, 'Subcommand is required (status|dataset|train|publish|jobs).'), () => undefined);

// ---------------------------------------------------------------- dataset (the questions behind a published knowledge)
cli.command('dataset', 'Training sets: the questions a published knowledge was taught from (lineage design §13)', (y: Y) => fail(y)
  .command(['get <id>', 'download <id>'], 'The training set of a knowledge — what it is, and with -o the questions themselves', (yy: Y) => keyOpts(yy)
    .positional('id', { type: 'string', demandOption: true, describe: `knowledge id (\`${PROG} patch ls\`) or the sha256 of the training set` })
    .option('out', { alias: 'o', type: 'string', describe: `write the questions to this file (.jsonl — re-uploadable with \`${PROG} teach dataset <file>\`)` })
    .option('manifest', { type: 'boolean', default: false, describe: 'also print the manifest: row origin, licence, benchmark hash, PII scan, declaration' })
    .option('include-notes', { type: 'boolean', default: false, describe: 'keep the publisher’s per-row notes in the written file (they are left out by default)' })
    .example('$0 dataset get krx-all-2761', 'access, licence, where it came from, and the first questions')
    .example('$0 dataset get krx-all-2761 -o questions.jsonl', 'the exact bytes, ready to build on'),
  run((ctx, a: G & { id: string; key?: string; 'key-file'?: string; out?: string; manifest: boolean; 'include-notes': boolean }) =>
    dataset.datasetGetPublished(ctx, a.id, { key: a.key, keyFile: a['key-file'], out: a.out, manifest: a.manifest, includeNotes: a['include-notes'] })))
  .demandCommand(1, 'Subcommand is required (get).'), () => undefined);

cli.command('use <ids..>', 'One line to use knowledge: check it is verified → quote the price → pay → download → load into your model. Several ids are used in the order given', (y: Y) => fail(y)
  .positional('ids', { type: 'string', array: true, demandOption: true, describe: `knowledge id(s) — \`a b\` or \`a,b\`, in load order (see \`${PROG} patch ls\`)` })
  .option('apply', { type: 'boolean', default: true, describe: 'load into the serving model after download (--no-apply to only download)' })
  .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'skip the confirmation (answer yes in advance)' })
  .option('max-price', { type: 'number', describe: 'refuse if the total for one knowledge (it + the bases it needs) is above this' })
  .option('bundle', { type: 'boolean', default: false, describe: 'buy the bases this knowledge needs underneath it too (one payment each). Without it you are asked' })
  .option('with-base', { type: 'boolean', default: false, describe: 'the older name of --bundle', hidden: true })
  .option('again', { type: 'boolean', default: false, describe: 'pay again for something this node already bought (per-hit / per-apply-hour billing)' })
  // Item 236: `use <id>` on a superseded id used to print a green tick and buy it anyway.
  .option('allow-superseded', { type: 'boolean', default: false, describe: 'use a version that has been superseded by a newer one on the same subject (otherwise you are asked)' })
  .example('$0 use krx-all-2761', 'quote, ask, pay, download, load')
  .example('$0 use krx-all-2761 pixelplus-087600', 'two knowledges, loaded in that order')
  .example('$0 use krx-all-2761 --yes --max-price 30', 'unattended, with a budget'),
run((ctx, a: G & { ids: string[]; apply: boolean; yes: boolean; again: boolean; 'max-price'?: number; bundle?: boolean; 'with-base'?: boolean; 'allow-superseded'?: boolean }) =>
  patch.overIds(ctx, patch.parseIds(a.ids), a.apply === false ? 'bought' : 'loaded', (id, batched) =>
    patch.patchUse(ctx, id, { apply: a.apply, yes: a.yes, again: a.again, maxPrice: a['max-price'], withRequired: a.bundle || a['with-base'], allowSuperseded: a['allow-superseded'], batched }))));

// ---------------------------------------------------------------- chat (live test)
cli.command('chat [patchId] [prompt..]', 'Live-test a knowledge patch: the model\'s answer before vs after the patch is loaded (correct-answer check)', (y: Y) => fail(y)
  .positional('patchId', { type: 'string', describe: 'patch to test (see --list); `a,b` loads several together' })
  .positional('prompt', { type: 'string', array: true, describe: 'question; omit for an interactive session (/quit to exit)' })
  .option('list', { alias: 'l', type: 'boolean', default: false, describe: 'list patches testable on this node and the runtime state' })
  .option('patch', { alias: 'p', type: 'string', describe: 'knowledge to load together, comma-separated (up to 3, in load order; the last wins where they overlap)' })
  .option('mode', { alias: 'm', choices: ['base', 'patched', 'compare'] as const, default: 'compare', describe: 'base = model only, patched = with the patch loaded, compare = both' })
  .option('thinking', { type: 'boolean', default: false, describe: 'let the model think first and show its reasoning' })
  .option('max-tokens', { type: 'number', default: 200, describe: 'answer length limit (1–1024)' })
  .check((a) => {
    // the help has always said 1–1024; check it here instead of letting the node answer with a zod sentence
    const n = (a as { 'max-tokens'?: number })['max-tokens'];
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 1024)) throw new Error(`--max-tokens must be a whole number between 1 and 1024 (got ${n})`);
    return true;
  })
  .option('system', { type: 'string', describe: 'system prompt prepended to the conversation' })
  .example('$0 chat --list', 'what can be tested here')
  .example('$0 chat pixelplus-087600 "Pixelplus ticker code? Digits only."', 'before/after in one shot')
  .example('$0 chat krx-all-2761 --mode patched', 'interactive session with the patch loaded')
  .example('$0 chat --patch krx-all-2761,pixelplus-087600 "픽셀플러스 종목코드 알려줘. 숫자만."', 'two knowledges loaded together (up to 3)'),
run(async (ctx, a: G & { patchId?: string; prompt?: string[]; list: boolean; patch?: string; mode: chat.ChatMode; thinking: boolean; 'max-tokens': number; system?: string }) => {
  // `--patch a,b` (or a comma-separated positional) selects the knowledge; with --patch the positional is part of the question.
  const ids = a.patch ? chat.parsePatchIds(a.patch) : a.patchId ? chat.parsePatchIds(a.patchId) : [];
  const promptParts = a.patch && a.patchId ? [a.patchId, ...(a.prompt ?? [])] : (a.prompt ?? []);
  if (a.list || ids.length === 0) {
    if (!a.list && ids.length === 0) throw new CliError(`patch id required — \`${PROG} chat --list\` shows what this node can test`);
    return chat.chatPatches(ctx);
  }
  const opts: chat.ChatArgs = { mode: a.mode, thinking: a.thinking, maxTokens: a['max-tokens'], system: a.system };
  // D2: keep the prompt exactly as typed — this product's knowledge is trained on prompts that end with a space
  // ("종목코드 픽셀플러스 "), so `ainize chat <id> "종목코드 픽셀플러스 "` must send that space too.
  const prompt = promptParts.join(' ');
  if (prompt.trim()) return chat.chat(ctx, ids, prompt, opts);
  await chat.chatRepl(ctx, ids, opts);
  process.exit(0);
}, true));

// ---------------------------------------------------------------- ledger
cli.command('ledger', 'Inspect the ledger', (y: Y) => fail(y)
  .command('ls', 'List records', (yy: Y) => yy.option('kind', { choices: RECORD_KINDS, describe: 'only this kind of record' }).option('limit', { type: 'number', default: 50, describe: 'how many records, newest last' }),
    run((ctx, a: G & { kind?: RecordKind; limit: number }) => ledger.ledgerLs(ctx, a)))
  .command('verify', 'Verify hashes, signatures and chain linkage', (yy: Y) => yy, run((ctx) => ledger.ledgerVerify(ctx)))
  .command('graph', 'ASCII lineage tree', (yy: Y) => yy, run((ctx) => ledger.ledgerGraph(ctx)))
  .command('export <file>', 'Export records as JSON lines', (yy: Y) => yy.positional('file', { type: 'string', demandOption: true }), run((ctx, a: G & { file: string }) => ledger.ledgerExport(ctx, a.file)))
  .demandCommand(1, 'Subcommand is required (ls|verify|graph|export).'), () => undefined);

// ---------------------------------------------------------------- branches / routing / wallet
cli.command('branch', 'Knowledge branches (parallel, possibly contradictory patch sets)', (y: Y) => fail(y)
  .command('ls', 'List branches', (yy: Y) => yy
    .option('all', { type: 'boolean', default: false, describe: 'include test and archived tracks (hidden from every public list)' }),
    run((ctx, a: G & { all?: boolean }) => branch.branchLs(ctx, { all: a.all })))
  .command('create <name>', 'Create a branch', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true })
    .option('description', { type: 'string', describe: 'what this track is for, in one line' })
    .option('context', { type: 'string', array: true, describe: 'k=v routing attributes (e.g. jurisdiction=KR)' })
    .option('patch', { type: 'string', array: true, describe: 'patch id(s) in the branch' })
    .option('test', { type: 'boolean', default: false, describe: 'a fixture track: on the record, but off /network, off the router and out of `branch ls`' })
    .example('$0 branch create law/KR --context jurisdiction=KR --patch law-kr-2025', ''),
  run((ctx, a: G & { name: string; description?: string; context?: string[]; patch?: string[]; test?: boolean }) => branch.branchCreate(ctx, a.name, a)))
  // Item 269 — a track could never be taken off the shelf, so the public list was 32 test tracks around three real ones.
  .command('archive <name>', 'Take a track of yours off /network, the router and `branch ls` (the record and its subscribers stay)', (yy: Y) => yy
    .positional('name', { type: 'string', demandOption: true })
    .example('$0 branch archive e2e/KR-1788174110', 'a fixture track written by a test run comes off the shelf'),
    run((ctx, a: G & { name: string }) => branch.branchArchive(ctx, a.name, true)))
  .command('unarchive <name>', 'Put an archived track back on the lists', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true }),
    run((ctx, a: G & { name: string }) => branch.branchArchive(ctx, a.name, false)))
  .command('add <name> <patchId>', 'Add knowledge to a track you own (verified knowledge only)', (yy: Y) => yy
    .positional('name', { type: 'string', demandOption: true, describe: `the track (see \`${PROG} branch ls\`)` })
    .positional('patchId', { type: 'string', demandOption: true, describe: 'the knowledge to add — every subscriber buys and loads it' })
    .option('force', { type: 'boolean', default: false, describe: 'add it even though it is not LISTED — every subscriber will buy and load it' }),
    run((ctx, a: G & { name: string; patchId: string; force?: boolean }) => branch.branchAdd(ctx, a.name, a.patchId, { force: a.force })))
  .command('quote <name>', 'What subscribing to this track would spend, item by item, before anything is spent', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true }),
    run((ctx, a: G & { name: string }) => branch.branchQuote(ctx, a.name)))
  .command('subscribe <name>', 'Subscribe this node: buy the track\'s current knowledge, load it, and keep it up to date', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true })
    .option('yes', { type: 'boolean', default: false, describe: 'answer the spend confirmation in advance' })
    // Item 214 — the track is applied on top of what is loaded, and the model is last-wins on a shared row.
    .option('replace', { type: 'boolean', default: false, describe: 'load the track even though it writes over knowledge already in the model (it answers instead of it on the shared rows)' })
    .example('$0 branch subscribe daily/krx --yes', ''),
    run((ctx, a: G & { name: string; yes?: boolean; replace?: boolean }) => branch.branchSubscribe(ctx, a.name, 'subscribe', { yes: a.yes, replace: a.replace })))
  .command('sync <name>', 'Bring a subscribed track up to date now (buy and load what it added, unload what it retired)', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true }),
    run((ctx, a: G & { name: string }) => branch.branchSync(ctx, a.name)))
  .command('unsubscribe <name>', 'Unsubscribe (unload the track\'s knowledge; nothing is refunded)', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true }), run((ctx, a: G & { name: string }) => branch.branchSubscribe(ctx, a.name, 'unsubscribe')))
  // Item 264 — a track was append-only: an unverified or rejected bake could be added and never taken off.
  .command('rm <name> <patchId>', 'Take a knowledge off a track you own (subscribers stop buying and loading it)', (yy: Y) => yy
    .positional('name', { type: 'string', demandOption: true, describe: 'track name' })
    .positional('patchId', { type: 'string', demandOption: true, describe: 'the knowledge to remove from it' })
    .option('yes', { type: 'boolean', default: false, describe: 'answer the confirmation in advance' })
    .example('$0 branch rm daily/krx krx-daily-2026-09-03', 'a bake that failed verification comes off the track'),
    run((ctx, a: G & { name: string; patchId: string; yes?: boolean }) => branch.branchRemove(ctx, a.name, a.patchId, { yes: a.yes })))
  .demandCommand(1, 'Subcommand is required (ls|create|add|rm|archive|unarchive|quote|subscribe|sync|unsubscribe).'), () => undefined);
cli.command('route <context..>', 'Gateway routing: which track and which nodes serve a request context', (y: Y) => fail(y).positional('context', { type: 'string', array: true, demandOption: true, describe: 'k=v pairs' })
  // Item 234 — a track that answers only some of the attributes you named is not an answer unless you say so.
  .option('partial', { type: 'boolean', default: false, describe: 'accept the closest track even though it does not match every attribute' })
  .example('$0 route jurisdiction=KR', '')
  .example('$0 route market=KRX freshness=daily --partial', 'route to the closest track when nothing matches both'),
  run((ctx, a: G & { context: string[]; partial?: boolean }) => branch.route(ctx, a.context, { partial: a.partial })));
cli.command('wallet', 'Balance, sales, royalties and pending payouts of this node', (y: Y) => fail(y), run((ctx) => branch.wallet(ctx)));
// `patch ls --mine` is the knowledge this node REGISTERED; a buyer's own purchases had no listing anywhere (items 216, 289).
cli.command('purchases', 'Knowledge this node bought: what, from whom, for how much, and whether it is loaded', (y: Y) => fail(y)
  .example('$0 purchases', 'every purchase with its seller, tx and file'), run((ctx) => patch.purchasesLs(ctx)));
cli.command('payouts', 'Royalty transfers this node owes creators and data providers (AIN ledger)', (y: Y) => fail(y)
  .command(['ls', '$0'], 'List payouts', (yy: Y) => yy.option('status', { type: 'string', choices: ['pending', 'paid', 'failed'], describe: 'only payouts in this state' }).option('address', { type: 'string', describe: 'only this recipient' }).option('limit', { type: 'number', describe: 'how many rows (default: all of them)' })
    .example('$0 payouts ls --status failed', ''),
  run((ctx, a: G & { status?: string; address?: string; limit?: number }) => branch.payoutsLs(ctx, a)))
  .command('retry <id>', 'Retry one failed / pending payout now', (yy: Y) => yy.positional('id', { type: 'number', demandOption: true, describe: `the payout row id (\`${PROG} payouts ls\`)` }), run((ctx, a: G & { id: number }) => branch.payoutRetry(ctx, a.id)))
  // Item 313: the rows exist only in this node's SQLite and were never rebuilt from the settlements that created
  // the debt — a wiped data dir or a crash between the record and the row left money owed and unpayable.
  .command('reconcile', 'Rebuild the payouts this node owes from its own settlements, then pay what is due', (yy: Y) => yy
    .example('$0 payouts reconcile', 'after a restore, a crash, or an upgrade'),
    run((ctx) => branch.payoutsReconcile(ctx))),
  () => undefined);

// ---------------------------------------------------------------- drive
cli.command('drive', 'aindrive: files & change history of this node', (y: Y) => fail(y)
  .command('status', 'Drive status (pairing, agent, files)', (yy: Y) => yy.option('files', { type: 'boolean', default: false, describe: 'also list the files in the drive folder' }), run((ctx, a: G & { files: boolean }) => drive.driveStatus(ctx, a)))
  .command('up', 'Start the aindrive agent for the node\'s drive folder', (yy: Y) => yy, run((ctx) => drive.driveAction(ctx, 'up')))
  .command('stop', 'Stop the aindrive agent', (yy: Y) => yy, run((ctx) => drive.driveAction(ctx, 'stop')))
  .command('sync', 'Rewrite the drive mirror from the current market state', (yy: Y) => yy, run((ctx) => drive.driveAction(ctx, 'sync')))
  .command('login', 'One-time browser pairing of the drive folder (interactive)', (yy: Y) => yy.option('server', { type: 'string', describe: `aindrive server (default ${drive.DEFAULT_AINDRIVE_SERVER})` })
    .option('name', { type: 'string', describe: 'drive name' }).option('open', { type: 'boolean', default: true, describe: 'open the browser for the pairing login (--no-open prints the link only)' }),
  run(async (ctx, a: G & { server?: string; name?: string; open: boolean }) => { const code = await drive.driveLogin(ctx, { server: a.server, name: a.name, noOpen: !a.open }); process.exit(code); }, true))
  .demandCommand(1, 'Subcommand is required (status|up|stop|sync|login).'), () => undefined);

// ---------------------------------------------------------------- chain
cli.command('chain', 'Local AIN blockchain (docker) for the ain ledger', (y: Y) => fail(y)
  .command('up', 'Start (or attach to) a local 1-node AIN chain on :8081', (yy: Y) => yy.option('wait', { type: 'number', default: 90, describe: 'seconds to wait for SERVING' }), run((ctx, a: G & { wait: number }) => chain.chainUp(ctx, a), false, true))
  .command('down', 'Remove the local chain container', (yy: Y) => yy, run((ctx) => chain.chainDown(ctx), false, true))
  .command('status', 'Chain health and last block', (yy: Y) => yy.option('provider', { type: 'string', describe: 'AIN JSON-RPC URL to ask (default: the one in config.json)' }), run((ctx, a: G & { provider?: string }) => chain.chainStatus(ctx, a.provider), false, true))
  .command('fund <address> [amount]', 'Transfer AIN from the local genesis account (local chain only)', (yy: Y) => yy
    .positional('address', { type: 'string', demandOption: true, describe: `the AIN address to credit (\`${PROG} keys show\`)` })
    .positional('amount', { type: 'number', default: 1000, describe: 'how much AIN' })
    .option('provider', { type: 'string', describe: 'AIN JSON-RPC URL to send it through (default: the one in config.json)' }),
    run((ctx, a: G & { address: string; amount: number; provider?: string }) => chain.chainFund(ctx, a.address, a.amount, a.provider), false, true))
  .command('setup', 'Register the knowledge app + market rules on-chain (funds the node identity first on a local chain)', (yy: Y) => yy.option('fund', { type: 'number', describe: 'AIN to fund the node identity with' }),
    run((ctx, a: G & { fund?: number }) => chain.chainSetup(ctx, a), false, true))
  .demandCommand(1, 'Subcommand is required (up|down|status|fund|setup).'), () => undefined);

fail(cli);
await cli.parseAsync();
