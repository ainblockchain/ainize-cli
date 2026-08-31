/**
 * CLI + agent against a seeded in-process node (quorum 1, self-attest allowed so the node lists its own patches).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, saveConfig, type NodeConfig } from '@ngram/core';
import { startNode, seedDemo, type RunningNode } from '@ngram/node';
import { buildContext, progName, readState } from '../src/context.js';
import { chatOnce, chatPatches, renderChat, assistantTurn, type ChatResponse } from '../src/commands/chat.js';
import { login } from '../src/commands/auth.js';
import { patchLs, patchGet, patchRecords } from '../src/commands/patch.js';
import { ledgerVerify, ledgerGraph } from '../src/commands/ledger.js';
import { branchLs, route } from '../src/commands/branch.js';
import { status } from '../src/commands/node.js';
import { keysShow, configShow } from '../src/commands/init.js';
import { runAgent, creditBalance, fetchInitialCredit, pickPatch, fetchCatalog } from '../../agent/src/agent.js';
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
  cfg.verifier = { quorum: 1, stake: '5', allowSelfAttest: true, intervalMs: 300 };
  cfg.gossipIntervalMs = 60_000;
  saveConfig(cfg, home);
  node = await startNode(cfg, { home, quiet: true, serveWeb: false });
  await seedDemo(node.market, { real: false, synthetic: true });
  await waitFor(() => node.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'law-kr-2026')?.status === 'LISTED', 30000);
  ctx = buildContext({ home, node: `http://127.0.0.1:${port}`, quiet: true });
});
after(async () => { await node?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('program name follows argv[1]: ainize (product name) or the historical ngram', () => {
  assert.equal(progName('/usr/local/bin/ainize'), 'ainize');
  assert.equal(progName('/usr/local/bin/ngram'), 'ngram');
  assert.equal(progName('/repo/packages/cli/dist/bin.js'), 'ainize');   // `node dist/bin.js` → product name
  assert.equal(progName(undefined), 'ainize');
});

test('config/keys commands read the node config', () => {
  const k = keysShow(ctx);
  assert.equal(k.address, node.cfg.identity.address);
  assert.equal(k.privateKey, undefined);
  assert.equal(configShow(ctx).name, 'cli-test-node');
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
  assert.ok(res.success, lines.join('\n'));
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
  // agent cannot re-use the same payment
  const again = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', repo: join(tmp, 'no-repo'), home: agentHome }, () => undefined);
  assert.ok(again.success);   // a fresh nonce → a second (separate) purchase succeeds
  assert.equal((await node.ledger.settlements('law-kr-2026')).length, 2);
});

test('chat --list reports testable patches and the runtime state; chat refuses without a runtime', async () => {
  const d = await chatPatches(ctx);
  assert.equal(d.runtime.available, false);                       // test node points its runtime at a dead port
  assert.ok(Array.isArray(d.items));
  assert.ok(d.items.some((e) => e.anchor.id === 'law-kr-2026'));  // body is held on the seller node → testable
  assert.ok(d.items.every((e) => e.status !== 'DRAFT'));
  await assert.rejects(chatOnce(ctx, 'law-kr-2026', [{ role: 'user', content: '한국법 개정' }]), /runtime|unavailable|unreachable/i);
  await assert.rejects(chatOnce(ctx, 'law-kr-2026', [{ role: 'user', content: '   ' }]), /empty/);
});

test('renderChat prints both answers, latency / load time and the 정답 marker', () => {
  const r: ChatResponse = {
    patch_id: 'pixelplus-087600', mode: 'compare', model: 'Qwen3.8-Flash-Next', was_applied: false, applied_ms: 812, benchmark_hit: true, remaining_quota: 19,
    base: { content: '005930', latency_ms: 140, model: 'Qwen3.8-Flash-Next' },
    patched: { content: '087600', latency_ms: 151, model: 'Qwen3.8-Flash-Next', reasoning: 'look up the ticker' },
  };
  const out = renderChat(r, { thinking: true });
  for (const needle of ['before (base model)', '005930', '140 ms', 'after (pixelplus-087600 loaded)', '087600', '151 ms', 'loaded in 812 ms', '정답 ✓', 'look up the ticker', 'left this hour: 19']) assert.ok(out.includes(needle), needle);
  assert.equal(assistantTurn(r), '087600');
  const miss = renderChat({ ...r, benchmark_hit: false, base: null, applied_ms: null, was_applied: true, remaining_quota: null }, {});
  assert.ok(miss.includes('오답 ✗') && miss.includes('already loaded') && !miss.includes('before (base model)') && !miss.includes('left this hour'));
  assert.ok(renderChat({ ...r, benchmark_hit: null }).includes('no benchmark sample'));
});

test('agent balance derives the initial credit from /api/info instead of assuming 100', async () => {
  const market = `http://127.0.0.1:${port}`;
  const initial = await fetchInitialCredit(market);
  assert.equal(initial, Number(node.cfg.market.initialCredit));
  const fresh = loadIdentity(join(tmp, 'agent-fresh'));
  assert.equal(await creditBalance(market, fresh.address), initial);          // no purchases yet → the node's grant
  assert.equal(await creditBalance(market, fresh.address, 7), 7);             // explicit override still honoured
});
