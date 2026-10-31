import test from 'node:test';
import assert from 'node:assert/strict';
import yargs from 'yargs';
import { CliError, type CliContext } from '../src/context.js';
import { WalletTransfers, transferAmount, readTransferStatus, transferExitCode, type TransferReceipt, type TransferStatus } from '../src/wallet-transfers.js';
import { walletCommands } from '../src/wallet-cli.js';
import { formatTransfer, transferRecoveryCommand } from '../src/commands/wallet-transfers.js';

const node = '0x' + 'a'.repeat(40), actor = '0x' + 'b'.repeat(40), to = '0x' + 'c'.repeat(40), id = 'd'.repeat(32);
const context = { node, rpc_url: 'https://rpc.test', chain_id: 1, gas_price: 0 };
const receipt = (): TransferReceipt => ({ version: 1, id, context: { ...context }, actor, to, amount: '0.125', memo: null, currency: 'AIN', tx_hash: '0x' + 'e'.repeat(64), state: 'prepared', created_at: 1, updated_at: 1 });
function fixture(initial: TransferReceipt | null = null) {
  let value: TransferStatus = { version: 1, context: { ...context }, operation: initial, read_error: null };
  let owner = { signedIn: true, isOwner: true, address: node, subject: actor };
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let prompt: (op: TransferReceipt) => Promise<void> = async () => {}, lost = false, unreadable = false;
  const client = {
    async get<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path });
      if (path === '/api/auth/me') return structuredClone(owner) as T;
      if (unreadable) throw new Error('offline');
      return structuredClone(value) as T;
    },
    async post<T>(path: string, body?: any): Promise<T> {
      calls.push({ method: 'POST', path, body });
      if (path === '/api/me/wallet/send-requests') value.operation = { ...receipt(), id: body.request_id, amount: body.amount, memo: body.memo ?? null };
      else if (path.endsWith('/submit')) value.operation = { ...value.operation!, state: 'submitted', updated_at: 2 };
      else if (path.endsWith('/cancel')) value.operation = { ...value.operation!, state: 'cancelled', updated_at: 2 };
      else assert.fail('unexpected write ' + path);
      if (lost) throw new Error('lost response');
      return structuredClone(value) as T;
    },
  };
  const service = new WalletTransfers(client, { requestId: () => id, confirm: op => prompt(op), recovery: key => 'wallet status ' + key });
  return { service, client, calls, value, owner, writes: () => calls.filter(c => c.method === 'POST'), prompt: (fn: typeof prompt) => { prompt = fn; }, lose: () => { lost = true; }, unreadable: () => { unreadable = true; } };
}

test('decimal validation never coerces or rounds the supplied amount', () => {
  assert.equal(transferAmount('0.000001'), '0.000001'); assert.equal(transferAmount('0.125000'), '0.125');
  for (const v of ['1e3', '0x10', ' 1', '+1', '-1', '01', '0', '0.0000001', '9007199254740991.1', 1, null]) assert.equal(transferAmount(v), null, String(v));
});
test('prepare saves the exact intent and memo without prompting or submitting, including a lost reply', async () => {
  const f = fixture(); f.lose(); f.prompt(async () => assert.fail('prepare cannot authorize'));
  const result = await f.service.prepare(to, '0.125000', { memo: 'invoice' });
  assert.equal(result.operation?.memo, 'invoice'); assert.equal(result.operation?.state, 'prepared');
  assert.deepEqual(f.writes().map(c => c.path), ['/api/me/wallet/send-requests']);
  assert.equal(f.writes()[0].body.amount, '0.125');
  assert.equal(f.calls.at(-1)?.path, '/api/me/wallet/send-requests/' + id);
  await assert.rejects(f.service.prepare(to, '1'), /unresolved/); assert.equal(f.writes().length, 1);
});
test('same-ID matching preparation is read-only; changed memo is not replayed', async () => {
  const f = fixture(receipt()); await f.service.prepare(to, '0.125', { requestId: id });
  await assert.rejects(f.service.prepare(to, '0.125', { requestId: id, memo: 'changed' }), /unresolved/);
  assert.equal(f.writes().length, 0);
});
test('invalid inputs and cross-node receipts cannot cause writes', async () => {
  const f = fixture();
  await assert.rejects(f.service.prepare(to, '1e3')); await assert.rejects(f.service.prepare(to, '1', { memo: 'x'.repeat(201) }));
  await assert.rejects(f.service.history({ cursor: ['abc'] as any })); assert.equal(f.calls.length, 0);
  f.value.context.node = to; await assert.rejects(f.service.prepare(to, '1'), /mismatched/); assert.equal(f.writes().length, 0);
});
test('review rechecks the owner, chain and immutable intent before any submission', async () => {
  for (const change of ['owner', 'chain', 'recipient', 'memo', 'hash']) {
    const f = fixture(receipt());
    f.prompt(async op => {
      assert.equal(op.to, to); assert.equal(op.amount, '0.125');
      if (change === 'owner') f.owner.subject = to;
      if (change === 'chain') f.value.context.chain_id = 2;
      if (change === 'recipient') f.value.operation!.to = actor;
      if (change === 'memo') f.value.operation!.memo = 'changed';
      if (change === 'hash') f.value.operation!.tx_hash = '0x' + 'f'.repeat(64);
    });
    await assert.rejects(f.service.submit(id)); assert.equal(f.writes().length, 0, change);
  }
});
test('declining keeps the prepared receipt and never says money was not charged elsewhere', async () => {
  const f = fixture(receipt()); f.prompt(async () => { throw new CliError('cancelled — nothing was bought, nothing was charged', 130); });
  await assert.rejects(f.service.submit(id), (e: any) => e.exitCode === 130 && /remains saved/.test(e.message) && !/nothing was charged/.test(e.message));
  assert.equal(f.writes().length, 0);
});
test('lost submission response reads the exact request once and never resends a pending transaction', async () => {
  const f = fixture(receipt()); f.lose();
  const value = await f.service.submit(id); assert.equal(value.operation?.state, 'submitted');
  await f.service.submit(id); await f.service.cancel(id);
  assert.deepEqual(f.writes().map(c => c.path), [`/api/me/wallet/send-requests/${id}/submit`]);
  assert.equal(transferExitCode(value, 'submit'), 4); assert.equal(transferExitCode(value, 'read'), 0);
});
test('unreadable submit outcome retains ID and offers only inspection', async () => {
  const f = fixture(receipt()), post = f.client.post.bind(f.client);
  f.client.post = async <T>(path: string, body?: any) => { await post(path, body); f.unreadable(); throw new Error('lost'); };
  await assert.rejects(f.service.submit(id), (e: any) => e.exitCode === 4 && e.details.request_id === id && /do not send again/.test(e.message));
  assert.equal(f.writes().length, 1);
});
test('cancel only applies to prepared requests; already terminal records are never rewritten', async () => {
  const f = fixture(receipt()); assert.equal((await f.service.cancel(id)).operation?.state, 'cancelled');
  await f.service.cancel(id); await f.service.submit(id); assert.equal(f.writes().length, 1);
  for (const state of ['submitted', 'confirmed', 'rejected', 'cancelled'] as const) {
    const g = fixture({ ...receipt(), state }); await g.service.submit(id); await g.service.cancel(id); assert.equal(g.writes().length, 0);
  }
});
test('receipt projection excludes unknown fields and rejects private payloads, changed IDs and invalid memos', () => {
  const raw: any = { version: 1, context: { ...context, secret: 'x' }, read_error: null, operation: { ...receipt(), extra: 'x' } };
  assert.doesNotMatch(JSON.stringify(readTransferStatus(raw, node, id)), /secret|extra/);
  assert.equal(readTransferStatus(raw, node, 'f'.repeat(32)), null);
  raw.operation.memo = []; assert.equal(readTransferStatus(raw, node), null);
  raw.operation.memo = null; raw.operation.signature = 'secret'; assert.equal(readTransferStatus(raw, node), null);
});
test('history binds cursor and node, preserves ordering and rejects duplicated rows', async () => {
  const f = fixture(), get = f.client.get.bind(f.client);
  let page: any = { version: 1, context, cursor: 'page2', items: [receipt()], next_cursor: 'page3' };
  f.client.get = async <T>(path: string) => path.startsWith('/api/me/wallet/send-history?') ? (f.calls.push({ method: 'GET', path }), structuredClone(page) as T) : get<T>(path);
  const out = await f.service.history({ cursor: 'page2', limit: 1 }); assert.equal(out.next_cursor, 'page3');
  assert.equal(f.calls.at(-1)?.path, '/api/me/wallet/send-history?limit=1&cursor=page2');
  page.items = [receipt(), receipt()]; page.next_cursor = null;
  await assert.rejects(f.service.history({ cursor: 'page2', limit: 2 }), /duplicated/);
  page.items = []; page.cursor = null; await assert.rejects(f.service.history({ cursor: 'page2' }), /invalid/);
  assert.equal(f.writes().length, 0);
});
test('labels and exit codes distinguish read success, prepared, pending, rejected and finalized', () => {
  for (const state of ['prepared', 'submitted', 'confirmed', 'rejected', 'cancelled'] as const) {
    const value: TransferStatus = { version: 1, context, operation: { ...receipt(), state }, read_error: null };
    assert.equal(transferExitCode(value, 'submit'), state === 'confirmed' ? 0 : ['prepared', 'submitted'].includes(state) ? 4 : 1);
    assert.equal(transferExitCode(value, 'read'), 0);
    const rendered = formatTransfer(value, { nodeUrl: 'https://node.test' });
    assert.ok(rendered.includes(id) && rendered.includes(to));
    if (state === 'submitted') assert.match(rendered, /unconfirmed; do not send again/);
  }
  assert.equal(transferRecoveryCommand({ nodeUrl: "https://node.test/a'b" }, id), `ainize wallet status '${id}' --node 'https://node.test/a'\\''b'`);
});

const ctx: CliContext = { home: '/unused', nodeUrl: 'https://node.test', nodeSource: 'flag', nodeUrlProblem: null, token: 'fake', json: false, quiet: true, cfg: null };
test('actual wallet parser preserves decimal strings, request IDs, memo and output mode through the real HTTP adapter', async () => {
  const oldFetch = globalThis.fetch, oldWrite = process.stdout.write, oldCode = process.exitCode;
  let text = '', written: any, saved: TransferReceipt | null = null, submits = 0;
  process.stdout.write = ((chunk: any) => { text += String(chunk); return true; }) as any;
  globalThis.fetch = (async (input: any, init: any) => {
    const path = new URL(String(input)).pathname;
    assert.equal(new URL(String(input)).origin, 'https://node.test');
    assert.equal(init.headers.authorization, 'Bearer fake');
    if (path === '/api/auth/me') return Response.json({ signedIn: true, isOwner: true, address: node, subject: actor });
    if (init.method === 'POST') {
      if (path.endsWith('/submit')) { submits++; saved = { ...saved!, state: 'submitted', updated_at: 2 }; }
      else { assert.equal(path, '/api/me/wallet/send-requests'); written = JSON.parse(init.body);
        saved = { ...receipt(), id: written.request_id, amount: written.amount, memo: written.memo ?? null }; }
    }
    return Response.json({ version: 1, context, operation: saved, read_error: null });
  }) as typeof fetch;
  const parse = (args: string[], json = false) => yargs(args).exitProcess(false).strict().fail((msg, err) => { throw err ?? new Error(msg); })
    .command('wallet', '', yy => walletCommands(yy, fn => async args => { await fn({ ...ctx, json }, args); })).parseAsync();
  try {
    await parse(['wallet', 'prepare', to, '0.000001', '--memo', 'invoice', '--request-id', id]);
    assert.equal(written.amount, '0.000001'); assert.equal(written.memo, 'invoice'); assert.equal(written.request_id, id);
    assert.equal(text, id + '\n'); assert.equal(process.exitCode, 0);
    text = ''; await parse(['wallet', 'status', id], true);
    assert.equal(JSON.parse(text).operation.id, id); assert.equal(JSON.parse(text).operation.amount, '0.000001');
    for (const amount of ['1e3', '9007199254740991.1', '0x10']) await assert.rejects(parse(['wallet', 'prepare', to, amount]), /exact decimal/);
    await assert.rejects(async () => parse(['wallet', 'wat']), /Unknown/);
    text = ''; await parse(['wallet', 'submit', id, '--yes'], true);
    assert.equal(submits, 1); assert.equal(JSON.parse(text).operation.state, 'submitted'); assert.equal(process.exitCode, 4);
    await parse(['wallet', 'submit', id, '--yes']); assert.equal(submits, 1);
  } finally { globalThis.fetch = oldFetch; process.stdout.write = oldWrite; process.exitCode = oldCode; }
});

test('interactive JSON and quiet review uses stderr without hiding the prompt or contaminating stdout', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `
    await import('./src/quiet.ts');
    const { confirm } = await import('./src/output.ts');
    process.stdin.isTTY = true;
    await confirm({ json: true, quiet: true }, 'Review recipient, node and chain. Submit? [y/N]', { stderr: true });
    process.stdout.write(JSON.stringify({ approved: true }) + '\\n');
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), input: 'y\n', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { approved: true });
  assert.match(result.stderr, /Review recipient, node and chain. Submit/);
});
