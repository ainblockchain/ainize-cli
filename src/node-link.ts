import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signMessage, type NodeConfig } from '@ainize/core';
import { NodeClient } from './client.js';
import { CliError, type CliContext } from './context.js';
import { openBrowser } from './browser.js';

export const DEFAULT_WEBSITE = 'https://ainize.ai';
export interface NodeLink { url: string; token: string; owner: string; address: string; expires: number }
const statePath = (home: string) => join(home, 'node-link.json');
export function readNodeLink(home: string): NodeLink | null {
  try { return JSON.parse(readFileSync(statePath(home), 'utf8')) as NodeLink; } catch { return null; }
}
function saveNodeLink(home: string, link: NodeLink): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(statePath(home), JSON.stringify(link, null, 2) + '\n', { mode: 0o600 }); chmodSync(statePath(home), 0o600);
}

/**
 * Why this home's node may not start, or null when it may.
 *
 * A node is connected to the website before it runs: that link is what puts it under a wallet's **My nodes**,
 * and a node nobody can see there is a node nobody operates. So `start` refuses until `login` has saved a link
 * for THIS node key that has not expired — a link copied from another home, or left over from a key that was
 * re-initialised, names a different node and does not count.
 */
export function nodeLinkProblem(link: NodeLink | null, nodeAddress: string, now = Date.now()): string | null {
  if (!link) return 'this node is not connected to a wallet on the website';
  if (link.address.toLowerCase() !== nodeAddress.toLowerCase()) return `the saved website link is for another node key (${link.address}), not this one (${nodeAddress})`;
  // `expires` arrives from the website; accept seconds as well as milliseconds rather than guess wrong.
  const expiresMs = link.expires < 1e12 ? link.expires * 1000 : link.expires;
  if (expiresMs <= now) return `the website link for this node expired on ${new Date(expiresMs).toISOString()}`;
  return null;
}

/** Only a running node with the expected identity can report itself online. */
export async function nodeHeartbeat(home: string, cfg: NodeConfig): Promise<boolean> {
  const link = readNodeLink(home);
  if (!link || link.address.toLowerCase() !== cfg.identity.address.toLowerCase()) return false;
  const response = await fetch(`http://127.0.0.1:${cfg.port}/api/info`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) return false;
  const info = await response.json() as { node: { address: string; name: string; roles: string[]; version: string } };
  if (info.node.address.toLowerCase() !== link.address.toLowerCase()) return false;
  const r = await fetch(`${link.url}/api/my/nodes/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${link.token}` },
    body: JSON.stringify({ address: link.address, name: info.node.name, roles: info.node.roles, version: info.node.version }),
    signal: AbortSignal.timeout(5000),
  });
  return r.ok;
}
export function startNodeHeartbeat(home: string, cfg: NodeConfig): () => void {
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await nodeHeartbeat(home, cfg); } catch { /* next interval retries */ } finally { busy = false; } };
  void tick(); const timer = setInterval(() => { void tick(); }, 60_000); timer.unref();
  return () => clearInterval(timer);
}

export async function connectNode(ctx: CliContext, opts: { hub?: string; open?: boolean; timeoutMs?: number; label?: string } = {}) {
  const cfg = ctx.cfg;
  if (!cfg) throw new CliError('run `ainize init` before connecting a node');
  const hub = (opts.hub ?? (ctx.nodeSource === 'flag' || ctx.nodeSource === 'env' ? ctx.nodeUrl : DEFAULT_WEBSITE)).replace(/\/+$/, '');
  const parsed = new URL(hub); if (!['http:', 'https:'].includes(parsed.protocol)) throw new CliError('website must be an HTTP(S) URL');
  const client = new NodeClient({ ...ctx, nodeUrl: hub, nodeSource: 'flag', token: null });
  const ch = await client.post<{ nonce: string; message: string }>('/api/auth/challenge', {}, { auth: false });
  const proof = await client.post<{ token: string }>('/api/auth/wallet', {
    address: cfg.identity.address, nonce: ch.nonce, signature: signMessage(ch.message, cfg.identity.privateKey),
  }, { auth: false });
  let request: { code: string; poll_secret: string; interval_ms: number; expires_at: number };
  try {
    request = await client.post('/api/auth/device', { kind: 'node', delegate: cfg.identity.address, label: opts.label ?? cfg.name },
      { auth: false, headers: { authorization: `Bearer ${proof.token}` } });
  } finally {
    await client.post('/api/auth/logout', {}, { auth: false, headers: { authorization: `Bearer ${proof.token}` } }).catch(() => undefined);
  }
  const url = `${hub}/authorize?code=${encodeURIComponent(request.code)}`;
  process.stderr.write(`\nConnect this node using any wallet signed in on the website:\n${url}\nNode: ${cfg.name} (${cfg.identity.address})\nWaiting for approval…\n`);
  if (opts.open !== false) openBrowser(url);
  const deadline = Math.min(request.expires_at, Date.now() + (opts.timeoutMs ?? 10 * 60_000));
  for (;;) {
    if (Date.now() >= deadline) throw new CliError('node connection timed out; run `ainize login` for a new link');
    const claim = await client.post<{ status: string; node_link_token?: string; owner?: string; expires?: number }>(
      `/api/auth/device/${encodeURIComponent(request.code)}/claim`, { poll_secret: request.poll_secret }, { auth: false });
    if (claim.status === 'approved' && !claim.node_link_token) throw new CliError('this website does not support node links yet; update its node server');
    if (claim.status === 'approved' && claim.node_link_token && claim.owner && claim.expires) {
      saveNodeLink(ctx.home, { url: hub, token: claim.node_link_token, owner: claim.owner, address: cfg.identity.address, expires: claim.expires });
      await nodeHeartbeat(ctx.home, cfg).catch(() => false);
      if (!ctx.quiet) process.stderr.write(`Connected ${cfg.name} to ${claim.owner}.\nMy nodes: ${hub}/my-nodes\nRun \`ainize start -d\` if this node is not running yet.\n`);
      // Keep the local CLI target and operator session unchanged; this token is only a node-status credential.
      return { token: '', nodeUrl: hub, address: claim.owner, nodeAddress: cfg.identity.address, linked: true };
    }
    await new Promise(r => setTimeout(r, Math.max(500, request.interval_ms)));
  }
}
