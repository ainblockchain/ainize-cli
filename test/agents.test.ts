/**
 * `ainize agent` against a temp home and a stub agent process.
 *
 * The registry half (add/rm/on/off) is config arithmetic and is checked by reading the file the node will read;
 * the call half is checked against a stub that answers JSON-RPC the way an A2A agent does, including the two
 * replies that are easy to get wrong: a silent one, and one carrying A2UI parts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, saveConfig, type NodeConfig } from '@ainize/core';
import { buildContext, CliError } from '../src/context.js';
import { agentAdd, agentCall, agentEnable, agentLs, agentRm } from '../src/commands/agents.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-agent-test-'));
const home = join(tmp, 'home');

let nodeStub: Server;
let nodeUrl = '';
/** What the stub node was asked for, so `call` can be checked on the wire rather than on its return value. */
let lastCall: { path: string; body: any } | null = null;
let reply: any = null;

const ctx = () => buildContext({ home, node: nodeUrl, quiet: true });

before(async () => {
  const cfg: NodeConfig = { ...defaultConfig({ dataDir: join(tmp, 'data') }), ...createIdentity() } as NodeConfig;
  saveConfig(cfg, home);

  nodeStub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/agents') {
        return res.end(JSON.stringify({ agents: [{
          id: 'donga-desk', name: 'desk', description: null,
          skills: [{ id: 'pipeline-status', name: '현황', tags: [], examples: ['상태?'] }],
          protocols: ['0.3.0'], extensions: ['https://a2ui.org/a2a-extension/a2ui/v0.9'],
          provider: null, documentation_url: null,
          a2a_url: `${nodeUrl}/agents/donga-desk`, card_url: `${nodeUrl}/agents/donga-desk/.well-known/agent-card.json`,
          reachable: true, last_checked: Date.now(), error: null, calls: 0, last_call_at: null,
        }] }));
      }
      if (req.url?.endsWith('/.well-known/agent-card.json')) {
        return res.end(JSON.stringify({ name: 'desk', capabilities: { streaming: true }, skills: [] }));
      }
      lastCall = { path: req.url ?? '', body: body ? JSON.parse(body) : null };
      return res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => { nodeStub = nodeStub.listen(0, '127.0.0.1', r); });
  nodeUrl = `http://127.0.0.1:${(nodeStub.address() as any).port}`;
});

after(() => { nodeStub.close(); rmSync(tmp, { recursive: true, force: true }); });

const agentsInConfig = () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).agents ?? [];

test('add writes the entry the node reads', async () => {
  await agentAdd(ctx(), 'donga-desk', { upstream: 'http://127.0.0.1:9200/', name: 'desk' });
  const agents = agentsInConfig();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'donga-desk');
  assert.equal(agents[0].upstream, 'http://127.0.0.1:9200', 'the trailing slash would double up in every proxied path');
  assert.equal(agents[0].enabled, undefined, 'absent means published — only --disabled writes the key');
});

test('add refuses an id that cannot be a URL segment', async () => {
  await assert.rejects(() => agentAdd(ctx(), 'Donga Desk', { upstream: 'http://x:1' }), CliError);
});

test('add refuses an upstream that is not a URL, and names the likely typo', async () => {
  await assert.rejects(
    () => agentAdd(ctx(), 'other', { upstream: 'localhost:9200' }),
    (e: Error) => e.message.includes('http://localhost:9200'),
  );
});

test('add refuses to register the same id twice', async () => {
  await assert.rejects(() => agentAdd(ctx(), 'donga-desk', { upstream: 'http://127.0.0.1:9201' }), CliError);
  assert.equal(agentsInConfig().length, 1, 'the existing entry must not be touched');
});

test('off and on flip publication without losing the registration', async () => {
  await agentEnable(ctx(), 'donga-desk', false);
  assert.equal(agentsInConfig()[0].enabled, false);
  assert.equal(agentsInConfig().length, 1);
  await agentEnable(ctx(), 'donga-desk', true);
  assert.equal(agentsInConfig()[0].enabled, true);
});

test('on refuses an id this home does not have', async () => {
  await assert.rejects(() => agentEnable(ctx(), 'nope', true), CliError);
});

test('ls renders what the node computed', async () => {
  const rows = await agentLs(ctx());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'donga-desk');
});

test('call posts JSON-RPC message/send to the public path', async () => {
  reply = { jsonrpc: '2.0', id: '1', result: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: '현황입니다' }] } };
  await agentCall(ctx(), 'donga-desk', '오늘 상태 알려줘');
  assert.equal(lastCall?.path, '/agents/donga-desk');
  assert.equal(lastCall?.body.method, 'message/send');
  assert.equal(lastCall?.body.params.message.parts[0].text, '오늘 상태 알려줘');
  assert.equal(lastCall?.body.params.message.role, 'user');
});

test('call reads the text out of a completed status-update too', async () => {
  reply = { jsonrpc: '2.0', id: '1', result: { kind: 'status-update', final: true, status: { state: 'completed',
    message: { kind: 'message', role: 'agent', parts: [
      { kind: 'text', text: '표입니다' },
      { kind: 'data', data: { createSurface: {} }, metadata: { mimeType: 'application/json+a2ui' } },
    ] } } } };
  const out: any = await agentCall(ctx(), 'donga-desk', '표로 줘');
  assert.equal(out.result.status.message.parts.length, 2);
});

test('an agent that chose not to answer is silence, not an error', async () => {
  reply = { jsonrpc: '2.0', id: '1', result: { kind: 'message', role: 'agent', parts: [] } };
  await agentCall(ctx(), 'donga-desk', '아무 말도 하지 마');
});

test('a JSON-RPC error is reported as a refusal, with the node body kept', async () => {
  reply = { jsonrpc: '2.0', id: '1', error: { code: -32603, message: 'upstream timeout' } };
  await assert.rejects(
    () => agentCall(ctx(), 'donga-desk', '실패해줘'),
    (e: CliError) => e.message.includes('upstream timeout') && (e.details as any).code === -32603,
  );
});

test('call refuses an empty prompt rather than sending one', async () => {
  await assert.rejects(() => agentCall(ctx(), 'donga-desk', '   '), CliError);
});

test('rm takes the entry out', async () => {
  await agentRm(ctx(), 'donga-desk', { yes: true });
  assert.equal(agentsInConfig().length, 0);
  await assert.rejects(() => agentRm(ctx(), 'donga-desk', { yes: true }), CliError);
});
