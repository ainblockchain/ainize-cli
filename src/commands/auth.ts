/**
 * `ainize login|logout` — operator session (bearer token stored in AINIZE_HOME/cli.json).
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityFromPrivateKey, loadConfig, sameAddr, saveConfig, signMessage } from '@ainize/core';
import { NodeClient } from '../client.js';
import { CliError, PROG, readState, writeState, type CliContext } from '../context.js';
import { runningPid } from '../pid.js';
import { c, emit, info, ok, shortAddr, warn } from '../output.js';

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

export interface LoginArgs { setupToken?: string; enroll?: boolean; as?: string; }

/**
 * The one-time claim token `startNode` writes while a node has no operator password (item 121). A node is claimed
 * from its own machine over loopback; from anywhere else this file — readable only by the user the node runs as —
 * is the proof of ownership. Read it from this home automatically so the local operator never has to.
 */
function localSetupToken(home: string): string | null {
  try { const p = join(home, 'setup-token'); if (!existsSync(p)) return null; const t = readFileSync(p, 'utf8').trim(); return t || null; } catch { return null; }
}

export async function login(ctx: CliContext, a: LoginArgs = {}): Promise<{ token: string; nodeUrl: string; address: string }> {
  const client = new NodeClient({ ...ctx, token: null });
  const cfg = ctx.cfg ?? loadConfig(ctx.home);
  const me = await client.get<{ signedIn: boolean; canEnroll: boolean; name: string; address: string }>('/api/auth/me', { auth: false });

  /**
   * Sign in with the node's own key. There is no password: the key is in `config.json` in this home directory and
   * it already owns everything this node published, so a secret on top of it protected nothing and was the one
   * shared secret in a product whose identity model is otherwise "a key signs for itself".
   *
   * `--as <key>` signs with a different identity — a key already enrolled in `operatorAddresses`, which is how a
   * second person or a second machine signs in without holding the node's own key.
   */
  const key = a.as ?? cfg?.identity?.privateKey;
  if (!key) {
    throw new CliError(`no key to sign with: there is no config.json in ${ctx.home}, and no --as <private key> was given. `
      + `Sign-in is a signature now — on the node's own machine \`${PROG} login\` uses its identity; from anywhere else, `
      + `enrol your address first (\`${PROG} operators add <address>\` on that machine) and pass its key with --as.`, 2);
  }
  const address = identityFromPrivateKey(key).address;

  // Signing into a node this home does not own is a real thing to want (--node), and a mistake to do by accident.
  if (ctx.nodeSource !== 'flag' && ctx.nodeSource !== 'env' && cfg && !sameAddr(cfg.identity.address, me.address)) {
    throw new CliError(
      `${ctx.nodeUrl} is answered by "${me.name}" (${shortAddr(me.address, 8)}), not the node in ${ctx.home} (${shortAddr(cfg.identity.address, 8)}). `
      + `Re-run with --node ${ctx.nodeUrl} if that is really what you meant.`, 2);
  }

  const ch = await client.post<{ nonce: string; node: string; message: string }>('/api/auth/challenge', {}, { auth: false });
  const signature = signMessage(ch.message, key);
  const enrolToken = a.setupToken ?? process.env.AINIZE_SETUP_TOKEN ?? localSetupToken(ctx.home) ?? undefined;
  const body = { address, nonce: ch.nonce, signature };
  // `--enroll` adds this address to the node's operators on the way in. It needs the node's own machine or its
  // one-time token, because adding an operator is exactly as privileged as being one.
  const r = a.enroll
    ? await client.post<{ ok: boolean; token: string; address: string }>('/api/auth/enroll', body, { auth: false, headers: enrolToken ? { 'x-setup-token': enrolToken } : {} })
    : await client.post<{ ok: boolean; token: string; address: string }>('/api/auth/wallet', body, { auth: false });

  writeState(ctx.home, { ...readState(ctx.home), token: r.token, nodeUrl: ctx.nodeUrl });
  ctx.token = r.token;
  ok(ctx, `signed in to ${ctx.nodeUrl} as ${c.id(shortAddr(r.address, 8))} ${c.dim(a.enroll ? '(enrolled and signed in — no password)' : '(signed with a key — no password)')}`);
  return { token: r.token, nodeUrl: ctx.nodeUrl, address: r.address };
}

/**
 * `ainize operators` — who may sign in to this node.
 *
 * This replaces `ainize password`, which no longer has anything to change. The node's own key is an operator by
 * construction and cannot be removed; everyone else is an address in `operatorAddresses`.
 *
 * Adding one is exactly as privileged as being one, so it is written straight into config.json — being able to
 * write that file IS the proof of ownership, since it is the file holding the node's private key. That is the same
 * reasoning the old `--reset` rested on, and it is the only reasoning that never needed a password.
 */
export async function operators(ctx: CliContext, a: { add?: string; remove?: string } = {}): Promise<{ operators: string[]; node: string }> {
  const cfg = ctx.cfg ?? loadConfig(ctx.home);
  if (!cfg) throw new CliError(`no node config in ${ctx.home} — run \`${PROG} init\` first`);
  const listed = cfg.operatorAddresses ?? [];

  if (a.add) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.add)) throw new CliError(`${a.add} is not an address`);
    if (sameAddr(a.add, cfg.identity.address)) throw new CliError(`${shortAddr(a.add, 8)} is this node's own key — it is already an operator and always will be`);
    if (listed.some((x) => sameAddr(x, a.add!))) { info(ctx, `${shortAddr(a.add, 8)} is already an operator`); }
    else {
      cfg.operatorAddresses = [...listed, a.add];
      saveConfig(cfg, ctx.home);
      ok(ctx, `${c.id(shortAddr(a.add, 8))} may now sign in to this node ${c.dim('(restart it to apply: `' + PROG + ' stop` then `' + PROG + ' start -d`)')}`);
    }
  } else if (a.remove) {
    if (sameAddr(a.remove, cfg.identity.address)) throw new CliError("this node's own key cannot be removed — it is the identity everything this node published belongs to");
    const next = listed.filter((x) => !sameAddr(x, a.remove!));
    if (next.length === listed.length) throw new CliError(`${shortAddr(a.remove, 8)} is not an operator of this node`);
    cfg.operatorAddresses = next;
    saveConfig(cfg, ctx.home);
    // A removed operator keeps any session they already hold until it expires; say so rather than imply otherwise.
    ok(ctx, `${c.id(shortAddr(a.remove, 8))} removed ${c.dim('(a session they already hold lasts until it expires — restart the node to drop it)')}`);
  }

  const fresh = (ctx.cfg = loadConfig(ctx.home) ?? cfg);
  const all = [fresh.identity.address, ...(fresh.operatorAddresses ?? [])];
  emit(ctx, { operators: all, node: fresh.identity.address }, (d) => [
    `operators of ${fresh.name}`,
    ...d.operators.map((x, i) => `  ${c.id(x)}${i === 0 ? c.dim("   this node's own key") : ''}`),
  ].join('\n'));
  return { operators: all, node: fresh.identity.address };
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
