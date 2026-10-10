import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { NodeClient, query } from '../client.js';
import { CliError, type CliContext } from '../context.js';
import { emit } from '../output.js';

const path = (id: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new CliError('agent id must be lowercase letters, digits and dashes (max 40)');
  return `/api/hosted-agents/${id}`;
};

export async function agentClone(ctx: CliContext, id: string, directory?: string): Promise<{ directory: string; clone_url: string }> {
  await new NodeClient(ctx).get(`${path(id)}/refs`);
  const base = new URL(ctx.nodeUrl);
  if (base.username || base.password || base.search || base.hash) throw new CliError('the node URL must not contain credentials, a query or a fragment');
  const url = `${ctx.nodeUrl}/git/${id}.git`;
  const destination = resolve(directory ?? id);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(ctx.token ? {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${ctx.nodeUrl}/git/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${ctx.token}`,
  } : {}) };
  await new Promise<void>((done, reject) => {
    const child = spawn('git', ['-c', 'credential.helper=', 'clone', '--', url, destination], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-8192); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? done() : reject(new CliError(`Git clone failed: ${ctx.token ? error.split(ctx.token).join('[redacted]') : error}`)));
  });
  const result = { directory: destination, clone_url: url };
  emit(ctx, result, () => `Cloned ${id} into ${destination}\nEdit, commit, then git push to deploy main. Use your Git credential helper with an ainize API key for later pushes.`);
  return result;
}

export async function agentPulls(ctx: CliContext, id: string, opts: { state?: string; number?: number; head?: string; headAgent?: string; base?: string; title?: string; body?: string; merge?: boolean; close?: boolean } = {}): Promise<unknown> {
  const client = new NodeClient(ctx);
  const endpoint = `${path(id)}/pulls`;
  if (opts.merge && opts.close) throw new CliError('choose either --merge or --close');
  if ((opts.merge || opts.close) && (!Number.isInteger(opts.number) || opts.number! <= 0)) throw new CliError('--merge/--close needs --number');
  if (opts.head && !opts.title?.trim()) throw new CliError('creating a proposal needs --head and --title');
  const result = opts.merge ? await client.post(`${endpoint}/${opts.number}/merge`)
    : opts.close ? await client.post(`${endpoint}/${opts.number}/close`)
    : opts.head ? await client.post(endpoint, { head: opts.head, headAgent: opts.headAgent, base: opts.base ?? 'main', title: opts.title, body: opts.body ?? '' })
    : await client.get(opts.number ? `${endpoint}/${opts.number}` : endpoint + query({ state: opts.state }));
  emit(ctx, result, () => JSON.stringify(result, null, 2));
  return result;
}

export async function agentMirror(ctx: CliContext, id: string, opts: { repo?: string; branch?: string; folder?: string; sync?: boolean; detach?: boolean } = {}): Promise<unknown> {
  if ([!!opts.repo, !!opts.sync, !!opts.detach].filter(Boolean).length > 1) throw new CliError('choose one of --repo, --sync or --detach');
  const client = new NodeClient(ctx);
  const endpoint = `${path(id)}/mirror`;
  const result = opts.detach ? await client.delete(endpoint)
    : opts.sync ? await client.post(`${endpoint}/sync`)
    : opts.repo ? await client.request(endpoint, { method: 'PUT', body: { url: opts.repo, branch: opts.branch ?? 'main', path: opts.folder ?? '' } })
    : await client.get(endpoint);
  emit(ctx, result, () => JSON.stringify(result, null, 2));
  return result;
}
