/**
 * `ainize login|logout` — operator session (bearer token stored in AINIZE_HOME/cli.json).
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword, loadConfig, saveConfig, signMessage } from '@ainize/core';
import { NodeClient } from '../client.js';
import { CliError, PROG, readState, writeState, type CliContext } from '../context.js';
import { runningPid } from '../pid.js';
import { c, info, ok, shortAddr, warn } from '../output.js';

/** What a password prompt says when there is nobody to answer it — the same sentence on both paths (item 109). */
const noAnswer = (): CliError => new CliError(
  `no password given and stdin is not a terminal, so nobody can be asked — pass --password, set AINIZE_PASSWORD, or pipe one in (\`echo "…" | ${PROG} login\`). It must be at least 4 characters.`);

export async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // A pipe or a file: `echo "…" | ainize login` is read here. What was never handled is EOF — `ainize login
    // < /dev/null`, an ssh command, a cron line — where the readline callback never fires, the promise never
    // settles, and Node printed its own "Detected unsettled top-level await" and exited 13 (item 109).
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((resolve, reject) => {
      let done = false;
      rl.question(question, (a) => { if (!done) { done = true; rl.close(); resolve(a.trim()); } });
      rl.once('close', () => { if (!done) { done = true; reject(noAnswer()); } });
    });
  }
  return new Promise<string>((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const stop = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdin.off('end', onEnd); };
    const onData = (ch: string) => {
      for (const k of ch) {
        if (k === '\r' || k === '\n') { stop(); process.stdout.write('\n'); resolve(buf); return; }
        if (k === '') { stop(); process.stdout.write('\n'); process.exit(130); }
        // Ctrl-D on an empty line is the terminal's own end of input, and is answered like a closed stdin
        if (k === '' && !buf) { stop(); process.stdout.write('\n'); reject(noAnswer()); return; }
        if (k === '' || k === '\b') { buf = buf.slice(0, -1); continue; }
        buf += k;
      }
    };
    const onEnd = () => { stop(); process.stdout.write('\n'); reject(noAnswer()); };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
  });
}

/** A plain echoed prompt (a typed confirmation, not a secret). Resolves '' if stdin closes without a line. */
export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string) => { if (!done) { done = true; rl.close(); resolve(v); } };
    rl.question(question, (a) => finish(a.trim()));
    rl.once('close', () => finish(''));
  });
}

export interface LoginArgs { password?: string; setupToken?: string; key?: boolean; }

/**
 * The one-time claim token `startNode` writes while a node has no operator password (item 121). A node is claimed
 * from its own machine over loopback; from anywhere else this file — readable only by the user the node runs as —
 * is the proof of ownership. Read it from this home automatically so the local operator never has to.
 */
function localSetupToken(home: string): string | null {
  try { const p = join(home, 'setup-token'); if (!existsSync(p)) return null; const t = readFileSync(p, 'utf8').trim(); return t || null; } catch { return null; }
}

export async function login(ctx: CliContext, a: LoginArgs = {}): Promise<{ token: string; nodeUrl: string; setup: boolean }> {
  const client = new NodeClient({ ...ctx, token: null });
  const setupToken = a.setupToken ?? process.env.AINIZE_SETUP_TOKEN ?? localSetupToken(ctx.home) ?? undefined;
  const me = await client.get<{ signedIn: boolean; needsSetup: boolean; name: string; address: string }>('/api/auth/me',
    { auth: false, headers: setupToken ? { 'x-setup-token': setupToken } : {} });
  // Setting the password claims the node for good. Only ever do that to this home's own node, or to a URL the
  // user named on this command line — never to whatever happens to answer the port in the config (item 101).
  if (me.needsSetup && ctx.nodeSource !== 'flag' && ctx.nodeSource !== 'env'
      && ctx.cfg?.identity.address.toLowerCase() !== me.address.toLowerCase()) {
    throw new CliError(
      `${ctx.nodeUrl} is answered by "${me.name}" (${shortAddr(me.address, 8)}), which has no operator password yet — and it is not the node in ${ctx.home}` +
      `${ctx.cfg ? ` (${shortAddr(ctx.cfg.identity.address, 8)})` : ''}. Refusing to claim someone else's node; re-run with --node ${ctx.nodeUrl} if that is really what you want.`,
      2,
    );
  }
  /**
   * `--key` — sign in with the node's own private key instead of a password.
   *
   * The key is in `config.json`, in this very home directory, and it already owns everything this node published.
   * A password on top of it protects nothing, and it is the one shared secret in a product whose entire identity
   * model is "a key signs for itself" — so on the machine that holds the key, this is the honest path.
   *
   * It is not the default. `login` with no flags still asks for the password, because `--node` can point at a node
   * this home does not own, and silently signing with the local key would then either fail confusingly or, worse,
   * succeed against a node that happens to share the address.
   */
  const cfg = ctx.cfg ?? loadConfig(ctx.home);
  if (a.key) {
    if (me.needsSetup) throw new CliError(`${ctx.nodeUrl} has no operator yet — claim it with a password first (\`${PROG} login\`), then \`${PROG} config set operatorAddresses\` decides who else may sign with a key`);
    if (!cfg?.identity?.privateKey) throw new CliError(`no private key in ${ctx.home}/config.json — \`--key\` signs with this node's own identity, so it only works on the machine that holds it`);
    const ch = await client.post<{ nonce: string; node: string; message: string }>('/api/auth/challenge', {}, { auth: false });
    const signature = signMessage(ch.message, cfg.identity.privateKey);
    const r = await client.post<{ ok: boolean; token: string; address: string }>('/api/auth/wallet',
      { address: cfg.identity.address, nonce: ch.nonce, signature }, { auth: false });
    const st = readState(ctx.home);
    writeState(ctx.home, { ...st, token: r.token, nodeUrl: ctx.nodeUrl });
    ctx.token = r.token;
    ok(ctx, `signed in to ${ctx.nodeUrl} as ${c.id(shortAddr(r.address, 8))} ${c.dim('(signed with this node\'s key — no password)')}`);
    return { token: r.token, nodeUrl: ctx.nodeUrl, setup: false };
  }
  let password = a.password ?? process.env.AINIZE_PASSWORD;
  if (!password) {
    password = await promptPassword(me.needsSetup ? `Set an operator password for ${me.name} (${me.address.slice(0, 10)}…): ` : `Operator password for ${me.name}: `);
    // Typing a new password twice catches a typo in the one thing that cannot be typed back; a password PIPED in
    // has no second line to confirm against, so asking for one would make the setup impossible to script (item 109).
    if (me.needsSetup && process.stdin.isTTY) {
      const again = await promptPassword('Confirm password: ');
      if (again !== password) throw new CliError('passwords do not match');
    }
  }
  if (!password) throw new CliError('password required (or set AINIZE_PASSWORD)');
  const r = await client.post<{ ok: boolean; token: string }>(me.needsSetup ? '/api/auth/setup' : '/api/auth/login', { password },
    { auth: false, headers: setupToken ? { 'x-setup-token': setupToken } : {} });
  const state = readState(ctx.home);
  writeState(ctx.home, { ...state, token: r.token, nodeUrl: ctx.nodeUrl });
  ctx.token = r.token;
  ok(ctx, `${me.needsSetup ? 'operator password set and ' : ''}logged in to ${ctx.nodeUrl} ${c.dim(`(token saved in ${ctx.home}/cli.json)`)}`);
  return { token: r.token, nodeUrl: ctx.nodeUrl, setup: me.needsSetup };
}

/**
 * `ainize password` — change the operator password, and the way back when it is forgotten (item 121; review-1 item 34
 * had no route at all, so a claimed node could never be un-claimed).
 *
 * Running node  → `POST /api/auth/password` with the current password; every other session is signed out.
 * `--reset`     → the node must be stopped, and the new hash is written straight into config.json. Being able to
 *                 write that file IS the proof of ownership — it is the file holding the node's private key.
 */
export async function password(ctx: CliContext, a: { password?: string; current?: string; reset?: boolean } = {}): Promise<{ reset: boolean }> {
  const cfg = ctx.cfg ?? loadConfig(ctx.home);
  if (!cfg) throw new CliError(`no node config in ${ctx.home} — run \`${PROG} init\` first`);
  const client = new NodeClient(ctx);
  const live = await client.alive(2000);
  if (a.reset) {
    if (live || runningPid(ctx.home)) {
      throw new CliError(`--reset rewrites config.json, and the node in ${ctx.home} is running with the old password in memory — stop it first (\`${PROG} stop\`), reset, then \`${PROG} start -d\``);
    }
  } else if (!live) {
    throw new CliError(`no node is answering at ${ctx.nodeUrl}. Start it (\`${PROG} start -d\`) to change the password, or — if you have forgotten it — stop the node and run \`${PROG} password --reset\`, which rewrites the hash in ${ctx.home}/config.json`, 2);
  }
  let current = a.current ?? process.env.AINIZE_PASSWORD;
  if (!a.reset && !current) current = await promptPassword(`Current operator password for ${cfg.name}: `);
  let next = a.password ?? process.env.AINIZE_NEW_PASSWORD;
  if (!next) {
    next = await promptPassword('New operator password: ');
    const again = await promptPassword('Confirm new password: ');
    if (again !== next) throw new CliError('passwords do not match');
  }
  if (!next || next.length < 4) throw new CliError('the new password must be at least 4 characters');
  if (a.reset) {
    cfg.operatorPasswordHash = hashPassword(next);
    saveConfig(cfg, ctx.home);
    const state = readState(ctx.home);
    delete state.token;
    writeState(ctx.home, state);
    // Drop the sessions too, or a console tab signed in with the old password outlives the reset. The node is
    // stopped (checked above), so its SQLite file is ours to open.
    let dropped = 0;
    // The store is the server's (`@ainize/node`, an optional peer): loaded here, not at the top of the file, so a
    // CLI installed without it still runs every command that talks to a node over HTTP. If it is absent the reset
    // still happens — the password in config.json is what `login` checks — and the warning says what was left.
    try {
      const { Store } = await import('@ainize/node');
      const store = new Store(join(cfg.dataDir, 'node.sqlite'));
      dropped = store.deleteAllSessions();
      store.close();
    }
    catch (e) { warn(ctx, `could not sign existing sessions out (${(e as Error).message}) — sign out in the web console by hand`); }
    ok(ctx, `operator password reset in ${ctx.home}/config.json ${c.dim(`(start the node and run \`${PROG} login\`)`)}`);
    if (dropped) info(ctx, c.dim(`${dropped} existing session(s) signed out`));
    return { reset: true };
  }
  const r = await client.post<{ ok: boolean; token: string }>('/api/auth/password', { current, password: next });
  const state = readState(ctx.home);
  writeState(ctx.home, { ...state, token: r.token, nodeUrl: ctx.nodeUrl });
  ctx.token = r.token;
  ok(ctx, `operator password changed ${c.dim('(every other session was signed out; this terminal stays signed in)')}`);
  return { reset: false };
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
