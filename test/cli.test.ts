/**
 * CLI + agent against a seeded in-process node (quorum 1, self-attest allowed so the node lists its own patches).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, saveConfig, teachConfig, writeNpz, type NodeConfig } from '@ainize/core';
import { startNode, seedDemo, type RunningNode } from '@ainize/node';
import { buildContext, CliError, progName, readState } from '../src/context.js';
import { chatOnce, chatPatches, renderChat, assistantTurn, parsePatchIds, type ChatResponse } from '../src/commands/chat.js';
import { login } from '../src/commands/auth.js';
import { patchLs, patchGet, patchRecords, patchPublish, patchImport, patchForget, draftFromRecipe, parseContributors, type LessonRecipe } from '../src/commands/patch.js';
import { teachStatus, renderTeachStatus, parseTeachTarget, parseTeacherKey, signedTeachHeader, teachAuthHeader, loadTeacherKey, TEACH_KEY_FILE } from '../src/commands/teach.js';
import { datasetGet, datasetLs, datasetRm, datasetUpload, ensureTeacherKey, renderDatasetGet, renderDatasetList, renderJobCreated, renderJobs, renderUpload, teachJobs, teachTrain } from '../src/commands/teach-dataset.js';
import { datasetGetPublished, renderPublishedDataset } from '../src/commands/dataset.js';
import { ledgerVerify, ledgerGraph } from '../src/commands/ledger.js';
import { branchLs, route, wallet, payoutsLs, payoutRetry, renderPayoutSummary, type WalletResponse } from '../src/commands/branch.js';
import { logs, status } from '../src/commands/node.js';
import { keysShow, configShow } from '../src/commands/init.js';
import { runAgent, creditBalance, fetchInitialCredit, pickPatch, fetchCatalog, checkRequirement, exitCodeFor, readPurchases, spentToday, agentBalance, sellerError, newestOnTrack, watchAgent } from '../../agent/src/agent.js';
import { loadIdentity } from '../../agent/src/identity.js';

const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 20000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (pred(v) || Date.now() - t0 > ms) return v; await sleep(200); }
}

const tmp = mkdtempSync(join(tmpdir(), 'ngram-cli-test-'));
const home = join(tmp, 'home');
const agentHome = join(tmp, 'agent');
let node: RunningNode;
let port: number;
let ctx: ReturnType<typeof buildContext>;

before(async () => {
  port = await freePort();
  const cfg: NodeConfig = defaultConfig({ home, name: 'cli-test-node', port, ledger: 'local', roles: ['seller', 'verifier'] });
  cfg.host = '127.0.0.1';
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300 };
  cfg.gossipIntervalMs = 60_000;
  // teach mode on, stub trainer, offline stub (no model server in this test) — for `ainize teach status` / `patch import`
  cfg.teach = { ...teachConfig(cfg), enabled: true, publish: 'auto', backend: 'stub', stubOffline: true, jobsPerKeyPerDay: 10, jobsPerIpPerDay: 50 };
  saveConfig(cfg, home);
  node = await startNode(cfg, { home, quiet: true, serveWeb: false });
  await seedDemo(node.market, { real: false, synthetic: true });
  await waitFor(() => node.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'law-kr-2026')?.status === 'LISTED', 30000);
  ctx = buildContext({ home, node: `http://127.0.0.1:${port}`, quiet: true });
});
after(async () => { await node?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('the binary has one name: ainize, and the withdrawn `ngram` alias resolves to it', () => {
  assert.equal(progName('/usr/local/bin/ainize'), 'ainize');
  // Item 110: `ngram` was the historical name and fourteen hints still printed it. The alias is gone from
  // `bin`, so nothing installs it — and anyone who kept a shim pointing here is told the product name back.
  assert.equal(progName('/usr/local/bin/ngram'), 'ainize');
  assert.equal(progName('/repo/packages/cli/dist/bin.js'), 'ainize');   // `node dist/bin.js` → product name
  assert.equal(progName(undefined), 'ainize');
});

test('config/keys commands read the node config', async () => {
  const k = await keysShow(ctx);
  assert.equal(k.address, node.cfg.identity.address);
  assert.equal(k.privateKey, undefined);
  assert.equal((await configShow(ctx)).name, 'cli-test-node');
});

test('status reaches the node', async () => {
  const s = await status(ctx);
  assert.equal(s.node.address, node.cfg.identity.address);
  assert.equal(s.ledger.kind, 'local');
});

test('login performs first-time setup and stores a bearer token', async () => {
  const r = await login(ctx, { password: 'test-pass-1234' });
  assert.ok(r.setup);
  assert.ok(r.token.length > 20);
  assert.equal(readState(home).token, r.token);
  // second login uses the password
  const ctx2 = buildContext({ home, node: `http://127.0.0.1:${port}`, quiet: true });
  ctx2.token = null;
  const r2 = await login(ctx2, { password: 'test-pass-1234' });
  assert.ok(!r2.setup);
  await assert.rejects(login({ ...ctx2, token: null }, { password: 'wrong' }));
});

test('patch ls / get / records', async () => {
  const items = await patchLs(ctx, { status: 'LISTED' });
  assert.ok(items.some((e) => e.anchor.id === 'law-kr-2026'));
  const mine = await patchLs(ctx, { mine: true });
  assert.ok(mine.length >= 4);
  const d = await patchGet(ctx, 'law-kr-2026');
  assert.equal(d.lineage.parents[0]?.id, 'law-kr-2025');
  assert.ok(d.owned);
  assert.ok(d.quorum_ok);
  const recs = await patchRecords(ctx, 'law-kr-2026');
  assert.ok(recs.some((r) => r.kind === 'anchor') && recs.some((r) => r.kind === 'attest'));
});

test('ledger verify / graph, branches and routing', async () => {
  const v = await ledgerVerify(ctx);
  assert.ok(v.valid, v.errors.join(','));
  const g = await ledgerGraph(ctx);
  assert.ok(g.edges.some((e) => e.type === 'extends' && e.from === 'law-kr-2026' && e.to === 'law-kr-2025'));
  const b = await branchLs(ctx);
  assert.ok(b.branches.some((x) => x.name === 'law/KR'));
  const r = await route(ctx, ['jurisdiction=US']);
  assert.equal(r.branch?.name, 'law/US');
});

test('agent: picks a patch, pays with local-credit over 402, downloads and verifies the body', async () => {
  const market = `http://127.0.0.1:${port}`;
  const items = await fetchCatalog(market);
  assert.equal(pickPatch(items, '한국법 개정 2026')?.anchor.id, 'law-kr-2026');
  const id = loadIdentity(agentHome);
  const before = await creditBalance(market, id.address);
  const lines: string[] = [];
  const res = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', repo: join(tmp, 'no-repo'), home: agentHome }, (l) => lines.push(l));
  // Item 284: the purchase loop completed and no model has the knowledge — `downloaded`, not `success`.
  assert.equal(res.outcome, 'downloaded', lines.join('\n'));
  assert.equal(res.scheme, 'local-credit');
  assert.equal(res.patch_id, 'law-kr-2026');
  assert.ok(res.path && existsSync(res.path));
  assert.equal(res.sha256, items.find((e) => e.anchor.id === 'law-kr-2026')!.anchor.patch_sha256);
  assert.ok(lines.some((l) => l.includes('402 Payment Required')));
  const after = await waitFor(() => creditBalance(market, id.address), (b) => b < before);
  assert.equal(Math.round((before - after) * 1000) / 1000, 2.5);
  // the seller recorded the settlement
  const setts = await node.ledger.settlements('law-kr-2026');
  assert.equal(setts.length, 1);
  assert.equal(setts[0].body.buyer, id.address);
  // Item 231: the SECOND run of the same command pays nothing — the receipt in purchases.jsonl is checked before
  // the gateway is touched. (It used to buy again on a fresh nonce, so a cron line was a standing order.)
  const lines2: string[] = [];
  const again = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', repo: join(tmp, 'no-repo'), home: agentHome }, (l) => lines2.push(l));
  assert.ok(again.owned, lines2.join('\n'));
  assert.equal((await node.ledger.settlements('law-kr-2026')).length, 1, 'no second settlement: the agent knew it owned it');
  assert.equal(Math.round((await creditBalance(market, id.address)) * 1000) / 1000, Math.round(after * 1000) / 1000);
  // …and --repay is the deliberate second purchase.
  const repaid = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', repo: join(tmp, 'no-repo'), home: agentHome, repay: true }, () => undefined);
  assert.ok(!repaid.owned);
  assert.equal((await node.ledger.settlements('law-kr-2026')).length, 2);
});

test('agent: a purchase leaves a receipt the agent can read back, and a run that loaded nothing exits 3 (items 231, 284, 286)', async () => {
  const market = `http://127.0.0.1:${port}`;
  const rows = readPurchases(agentHome);
  assert.ok(rows.length >= 1, 'purchases.jsonl has the receipt');
  const r = rows.find((x) => x.patch_id === 'law-kr-2026')!;
  assert.ok(r, 'the receipt names the knowledge');
  assert.equal(r.seller, node.cfg.identity.address, 'and who was paid — the row the node itself does not store');
  assert.equal(r.asset, 'CREDIT');
  assert.ok(existsSync(r.path));
  assert.ok(spentToday(agentHome).CREDIT >= 2.5);
  // Item 284: the body is on disk and no model has it. That is not a success, and the exit code says so.
  const res = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', home: agentHome }, () => undefined);
  assert.equal(res.outcome, 'downloaded');
  assert.equal(res.success, false);
  assert.equal(exitCodeFor(res), 3);
  assert.equal(exitCodeFor(res, true), 0, '--download-only asked for exactly this');
});

test('agent: the 402 may not ask for more than the record, nor point the money elsewhere (item 290)', async () => {
  const items = await fetchCatalog(`http://127.0.0.1:${port}`);
  const e = items.find((x) => x.anchor.id === 'law-us-2025')!;
  const req = (amount: string, payTo: string) => ({
    scheme: 'local-credit' as const, network: 'local', resource: `/x402/patch/${e.anchor.id}`, description: '', mimeType: 'application/json',
    payTo, maxAmountRequired: amount, asset: 'CREDIT', nonce: 'n1', maxTimeoutSeconds: 60,
  });
  const gw = 'http://seller.example/x402';
  // the price on the record is what the agent will pay — never what a gateway asks for on top of it
  assert.throws(() => checkRequirement(req('999', e.anchor.author), e, gw), /refusing to pay more than the record/);
  // …nor a payment redirected to somebody who did not publish it
  assert.throws(() => checkRequirement(req(e.anchor.price, '0x' + '9'.repeat(40)), e, gw), /a payment to anyone but the anchor's author buys nothing/);
  // …nor anything over the budget the caller set
  assert.throws(() => checkRequirement(req(e.anchor.price, e.anchor.author), e, gw, 0.0001), /over --max-price/);
  assert.doesNotThrow(() => checkRequirement(req(e.anchor.price, e.anchor.author.toUpperCase()), e, gw));
});

test('agent: --patch with no --prompt measures the knowledge against its own benchmark, and --track names a channel (items 233, 266)', async () => {
  const market = `http://127.0.0.1:${port}`;
  const file = join(tmp, 'agent-bench.npz'); tinyNpz(file, 909n);
  const bench = join(tmp, 'agent-bench.json');
  writeFileSync(bench, JSON.stringify({ schema: 'cli-agent-bench', queries: 1, format: ['template'], samples: [{ prompt: '종목코드 스핀들 ', expect: '999999' }] }));
  await patchPublish(ctx, { file, name: 'agent bench', model: 'Qwen3.8-Flash-Next', benchmark: bench, id: 'cli-agent-bench', announce: true });
  const lines: string[] = [];
  // it is not verified (a declared benchmark needs a real run, and this node has no model), so the run stops there —
  // but the prompt and the expected value it was going to measure came from the KNOWLEDGE, not from the demo.
  await assert.rejects(runAgent({ market, patch: 'cli-agent-bench', api: 'http://127.0.0.1:1', home: join(tmp, 'agent-233') }, (l) => lines.push(l)), /not verified|quorum/);
  assert.ok(lines.some((l) => l.includes('종목코드 스핀들') && l.includes('999999')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes("cli-agent-bench's own benchmark (sample 1 of 1)")), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('픽셀플러스')), 'the Pixelplus demo has no business in a run that named a knowledge');
  // item 266: a track can be named instead of an id that goes stale overnight
  const items = await fetchCatalog(market);
  assert.equal((await newestOnTrack(market, 'law/KR', items)).anchor.id, 'law-kr-2026');
  await assert.rejects(newestOnTrack(market, 'law/NOPE', items), /no track called/);
});

test('agent watch: buys what is missing under a daily budget, never twice, and decides from its own receipts (item 287)', async () => {
  const market = `http://127.0.0.1:${port}`;
  const home = join(tmp, 'agent-watch');
  // a budget smaller than the price is a refusal, not a purchase
  const tight = await watchAgent({ market, patches: ['law-us-2025'], once: true, home, budgetPerDay: 0.5 }, () => undefined);
  assert.equal(tight[0].actions[0].action, 'over_budget');
  assert.equal(readPurchases(home).length, 0);
  // with room in the budget it buys once…
  const first = await watchAgent({ market, patches: ['law-us-2025'], once: true, home, budgetPerDay: 50 }, () => undefined);
  assert.equal(first[0].actions[0].action, 'bought');
  assert.equal(readPurchases(home).length, 1);
  assert.equal(first[0].budget_left, 48);
  // …and the next cycle knows it owns it, from its own receipt and not from asking a shared model
  const second = await watchAgent({ market, patches: ['law-us-2025'], once: true, home, budgetPerDay: 50 }, () => undefined);
  assert.equal(second[0].actions[0].action, 'owned');
  assert.equal(readPurchases(home).length, 1, 'no second purchase');
  assert.equal((await node.ledger.settlements('law-us-2025')).filter((x) => x.body.buyer === loadIdentity(home).address).length, 1);
  // a track works the same way, and an unknown one is reported rather than thrown away
  const t = await watchAgent({ market, tracks: ['law/KR', 'law/NOPE'], once: true, home, budgetPerDay: 50 }, () => undefined);
  assert.ok(t[0].actions.some((a) => a.patch_id === 'law-kr-2026'));
  assert.ok(t[0].actions.some((a) => a.patch_id === 'law/NOPE' && a.action === 'unavailable'));
  await assert.rejects(watchAgent({ market, once: true, home }, () => undefined), /needs something to watch/);
});

test('agent: a seller\'s refusal is a sentence, not a status code and a JSON blob (items 293, 294)', () => {
  assert.match(sellerError(402, '{"error":"insufficient credit: 2 < 5"}', 'node-a', 'pixel-parent', 'CREDIT'),
    /node-a refused the payment: this agent has 2 CREDIT and pixel-parent costs 5/);
  assert.match(sellerError(402, '{"error":"transfer not found on chain"}', 'node-a', 'p', 'AIN'), /could not confirm the transfer on the chain/);
  assert.match(sellerError(404, '{"error":"this node does not sell that patch"}', 'node-b', 'p', 'AIN'), /node-b does not sell p/);
  assert.match(sellerError(409, '{"error":"nonce already used"}', 'node-b', 'p', 'AIN'), /rejected the payment proof/);
  assert.match(sellerError(500, 'boom', 'node-b', 'p', 'AIN'), /node-b refused the payment \(HTTP 500\): boom/);
});

test('agent: a supersede mark does not retarget the money at 250x the price (items 232, 291)', () => {
  const mk = (id: string, price: string, status: string, supersededBy: string[] = []) => ({
    anchor: { id, price, currency: 'CREDIT', rows: 10, created_at: 1, author: '0xa', author_name: 'a', name: id, description: '', benchmark: { schema: 's' }, topic_path: 't' },
    status, superseded_by: supersededBy, downloads: 0, passed: 1, quorum: 1, quorum_ok: true, sellable: true, attestations: [],
  }) as never;
  const cheap = mk('pixelplus-087600', '0.1', 'SUPERSEDED', ['krx-all-2761']);
  const dear = mk('krx-all-2761', '25', 'LISTED');
  const items = [cheap, dear];
  const said: string[] = [];
  // default: the budget is the price of the item that was asked for → no switch, and the refusal names both prices
  const kept = pickPatch(items, '', 'pixelplus-087600', (l) => said.push(l));
  assert.equal(kept?.anchor.id, 'pixelplus-087600');
  assert.ok(said.some((l) => l.includes('0.1 → 25 CREDIT') && /NOT switching/.test(l)), said.join('\n'));
  // …and the caller who asks for the newer one at any price gets it
  const moved = pickPatch(items, '', 'pixelplus-087600', undefined, { followPrice: 'any' });
  assert.equal(moved?.anchor.id, 'krx-all-2761');
  // …and --no-follow-latest buys exactly what was named
  assert.equal(pickPatch(items, '', 'pixelplus-087600', undefined, { followLatest: false })?.anchor.id, 'pixelplus-087600');
});

test('chat --list reports testable patches and the runtime state; chat refuses without a runtime', async () => {
  const d = await chatPatches(ctx);
  assert.equal(d.runtime.available, false);                       // test node points its runtime at a dead port
  assert.ok(Array.isArray(d.items));
  assert.ok(d.items.some((e) => e.anchor.id === 'law-kr-2026'));  // body is held on the seller node → testable
  assert.ok(d.items.every((e) => e.status !== 'DRAFT'));
  await assert.rejects(chatOnce(ctx, 'law-kr-2026', [{ role: 'user', content: '한국법 개정' }]), /runtime|unavailable|unreachable/i);
  await assert.rejects(chatOnce(ctx, 'law-kr-2026', [{ role: 'user', content: '   ' }]), /empty/);
  await assert.rejects(chatOnce(ctx, 'law-kr-2026,law-kr-2025', [{ role: 'user', content: '한국법 개정' }]), /runtime|unavailable|unreachable/i);   // patch_ids path reaches the node
  assert.deepEqual(d.applied, []);
  assert.ok(Array.isArray(d.overlaps));
});

test('renderChat prints both answers, latency / load time and the correct-answer marker', () => {
  const r: ChatResponse = {
    patch_id: 'pixelplus-087600', mode: 'compare', model: 'Qwen3.8-Flash-Next', was_applied: false, applied_ms: 812, benchmark_hit: true, remaining_quota: 19,
    base: { content: '005930', latency_ms: 140, model: 'Qwen3.8-Flash-Next' },
    patched: { content: '087600', latency_ms: 151, model: 'Qwen3.8-Flash-Next', reasoning: 'look up the ticker' },
  };
  const out = renderChat(r, { thinking: true });
  for (const needle of ['before (base model)', '005930', '140 ms', 'after (pixelplus-087600 loaded)', '087600', '151 ms', 'loaded in 812 ms', 'correct ✓', 'look up the ticker', 'left this hour: 19']) assert.ok(out.includes(needle), needle);
  assert.equal(assistantTurn(r), '087600');
  const miss = renderChat({ ...r, benchmark_hit: false, base: null, applied_ms: null, was_applied: true, remaining_quota: null }, {});
  assert.ok(miss.includes('wrong ✗') && miss.includes('already loaded') && !miss.includes('before (base model)') && !miss.includes('left this hour'));
  assert.ok(renderChat({ ...r, benchmark_hit: null }).includes('no benchmark sample'));
});

test('multi-knowledge: parsePatchIds accepts a,b / repeats / caps at 3; renderChat shows load order and per-knowledge markers', () => {
  assert.deepEqual(parsePatchIds('krx-all-2761,pixelplus-087600'), ['krx-all-2761', 'pixelplus-087600']);
  assert.deepEqual(parsePatchIds(['a', 'a,b', ' c ']), ['a', 'b', 'c']);
  assert.throws(() => parsePatchIds('a,b,c,d'), /at most 3/);
  assert.throws(() => parsePatchIds(''), /patch id required/);
  const r: ChatResponse = {
    patch_id: 'krx-all-2761', patch_ids: ['krx-all-2761', 'pixelplus-087600'], mode: 'compare', model: 'Qwen3.8-Flash-Next', was_applied: false, applied_ms: 1500, benchmark_hit: true, remaining_quota: 18,
    applied: [{ patch_id: 'krx-all-2761', applied_ms: 1200, was_applied: false }, { patch_id: 'pixelplus-087600', applied_ms: 300, was_applied: false }],
    benchmark_hits: { 'krx-all-2761': true, 'pixelplus-087600': null },
    base: { content: '005930', latency_ms: 140, model: 'Qwen3.8-Flash-Next' },
    patched: { content: '087600', latency_ms: 151, model: 'Qwen3.8-Flash-Next' },
  };
  const out = renderChat(r);
  for (const needle of ['after (2 knowledges loaded)', '1. krx-all-2761 (loaded in 1200 ms)', '2. pixelplus-087600 (loaded in 300 ms)', 'krx-all-2761', 'correct ✓', 'no benchmark sample']) assert.ok(out.includes(needle), needle);
});

test('agent balance derives the initial credit from /api/info instead of assuming 100', async () => {
  const market = `http://127.0.0.1:${port}`;
  const initial = await fetchInitialCredit(market);
  assert.equal(initial, Number(node.cfg.market.initialCredit));
  const fresh = loadIdentity(join(tmp, 'agent-fresh'));
  assert.equal(await creditBalance(market, fresh.address), initial);          // no purchases yet → the node's grant
  assert.equal(await creditBalance(market, fresh.address, 7), 7);             // explicit override still honoured
});

test('wallet shows pending royalty payouts; payouts ls / retry drive the node endpoints (fake chain wallet)', async () => {
  // pre-payouts nodes: no field → no lines
  assert.deepEqual(renderPayoutSummary({ kind: 'local', address: '0x', balance: 1, sales: [], royalties: [], purchases: 0, network: 'local' }), []);
  const creator = '0x2222222222222222222222222222222222222222';
  const calls: string[] = [];
  let failing = true;
  node.market.payouts.wallet = { async transfer(to: string, value: number) { calls.push(`${to}:${value}`); if (failing) throw new Error('chain down (fake)'); return { tx_hash: '0xtxcli' }; } };
  try {
    const [row] = node.market.payouts.enqueue({ patch_id: 'law-kr-2026', seller: node.market.address, buyer: '0x4444444444444444444444444444444444444444', amount: '10', currency: 'AIN', scheme: 'ain-transfer', tx_hash: '0xbuy', royalty: { [node.market.address]: '7', [creator]: '3' }, billing: 'per_download', created_at: Date.now() }, 'cli-settle-hash');
    const w = await wallet(ctx);
    assert.equal(w.payouts?.pending, 1);
    assert.equal(w.payouts?.items[0].id, row.id);
    const lines = renderPayoutSummary(w as WalletResponse).join('\n');
    assert.match(lines, /royalty payouts owed/); assert.match(lines, /1.*pending/); assert.match(lines, /law-kr-2026/); assert.match(lines, /ainize payouts retry/);
    const r1 = await payoutRetry(ctx, row.id);
    assert.equal(r1.payout.status, 'failed'); assert.equal(r1.payout.last_error, 'chain down (fake)');
    const failed = await payoutsLs(ctx, { status: 'failed' });
    assert.equal(failed.items.length, 1); assert.equal(failed.summary.failed, 1); assert.equal(failed.max_attempts, 20); assert.equal(failed.wallet, true);
    failing = false;
    const r2 = await payoutRetry(ctx, row.id);
    assert.equal(r2.payout.status, 'paid'); assert.equal(r2.payout.tx_hash, '0xtxcli'); assert.equal(r2.payout.attempts, 2);
    assert.deepEqual(calls, [`${creator}:3`, `${creator}:3`]);
    assert.equal((await payoutsLs(ctx, { status: 'pending' })).items.length, 0);
    assert.equal((await wallet(ctx)).payouts?.pending, 0);
    await assert.rejects(payoutRetry(ctx, row.id));   // 409 already paid
  } finally { node.market.payouts.wallet = null; }
});

// ---------------------------------------------------------------- PR-8: CLI parity for teach mode
/** 1-row knowledge file in the trainer's layout (addrs int64, before/after float32 [1, D]). */
function tinyNpz(path: string, addr: bigint, D = 160): void {
  const a = Buffer.alloc(8); a.writeBigInt64LE(addr);
  const before = Buffer.alloc(4 * D); const after = Buffer.alloc(4 * D); for (let i = 0; i < D; i++) after.writeFloatLE(0.02, 4 * i);
  writeNpz(path, [{ name: 'addrs', descr: '<i8', shape: [1], body: a }, { name: 'before', descr: '<f4', shape: [1, D], body: before }, { name: 'after', descr: '<f4', shape: [1, D], body: after }]);
}

test('publish --contributor addr:name:share parses and lands on the draft anchor (declared proof)', async () => {
  const alice = '0x1111111111111111111111111111111111111111';
  assert.equal(parseContributors(undefined), undefined);
  assert.deepEqual(parseContributors([`${alice}:Alice Kim:0.7`]), [{ address: alice, share: 0.7, role: 'data_provider', proof: 'declared', name: 'Alice Kim' }]);
  assert.deepEqual(parseContributors([`${alice}:0.5`]), [{ address: alice, share: 0.5, role: 'data_provider', proof: 'declared' }]);
  assert.equal(parseContributors([`${alice}:a:b:c:25%`])![0].name, 'a:b:c');          // name may contain colons; share accepts a percentage
  assert.equal(parseContributors([`${alice}:a:b:c:25%`])![0].share, 0.25);
  assert.throws(() => parseContributors(['nope:0.5']), CliError);
  assert.throws(() => parseContributors([`${alice}:x:1.5`]), CliError);
  assert.throws(() => parseContributors([`${alice}:x:0.6`, `0x2222222222222222222222222222222222222222:y:0.6`]), CliError);   // Σ > 1
  const file = join(tmp, 'contrib.npz'); tinyNpz(file, 77n);
  const bench = join(tmp, 'bench.json'); writeFileSync(bench, JSON.stringify({ schema: 'cli-contrib', queries: 1, format: ['template'], samples: [{ prompt: 'Q: c?\nA: ', expect: 'd' }] }));
  const r = await patchPublish(ctx, { file, name: 'contrib test', model: 'Qwen3.8-Flash-Next', benchmark: bench, id: 'cli-contrib', announce: false, contributor: [`${alice}:Alice:0.7`, '0x2222222222222222222222222222222222222222:0'] });
  assert.equal(r.announced, false);
  assert.deepEqual(r.anchor.contributors, [{ address: alice, share: 0.7, role: 'data_provider', proof: 'declared', name: 'Alice' }, { address: '0x2222222222222222222222222222222222222222', share: 0, role: 'data_provider', proof: 'declared' }]);
  assert.equal((await patchGet(ctx, 'cli-contrib')).status, 'DRAFT');
});

// ---------------------------------------------------------------- lineage L1: `ainize dataset get <knowledge>`
test('AZ-248 dataset get: the training set behind a published knowledge — public downloads to the exact bytes, derivative goes through a derive intent, private is refused with a reason (exit 3)', async () => {
  const questions = [
    { prompt: 'Who runs Freedonia?', answer: 'Rufus T. Firefly' },
    { prompt: 'What is the capital of Freedonia?', answer: 'Fredville' },
  ];
  const jsonl = join(tmp, 'freedonia-questions.jsonl');
  writeFileSync(jsonl, questions.map((q) => JSON.stringify(q)).join('\n') + '\n');
  const bench = join(tmp, 'ds-bench.json');
  writeFileSync(bench, JSON.stringify({ schema: 'cli-ds', queries: 1, format: ['template'], samples: [{ prompt: 'Q: capital?\nA: ', expect: 'Fredville' }] }));

  const mk = async (id: string, access: 'public' | 'derivative' | 'private') => {
    const file = join(tmp, `${id}.npz`); tinyNpz(file, BigInt(1000 + id.length));
    const r = await patchPublish(ctx, { file, name: `ds ${access}`, model: 'Qwen3.8-Flash-Next', benchmark: bench, id, announce: true, dataset: jsonl, datasetAccess: access, datasetLicense: 'CC-BY-4.0' });
    assert.equal(r.anchor.dataset?.rows, 2, 'the questions are pinned beside the body');
    assert.equal(r.anchor.dataset?.access, access);
    return r.anchor;
  };
  const open = await mk('cli-ds-public', 'public');

  // what it is, without downloading anything
  const view = await datasetGetPublished(ctx, 'cli-ds-public', {});
  assert.equal(view.dataset.rows, 2);
  assert.equal(view.dataset.access, 'public');
  assert.equal(view.dataset.license, 'CC-BY-4.0');
  assert.equal(view.dataset.sha256, open.dataset!.sha256);
  assert.equal(view.dataset.preview!.length, 2);
  const printed = renderPublishedDataset(view);
  for (const needle of ['training set of', 'public — anyone can download', 'CC-BY-4.0', 'Rufus T. Firefly']) assert.ok(printed.includes(needle), `missing ${needle}`);

  // -o writes the exact canonical bytes: the fingerprint on the record is recomputable from the file
  const out = join(tmp, 'got-questions.jsonl');
  const saved = await datasetGetPublished(ctx, 'cli-ds-public', { out });
  assert.equal(saved.saved!.verified, true);
  assert.equal(saved.saved!.via, 'node');
  assert.equal(createHash('sha256').update(readFileSync(out)).digest('hex'), open.dataset!.sha256);
  // …and the sha256 alone finds the knowledge that published them
  const bySha = await datasetGetPublished(ctx, open.dataset!.sha256, {});
  assert.equal(bySha.patch_id, 'cli-ds-public');

  // derivative: the rows endpoint refuses, so the CLI posts a derive intent and fetches with the token it gets back
  await mk('cli-ds-derivative', 'derivative');
  const derived = await datasetGetPublished(ctx, 'cli-ds-derivative', { out: join(tmp, 'derived.jsonl') });
  assert.equal(derived.dataset.access, 'derivative');
  assert.equal(derived.saved!.via, 'derive');
  assert.equal(derived.saved!.verified, true);

  // private: the refusal is a sentence, and the exit code says "you are not allowed", not "it broke"
  await mk('cli-ds-private', 'private');
  await assert.rejects(() => datasetGetPublished(ctx, 'cli-ds-private', {}), (e: unknown) => {
    const err = e as CliError;
    assert.match(err.message, /^dataset_private/);
    assert.match(err.message, /Only the verification questions on the record are public/);
    assert.equal(err.exitCode, 3);
    return true;
  });
});

test('logs sends the operator token, and an empty result says which filter emptied it (item 132)', async () => {
  // `draft created: cli-contrib` was written by the publish above — the operator sees it, a visitor never does
  const mine = await logs(ctx, { kind: 'patch', limit: 50 });
  assert.ok(mine.some((e) => /^draft created: cli-contrib/.test(e.message)), 'the operator sees draft lines');
  const anon = await logs({ ...ctx, token: null }, { kind: 'patch', limit: 50 });
  assert.ok(!anon.some((e) => /^draft /.test(e.message)), 'a visitor never does');
  // `level` is a floor: nothing on this node ever logged an error
  const errors = await logs(ctx, { level: 'error', limit: 50 });
  assert.deepEqual(errors, []);
  const warns = await logs(ctx, { level: 'warn', limit: 50 });
  assert.ok(warns.every((e) => e.level === 'warn' || e.level === 'error'));
});

test('teach status: target parsing, node policy, lesson status with / without the teaching key, teacher page', async () => {
  const nodeUrl = `http://127.0.0.1:${port}`;
  assert.deepEqual(parseTeachTarget(undefined, nodeUrl), { kind: 'node', nodeUrl });
  assert.deepEqual(parseTeachTarget('http://h:1/chat?teach=1', nodeUrl), { kind: 'node', nodeUrl: 'http://h:1' });
  assert.deepEqual(parseTeachTarget('http://h:1/chat?lesson=8F0C1B2A-0000-4000-8000-000000000001', nodeUrl), { kind: 'job', nodeUrl: 'http://h:1', id: '8f0c1b2a-0000-4000-8000-000000000001' });
  assert.deepEqual(parseTeachTarget('http://h:1/api/teach/jobs/8f0c1b2a-0000-4000-8000-000000000001/', nodeUrl), { kind: 'job', nodeUrl: 'http://h:1', id: '8f0c1b2a-0000-4000-8000-000000000001' });
  assert.deepEqual(parseTeachTarget('8f0c1b2a-0000-4000-8000-000000000001', nodeUrl), { kind: 'job', nodeUrl, id: '8f0c1b2a-0000-4000-8000-000000000001' });
  assert.deepEqual(parseTeachTarget('http://h:1/teacher/0x1111111111111111111111111111111111111111', nodeUrl), { kind: 'teacher', nodeUrl: 'http://h:1', address: '0x1111111111111111111111111111111111111111' });
  assert.deepEqual(parseTeachTarget('0x1111111111111111111111111111111111111111', nodeUrl), { kind: 'teacher', nodeUrl, address: '0x1111111111111111111111111111111111111111' });
  assert.throws(() => parseTeachTarget('::not a url::', nodeUrl), CliError);

  // teaching key: bare hex or the browser backup JSON; the header verifies on the node (same format as the web app)
  const id = createIdentity();
  const backup = join(tmp, 'ainize-teaching-key.json');
  writeFileSync(backup, JSON.stringify({ kind: 'ainize-teaching-key', version: 1, privateKey: id.privateKey, address: id.address, name: 'CLI Teacher', created_at: Date.now() }));
  const key = loadTeacherKey({ keyFile: backup })!;
  assert.equal(key.address, id.address); assert.equal(key.name, 'CLI Teacher');
  assert.equal(parseTeacherKey(`0x${id.privateKey}`).address, id.address);
  assert.equal(loadTeacherKey({}), null);
  assert.throws(() => parseTeacherKey('{"privateKey":"xyz"}'), CliError);

  // node view (policy)
  const pol = await teachStatus(ctx, undefined);
  assert.equal(pol.kind, 'node');
  if (pol.kind !== 'node') return;
  assert.equal(pol.policy.enabled, true); assert.equal(pol.policy.backend, 'stub'); assert.equal(pol.policy.publish, 'auto');
  assert.match(renderTeachStatus(pol), /accepting lessons/); assert.match(renderTeachStatus(pol), /publish.*auto/);

  // a lesson taught by that key (offline stub: prompt does not contain the answer → will_train)
  // request-bound v2 header (node + method + path + body hash, single-use) — the legacy teachAuthHeader() form still verifies once per route
  const facts = [{ prompt: 'What is the capital of Freedonia?', answer: 'Fredville' }];
  const postBody = JSON.stringify({ patch_ids: [], builds_on_context: false, facts, contributor: { name: 'CLI Teacher' } });
  const hdr = { 'x-ainize-auth': signedTeachHeader(key, node.market.address, 'POST', '/api/teach/jobs', postBody), 'content-type': 'application/json' };
  const created = await (await fetch(`${nodeUrl}/api/teach/jobs`, { method: 'POST', headers: hdr, body: postBody })).json() as { job: { id: string; status: string }; error?: string };
  const legacy = await fetch(`${nodeUrl}/api/teach/jobs`, { headers: { 'x-ainize-auth': teachAuthHeader(key) } });
  assert.equal(legacy.status, 200, 'legacy header still accepted');
  assert.ok(created.job?.id, `job not created: ${created.error}`);
  const jobId = created.job.id;
  const ready = await waitFor(() => teachStatus(ctx, jobId, { key: id.privateKey }), (r) => r.kind === 'job' && ['READY', 'NEEDS_MORE', 'FAILED'].includes(r.job.status), 60_000);
  assert.equal(ready.kind, 'job');
  if (ready.kind !== 'job') return;
  assert.equal(ready.job.status, 'READY', ready.job.error);
  assert.equal(ready.owner, true);
  assert.equal(ready.job.facts?.[0].answer, 'Fredville');
  assert.ok(ready.job.draft_id?.startsWith('taught-'));
  const full = renderTeachStatus(ready);
  for (const needle of ['READY', 'Freedonia', 'Fredville', 'checks', 'private draft', ready.job.draft_id!]) assert.ok(full.includes(needle), `missing ${needle}`);
  // the same lesson from a URL and without the key → status only
  const anon = await teachStatus(ctx, `${nodeUrl}/chat?lesson=${jobId}`);
  assert.equal(anon.kind, 'job');
  if (anon.kind !== 'job') return;
  assert.equal(anon.owner, false); assert.equal(anon.job.status, 'READY'); assert.equal(anon.job.facts, undefined);
  assert.match(renderTeachStatus(anon), /status only/);
  // node view with the key lists the key's lessons
  const mine = await teachStatus(ctx, nodeUrl, { keyFile: backup });
  assert.equal(mine.kind, 'node');
  if (mine.kind === 'node') assert.equal(mine.mine?.some((j) => j.id === jobId), true);
  // teacher page (no published lesson yet → empty lessons, zero earnings)
  const prof = await teachStatus(ctx, `${nodeUrl}/teacher/${id.address}`);
  assert.equal(prof.kind, 'teacher');
  if (prof.kind === 'teacher') { assert.equal(prof.profile.address.toLowerCase(), id.address.toLowerCase()); assert.equal(prof.profile.earnings.owed, '0'); assert.match(renderTeachStatus(prof), /Data provider/); }
});

test('patch import: downloaded lesson (.npz + recipe.json) becomes a private DRAFT with the recipe benchmark, origin teach, credit-only contributor', async () => {
  const dir = join(tmp, 'lesson'); const { mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'lesson-freedonia-ab12cd.npz'); tinyNpz(file, 4242n);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const teacher = '0x3333333333333333333333333333333333333333';
  // shape of GET /api/teach/jobs/:id/recipe: trainer recipe + lesson block + benchmark
  const recipe: LessonRecipe = {
    version: 1, trainer: 'stub', facts: [{ prompt: 'What is the capital of Freedonia?', answer: 'Fredville' }],
    benchmark_samples: [{ prompt: 'Q: What is the capital of Freedonia?\nA: ', expect: 'Fredville' }], model: { id_M: 'Qwen3.8-Flash-Next' }, model_id: 'Qwen3.8-Flash-Next',
    benchmark: { schema: 'taught/freedonia-ab12cd', queries: 2, format: ['template', 'chat'], collateral_bound_nat: 0.08, samples: [{ prompt: 'Q: What is the capital of Freedonia?\nA: ', expect: 'Fredville' }, { prompt: 'What is the capital of Freedonia?', expect: 'Fredville' }] },
    lesson: { job_id: '8f0c1b2a-0000-4000-8000-000000000001', draft_id: 'taught-freedonia-ab12cd', name: 'Capital of Freedonia', model_id: 'Qwen3.8-Flash-Next', sha256, rows: 1, filename: 'lesson-freedonia-ab12cd.npz',
      facts: [{ prompt: 'What is the capital of Freedonia?', answer: 'Fredville' }], contributor: { address: teacher, name: 'Teacher T' }, context_patch_ids: ['law-kr-2026'], builds_on_context: true, node: { name: 'node-t', url: 'http://localhost:3412' } },
  };
  const recipePath = join(dir, 'recipe.json'); writeFileSync(recipePath, JSON.stringify(recipe));

  // pure mapping (also covers a trainer-only recipe without the lesson block)
  const d = draftFromRecipe(file, recipe);
  assert.equal(d.id, 'taught-freedonia-ab12cd'); assert.equal(d.name, 'Capital of Freedonia'); assert.equal(d.model_id, 'Qwen3.8-Flash-Next');
  assert.equal(d.benchmark.schema, 'taught/freedonia-ab12cd'); assert.equal(d.benchmark.samples?.length, 2); assert.deepEqual(d.parents, ['law-kr-2026']);
  assert.deepEqual(d.contributors, [{ address: teacher, share: 0, role: 'data_provider', proof: 'declared', name: 'Teacher T' }]);
  const bare = draftFromRecipe('/x/lesson-plain.npz', { facts: recipe.facts, benchmark_samples: recipe.benchmark_samples, model: { id_M: 'M' } });
  assert.equal(bare.id, 'taught-plain'); assert.equal(bare.model_id, 'M'); assert.equal(bare.benchmark.schema, 'taught/plain'); assert.equal(bare.benchmark.queries, 1); assert.equal(bare.name, 'Lesson: What is the capital of Freedonia?'); assert.equal(bare.contributors, undefined);

  // wrong file for this recipe → refused before anything reaches the node
  const other = join(dir, 'lesson-other.npz'); tinyNpz(other, 4243n);
  await assert.rejects(patchImport(ctx, { file: other, recipe: recipePath }), /sha256 mismatch/);
  await assert.rejects(patchImport(ctx, { file, recipe: join(dir, 'missing.json') }), /recipe not found/);

  const r = await patchImport(ctx, { file, recipe: recipePath });
  assert.equal(r.sha_matches, true); assert.equal(r.sha256, sha256); assert.equal(r.first_prompt, 'What is the capital of Freedonia?');
  assert.equal(r.anchor.id, 'taught-freedonia-ab12cd'); assert.equal(r.anchor.origin, 'teach'); assert.equal(r.anchor.model.id_M, 'Qwen3.8-Flash-Next');
  assert.deepEqual(r.anchor.parents, ['law-kr-2026']);
  assert.equal(r.anchor.contributors?.[0].address, teacher); assert.equal(r.anchor.contributors?.[0].share, 0);
  assert.equal(r.anchor.benchmark.queries, 2); assert.deepEqual(r.anchor.benchmark.format, ['template', 'chat']);
  const detail = await patchGet(ctx, 'taught-freedonia-ab12cd');
  assert.equal(detail.status, 'DRAFT'); assert.equal(detail.has_body, true); assert.equal(detail.owned, true);
  // kept in place: the node registered the file where it is, no copy
  assert.equal(node.market.store.getDraft('taught-freedonia-ab12cd')?.file_path, file);
  // no ledger record was written for it
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/patches/taught-freedonia-ab12cd/records`)).ok, true);
  assert.equal(((await (await fetch(`http://127.0.0.1:${port}/api/patches/taught-freedonia-ab12cd/records`)).json()) as { records: unknown[] }).records.length, 0);
  // importing twice → the node refuses the duplicate id (use --id to keep both)
  await assert.rejects(patchImport(ctx, { file, recipe: recipePath }), /already exists/);
  const again = await patchImport(ctx, { file, recipe: recipePath, id: 'taught-freedonia-copy' });
  assert.equal(again.anchor.id, 'taught-freedonia-copy');
});

test('patch forget refuses to take the file out from under the other knowledge built from it (item 149)', async () => {
  // v1/v2/v3 of one knowledge are usually the same .npz re-announced: forgetting one used to delete the file for all
  const file = join(tmp, 'shared.npz'); tinyNpz(file, 987654321n);
  const bench = (schema: string) => { const p = join(tmp, `${schema}.json`); writeFileSync(p, JSON.stringify({ schema, queries: 1, format: ['template'], samples: [{ prompt: 'Q: s?\nA: ', expect: 'x' }] })); return p; };
  await patchPublish(ctx, { file, name: 'shared A', model: 'Qwen3.8-Flash-Next', benchmark: bench('cli-shared-a'), id: 'shared-a', announce: true });
  await patchPublish(ctx, { file, name: 'shared B', model: 'Qwen3.8-Flash-Next', benchmark: bench('cli-shared-b'), id: 'shared-b', announce: true });

  await assert.rejects(() => patchForget(ctx, 'shared-a'), (e: CliError) => {
    assert.match(e.message, /^shared-a shares its knowledge file with 1 other item\(s\) on this node — forgetting it stops serving them too:/);
    assert.match(e.message, /ALSO STOPS SERVING/);
    assert.match(e.message, /shared-b\s+shared B/);
    assert.match(e.message, /--all-sharing/);
    assert.equal((e.details as { also_affects: { id: string; sales: number }[] }).also_affects[0].id, 'shared-b');
    return true;
  });
  assert.equal((await patchGet(ctx, 'shared-a')).has_body, true, 'nothing was deleted by the refusal');
  assert.equal((await patchGet(ctx, 'shared-b')).has_body, true);

  const r = await patchForget(ctx, 'shared-a', { allSharing: true });
  assert.deepEqual(r.also_affects.map((x) => x.id), ['shared-b']);
  assert.equal((await patchGet(ctx, 'shared-a')).has_body, false);
  assert.equal((await patchGet(ctx, 'shared-b')).has_body, false, 'the shared file really is gone for both');
});

test('patch forget stops serving a body from this node; the record is untouched and unknown ids fail', async () => {
  const before = await patchGet(ctx, 'law-us-2025');
  assert.ok(before.has_body);
  const r = await patchForget(ctx, 'law-us-2025');
  assert.equal(r.patch_id, 'law-us-2025');
  assert.equal(r.sha256, before.anchor.patch_sha256);
  const after = await patchGet(ctx, 'law-us-2025');
  assert.equal(after.has_body, false);
  assert.equal(after.status, before.status);
  await assert.rejects(patchForget(ctx, 'does-not-exist'), /patch not found/);
  await assert.rejects(patchForget(ctx, 'law-us-2025'), /body not held by this node/);
});

// ---------------------------------------------------------------- PR-D3: the file door from the terminal (design §7.4 / §15.4)
/** A small dataset with one of every problem the preview must explain, so the report is not just "3 questions". */
const DATASET_CSV = [
  'question,answer',
  'What is the capital of Freedonia?,Fredville',
  'What is the currency of Freedonia?,Freedonian dollar',
  'What is the capital of Freedonia?,Fredville',                       // duplicate of line 2
  'What is the motto of Freedonia?,Hail Freedonia',
  'What is the currency of Freedonia?,Freedonian peso',                // contradicts line 3 → BOTH excluded
  'How many people live in Freedonia?,',                               // no answer
  `What is the anthem of Freedonia?,${'x'.repeat(240)}`,               // answer over ANSWER_MAX (200)
].join('\n') + '\n';

test('teach dataset <file>: the node reads it, every unused line is named with its source line, and the report carries the fingerprint', async () => {
  const csv = join(tmp, 'freedonia.csv');
  writeFileSync(csv, DATASET_CSV);
  const up = await datasetUpload(ctx, csv, {});
  assert.equal(up.created, true);
  assert.equal(up.dataset.source, 'upload');
  assert.equal(up.dataset.format, 'csv');
  assert.equal(up.dataset.has_header, true);
  assert.equal(up.dataset.rows, 2);                                    // capital and motto: the currency pair contradicts itself, so BOTH copies are excluded
  assert.equal(up.dataset.sha256.length, 64);
  assert.equal(up.sha256, createHash('sha256').update(readFileSync(csv)).digest('hex'));   // what was signed is what was sent
  const s = up.report.summary;
  assert.equal(s.source_rows, 7);
  assert.equal(s.accepted, 2);
  assert.deepEqual([s.duplicates, s.conflicts, s.empty, s.too_long], [1, 2, 1, 1]);
  // one entry per SOURCE line, with the 1-based line number of the file (the header is line 1)
  assert.deepEqual(up.report.rows.map((r) => [r.line, r.status]), [[2, 'ok'], [3, 'conflict'], [4, 'duplicate'], [5, 'ok'], [6, 'conflict'], [7, 'empty'], [8, 'too_long']]);
  assert.match(up.report.rows.find((r) => r.line === 4)!.detail!, /line 2/);
  assert.match(up.report.rows.find((r) => r.line === 8)!.detail!, /240 characters, 40 over the 200 limit/);
  // what the terminal actually prints: the summary, the fingerprint, and a row per problem line
  const out = renderUpload(up);
  for (const needle of [up.dataset.sha256.slice(0, 16), '2 of 7 lines will train', 'duplicate', 'conflict', 'too_long', 'the same question and answer as line 2', `teach train ${up.dataset.id}`]) {
    assert.ok(out.includes(needle), `missing ${needle}`);
  }
  assert.ok(!out.includes('Fredville'.repeat(2)));

  // the same file again → the SAME dataset, not a second copy
  const again = await datasetUpload(ctx, csv, {});
  assert.equal(again.created, false);
  assert.equal(again.dataset.id, up.dataset.id);
  assert.match(renderUpload(again), /already on this node/);
});

test('teach dataset get: the report paginates, -o downloads the canonical questions, and re-uploading them lands on the same dataset', async () => {
  const list = await datasetLs(ctx, {});
  const ds = list.items.find((d) => d.source_name === 'freedonia.csv')!;
  assert.ok(ds, 'the uploaded dataset is listed');
  assert.match(renderDatasetList(list), /freedonia|QUESTIONS/);

  const got = await datasetGet(ctx, ds.id, { rows: 200, all: true });
  assert.equal(got.dataset.id, ds.id);
  assert.equal(got.page.total, 7);
  assert.equal(got.page.summary.accepted, 2);
  assert.equal(renderDatasetGet(got, true).includes('will train'), true);
  // only the lines that were rejected
  const rejected = await datasetGet(ctx, ds.id, { status: 'rejected' });
  assert.equal(rejected.page.items.length, 5);                          // 2 contradicting + 1 duplicate + 1 without an answer + 1 too long
  assert.ok(rejected.page.items.every((r) => r.status !== 'ok' && r.status !== 'fixed'));

  // -o writes the canonical .jsonl — the bytes the fingerprint is over
  const out = join(tmp, 'freedonia.jsonl');
  const saved = await datasetGet(ctx, ds.id, { out });
  assert.equal(saved.saved!.verified, true);
  assert.equal(saved.saved!.sha256, ds.sha256);
  const lines = readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0]) as { prompt: string }).prompt, 'What is the capital of Freedonia?');
  const round = await datasetUpload(ctx, out, {});
  assert.equal(round.created, false);
  assert.equal(round.dataset.id, ds.id);
});

test('teach train <dataset-id>: the lesson names the dataset it came from; teach jobs and teach status show it', async () => {
  const ds = (await datasetLs(ctx, {})).items.find((d) => d.source_name === 'freedonia.csv')!;
  const r = await teachTrain(ctx, ds.id, { effort: 'quick', name: 'Freedonia facts' });
  assert.equal(r.dataset_id, ds.id);
  assert.equal(r.job.dataset?.id, ds.id);
  assert.equal(r.job.dataset?.sha256, ds.sha256);
  assert.equal(r.job.dataset?.trained_rows, 2);
  assert.equal(r.job.training?.effort, 'quick');
  assert.equal(r.job.facts?.length, 2);
  assert.ok((r.quota?.rows_remaining ?? 0) > 0);
  assert.match(renderJobCreated(r, r.node), /2 of 2 in the dataset/);

  const ready = await waitFor(() => teachStatus(ctx, r.job.id, { key: undefined }), (x) => x.kind === 'job' && ['READY', 'NEEDS_MORE', 'FAILED'].includes(x.job.status), 60_000);
  assert.equal(ready.kind, 'job');
  if (ready.kind !== 'job') return;
  assert.equal(ready.job.status, 'READY', ready.job.error);
  assert.equal(ready.job.owner ?? true, true);
  // `teach status <lesson>` says what it was trained on and how to get those questions back
  const text = renderTeachStatus(ready);
  for (const needle of ['dataset', ds.sha256.slice(0, 12), 'trained 2 of 2 questions', `teach dataset get ${ds.id}`, 'effort', 'quick']) assert.ok(text.includes(needle), `missing ${needle}`);

  const jobs = await teachJobs(ctx, {});
  const mine = jobs.items.find((j) => j.id === r.job.id)!;
  assert.equal(mine.dataset?.id, ds.id);
  assert.equal(jobs.items.length, (await teachJobs(ctx, { dataset: ds.id })).items.length + jobs.items.filter((j) => j.dataset?.id !== ds.id).length);
  assert.match(renderJobs(jobs), /DATASET/);
});

test('teach train <file>: a path is uploaded first, so one command goes from a file on disk to a lesson', async () => {
  const file = join(tmp, 'two-facts.jsonl');
  writeFileSync(file, [
    JSON.stringify({ prompt: 'Who founded Freedonia?', answer: 'Rufus T. Firefly' }),
    JSON.stringify({ instruction: 'What is the Freedonian flag?', output: 'A blue field' }),      // alpaca keys are accepted
  ].join('\n') + '\n');
  const r = await teachTrain(ctx, file, { effort: 'quick' });
  assert.ok(r.uploaded, 'the file was uploaded first');
  assert.equal(r.uploaded!.dataset.rows, 2);
  assert.equal(r.uploaded!.dataset.format, 'jsonl');
  assert.equal(r.job.dataset?.id, r.uploaded!.dataset.id);
  assert.equal(r.job.facts?.[1].prompt, 'What is the Freedonian flag?');
  // a dataset that a lesson is training from cannot be deleted; once it is over, it can
  const done = await waitFor(() => teachStatus(ctx, r.job.id, {}), (x) => x.kind === 'job' && ['READY', 'NEEDS_MORE', 'FAILED'].includes(x.job.status), 60_000);
  assert.equal(done.kind === 'job' && done.job.status, 'READY');
  const del = await datasetRm(ctx, r.uploaded!.dataset.id, {});
  assert.equal(del.deleted, r.uploaded!.dataset.id);
  // the lesson still renders — it just says the questions are gone (design G5 / §11)
  const after = await teachStatus(ctx, r.job.id, {});
  assert.equal(after.kind === 'job' && after.job.dataset?.deleted, true);
  assert.match(renderTeachStatus(after), /deleted by its owner/);
  const tomb = await datasetGet(ctx, r.uploaded!.dataset.id, {});
  assert.ok(tomb.dataset.deleted_at, 'the tombstone still explains itself');
  assert.equal(tomb.page.items.length, 0);                              // the questions really are gone
  assert.match(renderDatasetGet(tomb, false), /they were deleted/);
});

test('the teaching key: kept in <home>/teaching-key.json, created once, never re-minted, and --key-file still wins', () => {
  const keyPath = join(home, TEACH_KEY_FILE);
  assert.ok(existsSync(keyPath), 'the first dataset command created the key');
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  const first = ensureTeacherKey(ctx);
  assert.equal(first.created, false);                                   // never a second identity for the same home
  assert.equal(first.path, keyPath);
  assert.equal(ensureTeacherKey(ctx).key.address, first.key.address);
  const backup = JSON.parse(readFileSync(keyPath, 'utf8')) as { kind: string; privateKey: string; address: string };
  assert.equal(backup.kind, 'ainize-teaching-key');                     // the same file format the browser downloads
  assert.equal(backup.address, first.key.address);
  // an explicit key wins over the stored one
  const other = createIdentity();
  assert.equal(ensureTeacherKey(ctx, { key: other.privateKey }).key.address, other.address);
  // a fresh home mints one, exactly once
  const freshHome = join(tmp, 'fresh-teacher');
  const made = ensureTeacherKey({ ...ctx, home: freshHome });
  assert.equal(made.created, true);
  assert.equal(ensureTeacherKey({ ...ctx, home: freshHome }).created, false);
  assert.notEqual(made.key.address, first.key.address);
});
