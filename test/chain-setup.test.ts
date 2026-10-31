import test from 'node:test';
import assert from 'node:assert/strict';
import yargs from 'yargs';
import { CliError, type CliContext } from '../src/context.js';
import { ReviewedChainSetup, readSetupStatus, setupExitCode, type SetupStatus, type SetupOperation } from '../src/chain-setup.js';
import { chainSetup, chainSetupOptions, formatSetup } from '../src/commands/chain-setup.js';
const node = '0x' + 'a'.repeat(40), actor = '0x' + 'b'.repeat(40), id = 'c'.repeat(32), previous = 'd'.repeat(32);
const context = { node, provider: 'https://rpc.test', chain_id: 1, app: '/apps/knowledge' as const };
const operation = (state: SetupOperation['state'] = 'unconfirmed', key = id): SetupOperation => ({ version: 1, id: key, context, actor, state, created_at: 1, updated_at: 2, created: false, tx: null, admin: null, error: null });
const status = (op: SetupOperation | null = null, valid = false): SetupStatus => ({ version: 1, capabilities: { exact_request_status: true, reviewed_selection: true }, context: { ...context }, verification: { valid, errors: valid ? [] : ['missing'] }, read_error: null, operation: op });
function fixture(initial = status()) {
  let latest = initial, exact: SetupStatus | null = null, prompt: (v: SetupStatus, id: string, retry?: string) => Promise<void> = async () => {};
  let lost = false, failRead = false;
  const owner = { signedIn: true, isOwner: true, address: node, subject: actor }, calls: Array<{ method: string; path: string; body?: any }> = [];
  const client = {
    async get<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path }); if (path === '/api/auth/me') return structuredClone(owner) as T;
      if (path.includes('/requests/')) { if (failRead) throw new Error('read failed'); return structuredClone(exact ?? latest) as T; }
      return structuredClone(latest) as T;
    },
    async post<T>(path: string, body?: any): Promise<T> {
      calls.push({ method: 'POST', path, body }); assert.equal(path, '/api/chain/setup/requests');
      exact = status(operation('verified', body.request_id), true);
      if (lost) throw new Error('lost'); return structuredClone(exact) as T;
    },
  };
  const service = new ReviewedChainSetup(client, { requestId: () => id, recovery: key => 'chain setup --status ' + (key ?? ''), confirm: (v, key, retry) => prompt(v, key, retry) });
  return { service, owner, client, calls, value: initial, prompt: (fn: typeof prompt) => { prompt = fn; }, lose: () => { lost = true; }, unreadable: () => { failRead = true; }, latest: (value: SetupStatus) => { latest = value; }, writes: () => calls.filter(c => c.method === 'POST') };
}
test('setup reads selected server context, prompts and writes exactly one zero-stake reviewed request', async () => {
  const f = fixture(); let prompts = 0;
  f.prompt(async (value, key) => { prompts++; assert.deepEqual(value.context, context); assert.equal(key, id); });
  const result = await f.service.run(); assert.equal(result.operation?.state, 'verified'); assert.equal(prompts, 1);
  assert.deepEqual(f.writes(), [{ method: 'POST', path: '/api/chain/setup/requests', body: { request_id: id, expected: context, expected_request: null } }]);
  assert.equal(f.calls.at(-1)?.path, '/api/chain/setup/requests/' + id); assert.equal(setupExitCode(result), 0);
});
test('explicit funding, invalid IDs and contradictory read/retry options stop before any request', async () => {
  const f = fixture();
  for (const opts of [{ fund: 100 }, { requestId: 'bad' }, { retryOf: 'bad' }, { status: true, retryOf: previous }]) await assert.rejects(f.service.run(opts));
  assert.equal(f.calls.length, 0);
});
test('already matching rules and same-ID replay need no new authorization or write', async () => {
  for (const value of [status(null, true), status(operation('running')), status(operation('unconfirmed'))]) {
    const f = fixture(value); f.prompt(async () => assert.fail('no repeated prompt'));
    await f.service.run(value.operation ? { requestId: id } : {}); assert.equal(f.writes().length, 0);
  }
});
test('running or unavailable setup blocks writing, including valid rules beside an unresolved running record', async () => {
  for (const value of [status(operation('running')), status(operation('running'), true), { ...status(), verification: null, read_error: 'offline' }]) {
    const f = fixture(value); await assert.rejects(f.service.run(), (e: any) => e.exitCode === 4); assert.equal(f.writes().length, 0);
  }
});
test('retry requires the reviewed exact prior request and a distinct new ID', async () => {
  const f = fixture(status(operation('unconfirmed', previous)));
  await assert.rejects(f.service.run(), /retry selection/);
  await assert.rejects(f.service.run({ retryOf: id }), /retry selection/);
  await f.service.run({ retryOf: previous });
  assert.deepEqual(f.writes()[0].body, { request_id: id, expected: context, expected_request: previous, retry_of: previous });
  const g = fixture(status(operation('unconfirmed', previous)));
  // Reusing the prior request ID is inspection, never a retry write.
  await g.service.run({ requestId: previous, retryOf: previous }); assert.equal(g.writes().length, 0);
});
test('decline and changed owner, node, provider, selection or failed post-prompt inspection cannot submit', async () => {
  for (const change of ['decline', 'owner', 'node', 'provider', 'selection', 'offline']) {
    const f = fixture(); f.prompt(async () => {
      if (change === 'decline') throw new CliError('nothing charged', 130);
      if (change === 'owner') f.owner.subject = node;
      if (change === 'node') f.owner.address = actor;
      if (change === 'provider') f.value.context.provider = 'https://other.test';
      if (change === 'selection') f.value.operation = operation('verified', previous);
      if (change === 'offline') { f.value.verification = null; f.value.read_error = 'offline'; }
    });
    await assert.rejects(f.service.run()); assert.equal(f.writes().length, 0, change);
  }
});
test('lost write reply reads the exact stored request even when the latest pointer now names another request', async () => {
  const f = fixture(); f.lose();
  const post = f.client.post.bind(f.client);
  f.client.post = async <T>(path: string, body?: any) => { try { return await post<T>(path, body); } finally { f.latest(status(operation('unconfirmed', previous))); } };
  const result = await f.service.run(); assert.equal(result.operation?.id, id); assert.equal(result.operation?.state, 'verified'); assert.equal(f.writes().length, 1);
});
test('unreadable or foreign post-write receipt cannot report successful setup or trigger a retry', async () => {
  const f = fixture(); f.unreadable();
  await assert.rejects(f.service.run(), (e: any) => e.exitCode === 4 && e.details.request_id === id && /do not start a replacement/.test(e.message));
  assert.equal(f.writes().length, 1);
  const g = fixture(), get = g.client.get.bind(g.client);
  g.client.get = async <T>(path: string) => path.includes('/requests/') ? status(operation('verified', previous), true) as T : get<T>(path);
  await assert.rejects(g.service.run(), /unconfirmed/); assert.equal(g.writes().length, 1);
});
test('status is GET-only and validates the exact ID; malformed or unsupported responses are never accepted', async () => {
  const f = fixture(status(operation('unconfirmed'))); await f.service.run({ status: true, requestId: id }); assert.equal(f.writes().length, 0);
  await assert.rejects(f.service.status(previous), /mismatched/);
  const v = status(operation());
  for (const raw of [{ ...v, capabilities: {} }, { ...v, context: { ...context, node: actor } }, { ...v, verification: { valid: true, errors: ['missing'] } }, { ...v, operation: { ...operation(), created: 'yes' } }]) assert.equal(readSetupStatus(raw, node), null);
  const projected = readSetupStatus({ ...v, privateKey: 'secret', operation: { ...operation(), secret: 'private' } }, node)!;
  assert.doesNotMatch(JSON.stringify(projected), /secret|private/);
});
test('pending, unconfirmed and unavailable results cannot exit as successful setup', () => {
  for (const value of [status(operation('running'), true), status(operation('unconfirmed'), true), status(), { ...status(), verification: null, read_error: 'offline' }]) {
    assert.equal(setupExitCode(value), 4); assert.equal(setupExitCode(value, true), 0);
  }
  const rendered = formatSetup(status(operation('unconfirmed'), true), { nodeUrl: 'https://node.test' });
  assert.match(rendered, /Current market rules verified/); assert.match(rendered, /State: unconfirmed/); assert.match(rendered, /not transaction finality/);
});
test('actual setup parser and HTTP adapter target --node without local config, legacy endpoints, funding or offline fallback', async () => {
  const oldFetch = globalThis.fetch, oldWrite = process.stdout.write, oldCode = process.exitCode;
  const ctx: CliContext = { home: '/unused', cfg: null, nodeUrl: 'https://selected.test', nodeSource: 'flag', nodeUrlProblem: null, token: 'fake', json: true, quiet: true };
  let output = '', writes = 0, body: any;
  process.stdout.write = ((chunk: any) => { output += String(chunk); return true; }) as any;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(String(input)); assert.equal(url.origin, ctx.nodeUrl);
    if (url.pathname === '/api/auth/me') return Response.json({ signedIn: true, isOwner: true, address: node, subject: actor });
    if (init.method === 'POST') { assert.equal(url.pathname, '/api/chain/setup/requests'); writes++; body = JSON.parse(init.body); }
    return Response.json(url.pathname.includes('/requests/') ? status(operation('running')) : status());
  }) as typeof fetch;
  const parse = (args: string[]) => yargs(args).exitProcess(false).strict().fail((msg, error) => { throw error ?? new Error(msg); })
    .command('setup', '', chainSetupOptions, async args => { await chainSetup(ctx, args); }).parseAsync();
  try {
    await parse(['setup', '--request-id', id, '--yes']); assert.equal(writes, 1);
    assert.equal(body.expected_request, null); assert.equal(body.request_id, id); assert.equal(body.stake, undefined);
    assert.equal(JSON.parse(output).operation.state, 'running'); assert.equal(process.exitCode, 4);
    output = ''; await parse(['setup', '--status', '--request-id', id]); assert.equal(writes, 1); assert.equal(process.exitCode, 0);
    assert.equal(JSON.parse(output).operation.id, id);
    await assert.rejects(async () => parse(['setup', '--fund', '100']), /no longer funds/); assert.equal(writes, 1);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    await assert.rejects(async () => parse(['setup', '--yes']), /cannot reach/); assert.equal(writes, 1);
  } finally { globalThis.fetch = oldFetch; process.stdout.write = oldWrite; process.exitCode = oldCode; }
});
