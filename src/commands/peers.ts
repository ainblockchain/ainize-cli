/** `ngram peers ls|add|rm` */
import { NodeClient } from '../client.js';
import { CliError, type CliContext } from '../context.js';
import { emit, fmtTime, ok, shortAddr, table, c } from '../output.js';

export interface PeerRow { endpoint: string; address: string | null; last_seen: number; failures: number; info: { name?: string; roles?: string[] } | null; }

export async function peersLs(ctx: CliContext): Promise<PeerRow[]> {
  const d = await new NodeClient(ctx).get<{ peers: PeerRow[] }>('/api/nodes', { auth: false });
  emit(ctx, d.peers, (rows) => table(rows, [
    { key: 'ep', title: 'ENDPOINT', get: (p) => p.endpoint },
    { key: 'name', title: 'NAME', get: (p) => p.info?.name ?? c.dim('(unreached)') },
    { key: 'addr', title: 'ADDRESS', get: (p) => shortAddr(p.address, 8) },
    { key: 'roles', title: 'ROLES', get: (p) => p.info?.roles?.join(',') ?? '-' },
    { key: 'seen', title: 'LAST SEEN', get: (p) => fmtTime(p.last_seen) },
    { key: 'fail', title: 'FAILURES', get: (p) => String(p.failures), align: 'right' },
  ], 'no peers configured — `ngram peers add http://host:port`'));
  return d.peers;
}

export async function peersAdd(ctx: CliContext, endpoint: string): Promise<void> {
  if (!/^https?:\/\//.test(endpoint)) throw new CliError('endpoint must be an http(s) URL');
  await new NodeClient(ctx).post('/api/peers', { endpoint: endpoint.replace(/\/+$/, '') });
  ok(ctx, `peer added: ${endpoint}`);
}

export async function peersRm(ctx: CliContext, endpoint: string): Promise<void> {
  await new NodeClient(ctx).delete('/api/peers', { endpoint: endpoint.replace(/\/+$/, '') });
  ok(ctx, `peer removed: ${endpoint}`);
}
