/**
 * `ngram login|logout` — operator session (bearer token stored in NGRAM_HOME/cli.json).
 */
import { createInterface } from 'node:readline';
import { NodeClient } from '../client.js';
import { CliError, readState, writeState, type CliContext } from '../context.js';
import { c, ok } from '../output.js';

export async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch: string) => {
      for (const k of ch) {
        if (k === '\r' || k === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(buf); return; }
        if (k === '') { process.stdout.write('\n'); process.exit(130); }
        if (k === '' || k === '\b') { buf = buf.slice(0, -1); continue; }
        buf += k;
      }
    };
    stdin.on('data', onData);
  });
}

export interface LoginArgs { password?: string; }

export async function login(ctx: CliContext, a: LoginArgs = {}): Promise<{ token: string; nodeUrl: string; setup: boolean }> {
  const client = new NodeClient({ ...ctx, token: null });
  const me = await client.get<{ signedIn: boolean; needsSetup: boolean; name: string; address: string }>('/api/auth/me', { auth: false });
  let password = a.password ?? process.env.NGRAM_PASSWORD;
  if (!password) {
    password = await promptPassword(me.needsSetup ? `Set an operator password for ${me.name} (${me.address.slice(0, 10)}…): ` : `Operator password for ${me.name}: `);
    if (me.needsSetup) {
      const again = await promptPassword('Confirm password: ');
      if (again !== password) throw new CliError('passwords do not match');
    }
  }
  if (!password) throw new CliError('password required (or set NGRAM_PASSWORD)');
  const r = await client.post<{ ok: boolean; token: string }>(me.needsSetup ? '/api/auth/setup' : '/api/auth/login', { password }, { auth: false });
  const state = readState(ctx.home);
  writeState(ctx.home, { ...state, token: r.token, nodeUrl: ctx.nodeUrl });
  ctx.token = r.token;
  ok(ctx, `${me.needsSetup ? 'operator password set and ' : ''}logged in to ${ctx.nodeUrl} ${c.dim(`(token saved in ${ctx.home}/cli.json)`)}`);
  return { token: r.token, nodeUrl: ctx.nodeUrl, setup: me.needsSetup };
}

export async function logout(ctx: CliContext): Promise<void> {
  const client = new NodeClient(ctx);
  if (ctx.token) { try { await client.post('/api/auth/logout'); } catch { /* ignore */ } }
  const state = readState(ctx.home);
  delete state.token;
  writeState(ctx.home, state);
  ctx.token = null;
  ok(ctx, 'logged out');
}
