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
import { CliError, PROG, buildContext, type CliContext } from './context.js';
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

type G = { home?: string; node?: string; json?: boolean; quiet?: boolean };
// yargs' generic inference gets unwieldy with nested command groups; handlers receive the parsed args untyped
// and cast to the shape their builder guarantees.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Y = Argv<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = ArgumentsCamelCase<any>;
const ctxOf = (a: G): CliContext => buildContext({ home: a.home, node: a.node, json: a.json, quiet: a.quiet });

const run = <A extends G>(fn: (ctx: CliContext, a: A) => Promise<unknown> | unknown, keepAlive = false) => async (raw: Raw) => {
  const a = raw as unknown as A;
  try {
    await fn(ctxOf(a), a);
    if (!keepAlive) process.exitCode = 0;
  } catch (e) {
    const err = e as CliError;
    process.stderr.write(chalk.red('error: ') + (err.message ?? String(e)) + '\n');
    process.exit(err instanceof CliError ? err.exitCode : 1);
  }
};

const fail = (y: Y): Y => y.fail((msg, err) => {
  process.stderr.write(chalk.red('error: ') + (err?.message ?? msg) + '\n' + chalk.gray('Specify --help for available options.') + '\n');
  process.exit(1);
});

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
  .option('json', { type: 'boolean', describe: 'machine-readable JSON output', global: true, default: false })
  .option('quiet', { type: 'boolean', describe: 'suppress output', global: true, default: false })
  .alias('h', 'help').help('help').version()
  .showHelpOnFail(false, 'Specify --help for available options.')
  .strict()
  .wrap(Math.min(110, process.stdout.columns || 100))
  .demandCommand(1, `Specify a command. Try \`${PROG} --help\`.`);

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
  .option('force', { type: 'boolean', describe: 'overwrite existing config', default: false })
  .example('$0 init --name alice --port 3402', 'local ledger node')
  .example('$0 init --ledger ain --ain-provider http://localhost:8081', 'AIN blockchain ledger (see `$0 chain up`)'),
run((ctx, a: G & init.InitArgs & { 'ain-provider'?: string; 'ain-chain-id'?: number; 'runtime-repo'?: string; 'runtime-api'?: string; 'private-key'?: string; 'public-url'?: string }) =>
  init.init(ctx, { ...a, ainProvider: a['ain-provider'], ainChainId: a['ain-chain-id'], runtimeRepo: a['runtime-repo'], runtimeApi: a['runtime-api'], privateKey: a['private-key'], publicUrl: a['public-url'] })));

cli.command('config', 'Show or edit the node config', (y: Y) => fail(y)
  .command('show', 'Print config.json (secrets hidden)', (yy: Y) => yy, run((ctx) => init.configShow(ctx)))
  .command('set <key> <value>', 'Set a config key (dotted path, e.g. market.defaultPrice 0.5)', (yy: Y) => yy
    .positional('key', { type: 'string', demandOption: true }).positional('value', { type: 'string', demandOption: true })
    .example('$0 config set ledger.kind ain', '').example('$0 config set peers http://a:3402,http://b:3403', ''),
  run((ctx, a: G & { key: string; value: string }) => init.configSet(ctx, a.key, a.value)))
  .demandCommand(1, 'Subcommand is required (show|set).'), () => undefined);

cli.command('keys', 'Node identity keys', (y: Y) => fail(y)
  .command('show', 'Print address and public key', (yy: Y) => yy.option('reveal', { type: 'boolean', default: false, describe: 'also print the private key' }),
    run((ctx, a: G & { reveal: boolean }) => init.keysShow(ctx, a.reveal)))
  .demandCommand(1, 'Subcommand is required (show).'), () => undefined);

// ---------------------------------------------------------------- lifecycle
cli.command('start', 'Start the node (foreground unless --detach)', (y: Y) => fail(y)
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
cli.command('stop', 'Stop a background node', (y: Y) => fail(y), run((ctx) => node.stop(ctx)));
cli.command('status', 'Show node / ledger / runtime status', (y: Y) => fail(y), run((ctx) => node.status(ctx)));
cli.command('logs', 'Show node events', (y: Y) => fail(y)
  .option('follow', { alias: 'f', type: 'boolean', default: false }).option('patch', { type: 'string', describe: 'only events of a patch' })
  .option('kind', { type: 'string', describe: 'filter by kind (p2p, verify, trade, runtime, …)' }).option('limit', { type: 'number', default: 100 }),
run((ctx, a: G & { follow: boolean; patch?: string; kind?: string; limit: number }) => node.logs(ctx, a), true));
cli.command('seed', 'Seed demo data (prototype ledger, real Qwen3.8 patches if present, synthetic branches)', (y: Y) => fail(y)
  .option('real', { type: 'boolean', default: true, describe: 'register real patches from the runtime repo' })
  .option('synthetic', { type: 'boolean', default: false, describe: 'create synthetic law/KR vs law/US demo patches' })
  .option('prototype', { type: 'boolean', default: false, describe: 'import the reference prototype ledger' })
  .option('announce', { type: 'boolean', default: true }),
run((ctx, a: G & { real: boolean; synthetic: boolean; prototype: boolean; announce: boolean }) => node.seed(ctx, a)));
cli.command('nodes', 'List known nodes and configured peers', (y: Y) => fail(y), run((ctx) => node.nodesTable(ctx)));

// ---------------------------------------------------------------- auth
cli.command('login', 'Log in as the node operator (sets the password on first use)', (y: Y) => fail(y).option('password', { type: 'string', describe: 'or NGRAM_PASSWORD env' }),
  run((ctx, a: G & { password?: string }) => auth.login(ctx, a)));
cli.command('logout', 'Forget the operator session', (y: Y) => fail(y), run((ctx) => auth.logout(ctx)));

// ---------------------------------------------------------------- peers
cli.command('peers', 'Manage peers', (y: Y) => fail(y)
  .command('ls', 'List peers', (yy: Y) => yy, run((ctx) => peers.peersLs(ctx)))
  .command('add <url>', 'Add a peer', (yy: Y) => yy.positional('url', { type: 'string', demandOption: true }), run((ctx, a: G & { url: string }) => peers.peersAdd(ctx, a.url)))
  .command('rm <url>', 'Remove a peer', (yy: Y) => yy.positional('url', { type: 'string', demandOption: true }), run((ctx, a: G & { url: string }) => peers.peersRm(ctx, a.url)))
  .demandCommand(1, 'Subcommand is required (ls|add|rm).'), () => undefined);

// ---------------------------------------------------------------- patches
cli.command('patch', 'Publish, inspect, verify, buy and apply knowledge patches', (y: Y) => fail(y)
  .command('ls', 'List patches in the catalog', (yy: Y) => yy
    .option('status', { type: 'string', describe: 'comma list: DRAFT,ANNOUNCED,VERIFYING,LISTED,REJECTED,CHALLENGED,SUPERSEDED' })
    .option('model', { type: 'string' }).option('schema', { type: 'string', describe: 'benchmark schema' }).option('branch', { type: 'string' })
    .option('author', { type: 'string' }).option('q', { type: 'string', describe: 'text search' })
    .option('sort', { choices: ['latest', 'popular', 'price', 'rows'] as const, default: 'latest' })
    .option('limit', { type: 'number', default: 100 }).option('mine', { type: 'boolean', default: false, describe: 'only my patches (needs login)' })
    .option('drafts', { type: 'boolean', default: false, describe: 'include my drafts (needs login)' }),
  run((ctx, a: G & patch.LsArgs) => patch.patchLs(ctx, a)))
  .command('get <id>', 'Show a patch in detail', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchGet(ctx, a.id)))
  .command('publish <file>', 'Register a .npz patch body as a draft (and optionally announce it)', (yy: Y) => yy
    .positional('file', { type: 'string', demandOption: true, describe: 'path to .npz on the node machine' })
    .option('name', { type: 'string', demandOption: true }).option('model', { type: 'string', demandOption: true, describe: 'target model id_M' })
    .option('benchmark', { type: 'string', demandOption: true, describe: 'benchmark JSON file or inline JSON ({schema, queries, format, samples})' })
    .option('id', { type: 'string' }).option('price', { type: 'string' }).option('description', { type: 'string' })
    .option('parents', { type: 'string', describe: 'comma list of parent patch ids (lineage/royalty)' }).option('branch', { type: 'string' })
    .option('topic', { type: 'string', describe: 'ain-js knowledge topic path (e.g. finance/krx)' }).option('license', { type: 'string' })
    .option('billing', { choices: ['per_download', 'per_apply_hour', 'per_hit'] as const })
    .option('contributor', { type: 'string', array: true, describe: 'data provider credited on the record: addr:name:share (repeatable, ≤ 4, Σ share ≤ 1)' })
    .option('announce', { type: 'boolean', default: false, describe: 'announce to the network immediately' })
    .example('$0 patch publish ./rows.npz --name "KRX tickers" --model Qwen3.8-Flash-Next --benchmark bench.json --price 25 --announce', ''),
  run((ctx, a: G & patch.PublishArgs) => patch.patchPublish(ctx, a)))
  .command('import <file>', 'Import a downloaded lesson (.npz + recipe.json) as a PRIVATE draft: no announce, no ledger record', (yy: Y) => yy
    .positional('file', { type: 'string', demandOption: true, describe: 'lesson-<slug>.npz on the node machine (stays in place)' })
    .option('recipe', { type: 'string', demandOption: true, describe: 'recipe.json downloaded with the lesson (benchmark, model, facts)' })
    .option('id', { type: 'string', describe: 'draft id (default: the lesson\'s draft id, taught-<slug>)' }).option('name', { type: 'string' })
    .option('model', { type: 'string', describe: 'target model id_M when the recipe names none' }).option('price', { type: 'string' }).option('license', { type: 'string' })
    .option('description', { type: 'string' })
    .example('$0 patch import ./lesson-pixelplus-1a2b3c.npz --recipe ./recipe.json', 'then: $0 patch apply taught-pixelplus-1a2b3c'),
  run((ctx, a: G & patch.ImportArgs) => patch.patchImport(ctx, a)))
  .command('announce <id>', 'DRAFT → ANNOUNCED (anchor on the ledger)', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchAnnounce(ctx, a.id)))
  .command('verify <id>', 'Run this node\'s verifier on a patch and publish an attestation', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchVerify(ctx, a.id)))
  .command('challenge <id>', 'Open a re-verification challenge', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }).option('reason', { type: 'string', demandOption: true }),
    run((ctx, a: G & { id: string; reason: string }) => patch.patchChallenge(ctx, a.id, a.reason)))
  .command('buy <id>', 'Buy a listed patch via HTTP 402 (x402) and download its body', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true })
    .option('apply', { type: 'boolean', default: false, describe: 'apply to the serving runtime after download' }),
  run((ctx, a: G & { id: string; apply: boolean }) => patch.patchBuy(ctx, a.id, a.apply)))
  .command('apply <id>', 'Apply a held patch to the serving runtime (no restart)', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchApply(ctx, a.id)))
  .command('remove <id>', 'Restore original rows (un-apply)', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchRemove(ctx, a.id)))
  .command('conflicts <id>', 'Address-set overlaps with other patches', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchConflicts(ctx, a.id)))
  .command('records <id>', 'Ledger records about a patch', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchRecords(ctx, a.id)))
  .command('rm <id>', 'Delete a draft', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchRm(ctx, a.id)))
  .command('forget <id>', 'Stop serving the knowledge file from this node (deletes the local body; the public record stays)', (yy: Y) => yy.positional('id', { type: 'string', demandOption: true }), run((ctx, a: G & { id: string }) => patch.patchForget(ctx, a.id)))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);

// ---------------------------------------------------------------- one-liners (publish / use)
cli.command('publish <file>', 'One line to sell knowledge: register a .npz + benchmark and announce it (the network verifies, you get paid per sale)', (y: Y) => fail(y)
  .positional('file', { type: 'string', demandOption: true, describe: 'path to the learned knowledge (.npz: addrs/before/after)' })
  .option('name', { type: 'string', demandOption: true, describe: 'human name of the knowledge' })
  .option('model', { type: 'string', demandOption: true, describe: 'target model id_M (e.g. Qwen3.8-Flash-Next)' })
  .option('benchmark', { type: 'string', demandOption: true, describe: 'bench.json path or inline JSON {schema, queries, format, samples:[{prompt,expect}]}' })
  .option('price', { type: 'string', describe: 'price in the node currency (AIN or node credit)' })
  .option('id', { type: 'string' }).option('description', { type: 'string' }).option('parents', { type: 'string', describe: 'comma list of source knowledge ids (creators get a revenue share)' })
  .option('branch', { type: 'string' }).option('topic', { type: 'string' }).option('license', { type: 'string' })
  .option('announce', { type: 'boolean', default: true, describe: 'announce immediately (--no-announce keeps a draft)' })
  .option('test', { type: 'boolean', default: false, describe: 'hidden test listing (not shown in public catalogs)' })
  .option('contributor', { type: 'string', array: true, describe: 'data provider credited and paid on the record: addr:name:share — share = fraction of YOUR share of each sale (repeatable, ≤ 4, Σ ≤ 1)' })
  .example('$0 publish ./my-knowledge.npz --name "KRX ticker codes" --model Qwen3.8-Flash-Next --benchmark ./bench.json --price 25', '')
  .example('$0 publish ./lesson.npz --name "…" --model … --benchmark ./bench.json --contributor 0xAbC…:Alice:0.7', 'Alice (data provider) gets 70 % of your share of every sale'),
run((ctx, a: G & patch.PublishArgs) => patch.patchPublish(ctx, { ...a, announce: a.announce !== false })));

// ---------------------------------------------------------------- teach (visitor-taught lessons)
cli.command('teach', 'Teach mode: lessons visitors taught the model (the teaching itself happens in the browser: <node>/chat?teach=1)', (y: Y) => fail(y)
  .command('status [target]', 'Teaching policy of a node, the status of a lesson, or a data provider\'s lessons and earnings', (yy: Y) => yy
    .positional('target', { type: 'string', describe: 'node URL · lesson URL (…/chat?lesson=<id>) or job id · teacher page (…/teacher/<address>) or 0x address; default: this node' })
    .option('key', { type: 'string', describe: 'teaching key (64-hex) — or NGRAM_TEACH_KEY; shows the full lesson body for your own lessons' })
    .option('key-file', { type: 'string', describe: 'the key backup JSON downloaded from the browser (ainize-teaching-key-….json)' })
    .example('$0 teach status http://localhost:3402', 'is this node accepting lessons? publish mode, trainer, queue')
    .example('$0 teach status "http://localhost:3402/chat?lesson=8f0c…" --key-file ainize-teaching-key-1a2b3c4d.json', 'your lesson: progress, checks, before/after')
    .example('$0 teach status http://localhost:3402/teacher/0xAbC…', 'a data provider\'s lessons and earnings'),
  run((ctx, a: G & { target?: string; key?: string; 'key-file'?: string }) => teach.teachStatus(ctx, a.target, { key: a.key, keyFile: a['key-file'] })))
  .demandCommand(1, 'Subcommand is required (status).'), () => undefined);

cli.command('use <id>', 'One line to use knowledge: check it is verified → pay automatically → download → load into your model', (y: Y) => fail(y)
  .positional('id', { type: 'string', demandOption: true, describe: 'knowledge id (see `$0 patch ls`)' })
  .option('apply', { type: 'boolean', default: true, describe: 'load into the serving model after download (--no-apply to only download)' })
  .example('$0 use krx-all-2761', ''),
run((ctx, a: G & { id: string; apply: boolean }) => patch.patchUse(ctx, a.id, { apply: a.apply })));

// ---------------------------------------------------------------- chat (live test)
cli.command('chat [patchId] [prompt..]', 'Live-test a knowledge patch: the model\'s answer before vs after the patch is loaded (correct-answer check)', (y: Y) => fail(y)
  .positional('patchId', { type: 'string', describe: 'patch to test (see --list); `a,b` loads several together' })
  .positional('prompt', { type: 'string', array: true, describe: 'question; omit for an interactive session (/quit to exit)' })
  .option('list', { alias: 'l', type: 'boolean', default: false, describe: 'list patches testable on this node and the runtime state' })
  .option('patch', { alias: 'p', type: 'string', describe: 'knowledge to load together, comma-separated (up to 3, in load order; the last wins where they overlap)' })
  .option('mode', { alias: 'm', choices: ['base', 'patched', 'compare'] as const, default: 'compare', describe: 'base = model only, patched = with the patch loaded, compare = both' })
  .option('thinking', { type: 'boolean', default: false, describe: 'let the model think first and show its reasoning' })
  .option('max-tokens', { type: 'number', default: 200, describe: 'answer length limit (1–1024)' })
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
  const prompt = promptParts.join(' ').trim();
  if (prompt) return chat.chat(ctx, ids, prompt, opts);
  await chat.chatRepl(ctx, ids, opts);
  process.exit(0);
}, true));

// ---------------------------------------------------------------- ledger
cli.command('ledger', 'Inspect the ledger', (y: Y) => fail(y)
  .command('ls', 'List records', (yy: Y) => yy.option('kind', { type: 'string', describe: 'anchor|attest|settle|challenge|branch|node|supersede|subscribe' }).option('limit', { type: 'number', default: 50 }),
    run((ctx, a: G & { kind?: string; limit: number }) => ledger.ledgerLs(ctx, a)))
  .command('verify', 'Verify hashes, signatures and chain linkage', (yy: Y) => yy, run((ctx) => ledger.ledgerVerify(ctx)))
  .command('graph', 'ASCII lineage tree', (yy: Y) => yy, run((ctx) => ledger.ledgerGraph(ctx)))
  .command('export <file>', 'Export records as JSON lines', (yy: Y) => yy.positional('file', { type: 'string', demandOption: true }), run((ctx, a: G & { file: string }) => ledger.ledgerExport(ctx, a.file)))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);

// ---------------------------------------------------------------- branches / routing / wallet
cli.command('branch', 'Knowledge branches (parallel, possibly contradictory patch sets)', (y: Y) => fail(y)
  .command('ls', 'List branches', (yy: Y) => yy, run((ctx) => branch.branchLs(ctx)))
  .command('create <name>', 'Create a branch', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true })
    .option('description', { type: 'string' }).option('context', { type: 'string', array: true, describe: 'k=v routing attributes (e.g. jurisdiction=KR)' })
    .option('patch', { type: 'string', array: true, describe: 'patch id(s) in the branch' })
    .example('$0 branch create law/KR --context jurisdiction=KR --patch law-kr-2025', ''),
  run((ctx, a: G & { name: string; description?: string; context?: string[]; patch?: string[] }) => branch.branchCreate(ctx, a.name, a)))
  .command('add <name> <patchId>', 'Add a patch to a branch you own', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true }).positional('patchId', { type: 'string', demandOption: true }),
    run((ctx, a: G & { name: string; patchId: string }) => branch.branchAdd(ctx, a.name, a.patchId)))
  .command('subscribe <name>', 'Subscribe this node (acquire + apply the branch\'s patches)', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true }), run((ctx, a: G & { name: string }) => branch.branchSubscribe(ctx, a.name, 'subscribe')))
  .command('unsubscribe <name>', 'Unsubscribe (restore rows)', (yy: Y) => yy.positional('name', { type: 'string', demandOption: true }), run((ctx, a: G & { name: string }) => branch.branchSubscribe(ctx, a.name, 'unsubscribe')))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);
cli.command('route <context..>', 'Gateway routing: which branch/nodes serve a request context', (y: Y) => fail(y).positional('context', { type: 'string', array: true, demandOption: true, describe: 'k=v pairs' })
  .example('$0 route jurisdiction=KR', ''), run((ctx, a: G & { context: string[] }) => branch.route(ctx, a.context)));
cli.command('wallet', 'Balance, sales, royalties and pending payouts of this node', (y: Y) => fail(y), run((ctx) => branch.wallet(ctx)));
cli.command('payouts', 'Royalty transfers this node owes creators and data providers (AIN ledger)', (y: Y) => fail(y)
  .command(['ls', '$0'], 'List payouts', (yy: Y) => yy.option('status', { type: 'string', choices: ['pending', 'paid', 'failed'] }).option('address', { type: 'string', describe: 'only this recipient' }).option('limit', { type: 'number' })
    .example('$0 payouts ls --status failed', ''),
  run((ctx, a: G & { status?: string; address?: string; limit?: number }) => branch.payoutsLs(ctx, a)))
  .command('retry <id>', 'Retry one failed / pending payout now', (yy: Y) => yy.positional('id', { type: 'number', demandOption: true }), run((ctx, a: G & { id: number }) => branch.payoutRetry(ctx, a.id))),
  () => undefined);

// ---------------------------------------------------------------- drive
cli.command('drive', 'aindrive: files & change history of this node', (y: Y) => fail(y)
  .command('status', 'Drive status (pairing, agent, files)', (yy: Y) => yy.option('files', { type: 'boolean', default: false }), run((ctx, a: G & { files: boolean }) => drive.driveStatus(ctx, a)))
  .command('up', 'Start the aindrive agent for the node\'s drive folder', (yy: Y) => yy, run((ctx) => drive.driveAction(ctx, 'up')))
  .command('stop', 'Stop the aindrive agent', (yy: Y) => yy, run((ctx) => drive.driveAction(ctx, 'stop')))
  .command('sync', 'Rewrite the drive mirror from the current market state', (yy: Y) => yy, run((ctx) => drive.driveAction(ctx, 'sync')))
  .command('login', 'One-time browser pairing of the drive folder (interactive)', (yy: Y) => yy.option('server', { type: 'string', describe: `aindrive server (default ${drive.DEFAULT_AINDRIVE_SERVER})` })
    .option('name', { type: 'string', describe: 'drive name' }).option('open', { type: 'boolean', default: true, describe: 'open the browser for the pairing login (--no-open prints the link only)' }),
  run(async (ctx, a: G & { server?: string; name?: string; open: boolean }) => { const code = await drive.driveLogin(ctx, { server: a.server, name: a.name, noOpen: !a.open }); process.exit(code); }, true))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);

// ---------------------------------------------------------------- chain
cli.command('chain', 'Local AIN blockchain (docker) for the ain ledger', (y: Y) => fail(y)
  .command('up', 'Start (or attach to) a local 1-node AIN chain on :8081', (yy: Y) => yy.option('wait', { type: 'number', default: 90, describe: 'seconds to wait for SERVING' }), run((ctx, a: G & { wait: number }) => chain.chainUp(ctx, a)))
  .command('down', 'Remove the local chain container', (yy: Y) => yy, run((ctx) => chain.chainDown(ctx)))
  .command('status', 'Chain health and last block', (yy: Y) => yy.option('provider', { type: 'string' }), run((ctx, a: G & { provider?: string }) => chain.chainStatus(ctx, a.provider)))
  .command('fund <address> [amount]', 'Transfer AIN from the local genesis account (local chain only)', (yy: Y) => yy.positional('address', { type: 'string', demandOption: true }).positional('amount', { type: 'number', default: 1000 }).option('provider', { type: 'string' }),
    run((ctx, a: G & { address: string; amount: number; provider?: string }) => chain.chainFund(ctx, a.address, a.amount, a.provider)))
  .command('setup', 'Register the knowledge app + market rules on-chain (funds the node identity first on a local chain)', (yy: Y) => yy.option('fund', { type: 'number', describe: 'AIN to fund the node identity with' }),
    run((ctx, a: G & { fund?: number }) => chain.chainSetup(ctx, a)))
  .demandCommand(1, 'Subcommand is required.'), () => undefined);

fail(cli);
await cli.parseAsync();
