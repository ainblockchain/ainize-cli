/**
 * `ainize login|logout` — operator session (bearer token stored in AINIZE_HOME/cli.json).
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityFromPrivateKey, loadConfig, sameAddr, saveConfig, signMessage } from '@ainize/core';
import { NodeClient } from '../client.js';
import { defaultLabel, ensureCliKey, forgetCliKey, readCliKey } from '../cli-key.js';
import { CliError, PROG, readState, writeState, type CliContext } from '../context.js';
import { runningPid } from '../pid.js';
import { c, emit, info, ok, shortAddr, warn } from '../output.js';

/**
 * What a passphrase prompt says when there is nobody to answer it — the same sentence on both paths (item 109).
 *
 * There is no operator password any more and this no longer mentions one: the only secret anything still types
 * is the passphrase that encrypts a key backup, so the way out is the flag and the variable that carry it.
 */
const noAnswer = (): CliError => new CliError(
  `no passphrase given and stdin is not a terminal, so nobody can be asked — pass --passphrase, set AINIZE_KEY_PASSPHRASE, or pipe one in (\`echo "…" | ${PROG} keys backup <file>\`).`);

/** Read a secret without echoing it. The only secret left is a key-backup passphrase. */
export async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // A pipe or a file: `echo "…" | ainize keys backup out.json` is read here. What was never handled is EOF —
    // `… < /dev/null`, an ssh command, a cron line — where the readline callback never fires, the promise never
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

export interface LoginArgs { setupToken?: string; enroll?: boolean; as?: string; device?: boolean; nodeKey?: boolean; label?: string; open?: boolean; timeoutMs?: number }

/** A device request, as the node hands it back. `poll_secret` is the half that never goes in the URL. */
interface DeviceRequest { code: string; poll_secret: string; url: string; interval_ms: number; expires_at: number }
interface DeviceClaim { status: 'pending' | 'approved'; token?: string; owner?: string; delegate?: string; expires?: number; isOwner?: boolean }
interface SignInResult { ok: boolean; token: string; address: string; via_key?: string | null; isOwner?: boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `ainize login` from a machine that does not hold the node's key — which is most of them.
 *
 * The CLI has a key of its own and signs with it, but on its own that key is nobody. So it asks the node for a
 * code, prints a URL, and waits. A person opens it in a browser they are already signed into, reads which key is
 * asking and until when, and approves it with one wallet signature. The CLI then collects a session whose subject
 * is THEM — and from the next time on it signs in with its own key alone, because the node wrote the binding down.
 *
 * Nothing secret is ever printed. The URL carries a code that shows what is being asked and cannot collect the
 * session; the poll secret that can stays in this process and is never displayed, logged or written anywhere.
 */
async function deviceLogin(ctx: CliContext, a: LoginArgs, client: NodeClient): Promise<{ token: string; nodeUrl: string; address: string }> {
  const key = ensureCliKey(ctx.home);
  const label = a.label ?? readCliKey(ctx.home)?.label ?? defaultLabel();

  // First, try the key alone. If a person authorised it before — on this node, at any point — there is nothing to
  // approve and no browser to open, which is the whole reason the binding is written down rather than re-signed.
  const ch = await client.post<{ nonce: string; message: string }>('/api/auth/challenge', {}, { auth: false });
  const direct = await client.post<SignInResult>('/api/auth/wallet',
    { address: key.address, nonce: ch.nonce, signature: signMessage(ch.message, key.privateKey) }, { auth: false });
  if (direct.via_key) {
    finishLogin(ctx, direct.token, direct.address);
    ok(ctx, `signed in to ${ctx.nodeUrl} as ${c.id(shortAddr(direct.address, 8))} ${c.dim(`(this machine's key, authorised earlier)`)}`);
    return { token: direct.token, nodeUrl: ctx.nodeUrl, address: direct.address };
  }

  const req = await client.post<DeviceRequest>('/api/auth/device', { delegate: key.address, label }, { auth: false });
  /**
   * On stderr, so `ainize login --json` still emits exactly one JSON object on stdout — and printed even under
   * --quiet, because a command that waits for something nobody was told about is not quiet, it is broken. What
   * --quiet buys is the bare URL with nothing around it, which is also what a script would want to scrape.
   */
  process.stderr.write(ctx.quiet
    ? `${req.url}\n`
    : `\n  Open this to authorise this machine:\n\n    ${c.id(req.url)}\n\n`
      + `  ${c.dim(`key  ${key.address}`)}\n  ${c.dim(`name "${label}"`)}\n\n  ${c.dim('Waiting…  (Ctrl-C to stop)')}\n`);

  const deadline = Date.now() + (a.timeoutMs ?? 10 * 60_000);
  for (;;) {
    await sleep(Math.max(500, req.interval_ms));
    let claim: DeviceClaim;
    try {
      claim = await client.post<DeviceClaim>(`/api/auth/device/${encodeURIComponent(req.code)}/claim`, { poll_secret: req.poll_secret }, { auth: false });
    } catch (e) {
      // 410 is "nobody approved it in time" and 409 is "somebody already collected it" — both are final answers
      // with different things to do next, so neither is retried into a silent hang.
      throw e instanceof CliError ? e : new CliError(String(e));
    }
    if (claim.status === 'approved' && claim.token) {
      finishLogin(ctx, claim.token, claim.owner ?? key.address);
      ok(ctx, `signed in to ${ctx.nodeUrl} as ${c.id(shortAddr(claim.owner ?? '', 8))} `
        + c.dim(`(authorised this machine's key ${shortAddr(key.address, 6)}${claim.isOwner ? '; you own this node' : ''})`));
      return { token: claim.token, nodeUrl: ctx.nodeUrl, address: claim.owner ?? key.address };
    }
    if (Date.now() > deadline) {
      throw new CliError(`nobody approved this machine within the time allowed. Run \`${PROG} login\` again — the link is single-use, so the old one is spent either way.`);
    }
  }
}

function finishLogin(ctx: CliContext, token: string, _address: string): void {
  writeState(ctx.home, { ...readState(ctx.home), token, nodeUrl: ctx.nodeUrl });
  ctx.token = token;
}

/**
 * The one-time token `startNode` writes (item 121). Making an address an owner of a node is as privileged as
 * being one, so it is done from the node's own machine over loopback; from anywhere else this file — readable
 * only by the user the node runs as — is the proof. Read from this home automatically so nobody has to pass it.
 */
function localSetupToken(home: string): string | null {
  try { const p = join(home, 'setup-token'); if (!existsSync(p)) return null; const t = readFileSync(p, 'utf8').trim(); return t || null; } catch { return null; }
}

/**
 * `ainize login` — three ways in, and the one it picks when you do not say.
 *
 * ON THE NODE'S OWN MACHINE, the node's key in config.json is the obvious answer: it already owns everything this
 * node published, it is right here, and nobody needs to be asked anything. That stays the default there.
 *
 * ANYWHERE ELSE — a laptop, a CI runner, a second machine — there is no such key, and there used to be no answer
 * at all short of editing a file on the node's machine to make your address an operator. Now the CLI has a key of
 * its own and asks a person to vouch for it: it prints a URL, they approve it in a browser with one wallet
 * signature, and from then on this machine signs in with its own key alone. `--device` forces that path even on
 * the node's machine, which is what you want when you mean to act as YOURSELF rather than as the node.
 *
 * `--as <key>` still signs with a key you name. It is the escape hatch for a key that is already an owner.
 */
export async function login(ctx: CliContext, a: LoginArgs = {}): Promise<{ token: string; nodeUrl: string; address: string }> {
  const client = new NodeClient({ ...ctx, token: null });
  const cfg = ctx.cfg ?? loadConfig(ctx.home);
  const me = await client.get<{ signedIn: boolean; canEnroll: boolean; name: string; address: string }>('/api/auth/me', { auth: false });

  // Which key, and therefore which path. A home with no config.json is somebody's laptop, and that is the case
  // the device flow exists for — so it is the default there rather than an error telling them to go and edit a
  // file on a machine they may not be able to reach.
  const named = a.as ?? (a.nodeKey ? cfg?.identity?.privateKey : undefined);
  const useDevice = !named && (a.device || !cfg?.identity?.privateKey);
  if (useDevice) {
    if (a.enroll) {
      throw new CliError(`--enroll signs a key into this node's owners and needs a key to sign with. Either run it on the node's own machine, or `
        + `\`${PROG} login\` first and add your address from Account settings in the browser.`, 2);
    }
    return deviceLogin(ctx, a, client);
  }

  /**
   * Sign in with the node's own key. There is no password: the key is in `config.json` in this home directory and
   * it already owns everything this node published, so a secret on top of it protected nothing and was the one
   * shared secret in a product whose identity model is otherwise "a key signs for itself".
   */
  const key = named ?? cfg!.identity.privateKey;
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

  finishLogin(ctx, r.token, r.address);
  ok(ctx, `signed in to ${ctx.nodeUrl} as ${c.id(shortAddr(r.address, 8))} ${c.dim(a.enroll ? "(now an owner of this node)" : "(signed with a key)")}`);
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

/**
 * `ainize whoami` — which address this session acts as, and which key is doing the acting.
 *
 * Two different addresses, and confusing them is the mistake this command exists to stop. `subject` is who the
 * node thinks you are — whose knowledge, whose payouts, whose ownership. `via_key` is the key on THIS machine
 * that stood in for them. Before the binding existed those were always the same thing; now a laptop can act as a
 * person, and "who am I here" has an answer that a `--json` field alone cannot convey.
 */
export async function whoami(ctx: CliContext): Promise<{ signedIn: boolean; subject: string | null; via_key: string | null; isOwner: boolean; node: string; name: string }> {
  const client = new NodeClient(ctx);
  const me = await client.get<{ signedIn: boolean; subject: string | null; scheme: string | null; via_key?: string | null; isOwner: boolean; address: string; name: string }>('/api/auth/me');
  const key = readCliKey(ctx.home);
  const out = { signedIn: me.signedIn, subject: me.subject, via_key: me.via_key ?? null, isOwner: me.isOwner, node: me.address, name: me.name };
  emit(ctx, out, (d) => {
    if (!d.signedIn) return `not signed in to ${ctx.nodeUrl} — run \`${PROG} login\``;
    return [
      `${c.id(d.subject ?? '')}${d.isOwner ? c.dim('   owns this node') : ''}`,
      `  at    ${d.name} ${c.dim(shortAddr(d.node, 8))}`,
      d.via_key ? `  via   ${c.dim(`${d.via_key}  (this machine's key)`)}` : `  via   ${c.dim('its own signature')}`,
      key && !d.via_key ? `  ${c.dim(`this machine also holds ${shortAddr(key.address, 6)}, which nobody has authorised here`)}` : '',
    ].filter(Boolean).join('\n');
  });
  return out;
}

/**
 * `ainize bindings` — every machine that acts as you, and ending one.
 *
 * A binding outlives a session on purpose; that is what makes `ainize login` a thing you do once. The cost of
 * that is a list nobody looks at, so it has one here as well as in the browser — and ending one from the CLI is
 * how you shut out a laptop you no longer have.
 */
export async function bindings(ctx: CliContext, a: { end?: string } = {}): Promise<{ bindings: { delegate: string; label: string | null; created_at: number; last_seen_at: number | null }[]; via: string | null }> {
  const client = new NodeClient(ctx);
  if (a.end) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.end)) throw new CliError(`${a.end} is not an address`);
    const r = await client.delete<{ ok: boolean; sessions_ended: number }>(`/api/auth/bindings/${a.end}`);
    // Said plainly because it is the surprising half: revoking a key also signs out whatever it was running.
    ok(ctx, `${c.id(shortAddr(a.end, 8))} no longer acts as you ${c.dim(`(${r.sessions_ended} session(s) ended)`)}`);
  }
  const out = await client.get<{ bindings: { delegate: string; label: string | null; created_at: number; last_seen_at: number | null }[]; via: string | null }>('/api/auth/bindings');
  emit(ctx, out, (d) => d.bindings.length === 0
    ? 'no machine acts as you on this node'
    : d.bindings.map((b) => `  ${c.id(b.delegate)}  ${b.label ?? ''}${b.delegate === d.via ? c.dim('   ← this session') : ''}`).join('\n'));
  return out;
}

export async function logout(ctx: CliContext, a: { forget?: boolean } = {}): Promise<void> {
  const client = new NodeClient(ctx);
  if (ctx.token) { try { await client.post('/api/auth/logout'); } catch { /* ignore */ } }
  const state = readState(ctx.home);
  delete state.token;
  writeState(ctx.home, state);
  ctx.token = null;
  /**
   * `--forget` destroys this machine's key as well.
   *
   * Logging out ends a session; the key is what a person AUTHORISED, and it outlives sessions on purpose. So it
   * is a separate word, and it says what it costs: signing in here again needs another trip to the browser, and
   * the binding the node still holds becomes a row pointing at a key that no longer exists — which is worth
   * ending from the browser or with `ainize bindings --end`.
   */
  if (a.forget) {
    const key = readCliKey(ctx.home);
    const gone = forgetCliKey(ctx.home);
    ok(ctx, gone
      ? `logged out, and forgot this machine's key ${c.dim(`${shortAddr(key?.address ?? '', 8)} — signing in here again needs approving in a browser, and the node still lists it until you end it (\`${PROG} bindings --end ${key?.address ?? '0x…'}\`)`)}`
      : 'logged out (this machine had no key of its own)');
    return;
  }
  ok(ctx, 'logged out');
}
