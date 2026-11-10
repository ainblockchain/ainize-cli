/**
 * `ainize deploy` — push the repository in this directory to AinDrive, which is what deploys it on Ainize.
 *
 * The path it replaces was four tools long: install the aindrive CLI, `aindrive login`, write a git credential
 * helper into the global git config, then `git remote set-url` and `git push`. All of that is still what happens —
 * AinDrive is the git host, and a push to a repository whose root has `ainize.json` is a deployment — but none of it
 * is the person's job any more:
 *
 *   • the AinDrive sign-in is collected here (and by `ainize login`), with the same three calls `aindrive login`
 *     makes, and kept where that CLI keeps it (`~/.aindrive/credentials.json`, 0600) so the two never disagree;
 *   • the credential reaches git through the environment for this one push. Nothing is written to the remote URL
 *     or to any git config, and no credential helper is consulted — a stale keychain entry for the host used to
 *     win over the configured helper and fail the push with "Authentication failed";
 *   • the remote is remembered as `ainize`, so the second `ainize deploy` needs no flags and `origin` (GitHub, for
 *     most people) is left alone;
 *   • the build is followed to `ready` or `error` and the address is printed.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { openBrowser } from '../browser.js';
import { DEFAULT_WEBSITE } from '../node-link.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, info, kv, ok, warn } from '../output.js';

export const DEFAULT_AINDRIVE_SERVER = (process.env.AINDRIVE_SERVER ?? 'https://aindrive.ainetwork.ai').replace(/\/+$/, '');
export const DEPLOY_REMOTE = 'ainize';
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface DriveCredentials { server: string; email?: string; sessionCookie: string; savedAt: number }
export interface DriveSession { server: string; token: string; email: string | null }
interface DriveDeps { fetch?: typeof fetch; open?: boolean; timeoutMs?: number; pollMs?: number; credentialsFile?: string }

export function driveCredentialsPath(): string {
  return process.env.AINDRIVE_CREDENTIALS ?? join(homedir(), '.aindrive', 'credentials.json');
}

function readCredentials(server: string, file: string): DriveCredentials | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as DriveCredentials;
    return v && typeof v.sessionCookie === 'string' && v.sessionCookie && String(v.server ?? '').replace(/\/+$/, '') === server ? v : null;
  } catch { return null; }
}

function writeCredentials(file: string, creds: DriveCredentials): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* a filesystem without modes */ }
}

async function driveUser(server: string, token: string, f: typeof fetch): Promise<{ email: string | null } | null> {
  const res = await f(`${server}/api/auth/me`, { headers: { cookie: `aindrive_session=${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as { user?: { email?: string } | null } | null;
  return body?.user ? { email: body.user.email ?? null } : null;
}

/**
 * The AinDrive sign-in for `server`: the stored one when AinDrive still accepts it, otherwise a browser approval.
 * The link shows what is being asked; the device secret that collects the token never leaves this process.
 */
export async function driveSession(ctx: CliContext, server = DEFAULT_AINDRIVE_SERVER, deps: DriveDeps = {}): Promise<DriveSession> {
  const f = deps.fetch ?? fetch;
  const file = deps.credentialsFile ?? driveCredentialsPath();
  const stored = readCredentials(server, file);
  if (stored) {
    const user = await driveUser(server, stored.sessionCookie, f).catch(() => null);
    if (user) return { server, token: stored.sessionCookie, email: user.email ?? stored.email ?? null };
  }
  const started = await f(`${server}/api/auth/cli/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000) });
  if (!started.ok) throw new CliError(`AinDrive at ${server} refused to start a sign-in (HTTP ${started.status})`);
  const link = await started.json() as { linkId: string; deviceSecret: string };
  const url = `${server}/cli-login/${encodeURIComponent(link.linkId)}`;
  process.stderr.write(ctx.quiet ? `${url}\n`
    : `\n  Open this to connect AinDrive (where your repositories live):\n\n    ${c.id(url)}\n\n  ${c.dim('Waiting…  (Ctrl-C to stop)')}\n`);
  if (deps.open !== false) openBrowser(url);
  const deadline = Date.now() + (deps.timeoutMs ?? 10 * 60_000);
  for (;;) {
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 2000));
    const res = await f(`${server}/api/auth/cli/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(link), signal: AbortSignal.timeout(20_000) });
    if (res.status === 202) {
      if (Date.now() > deadline) throw new CliError(`nobody approved the AinDrive sign-in in time. Run \`${PROG} deploy\` again — the link is single-use.`);
      continue;
    }
    if (res.status === 410) throw new CliError('the AinDrive sign-in link expired or was already used — run the command again');
    if (!res.ok) throw new CliError(`AinDrive sign-in failed (HTTP ${res.status})`);
    const done = await res.json() as { token?: string; user?: { email?: string } };
    if (!done.token) throw new CliError('AinDrive approved the sign-in but returned no token');
    writeCredentials(file, { server, email: done.user?.email, sessionCookie: done.token, savedAt: Date.now() });
    ok(ctx, `AinDrive connected${done.user?.email ? ` as ${done.user.email}` : ''}`);
    return { server, token: done.token, email: done.user?.email ?? null };
  }
}

/** The organizations whose drives this person can reach — the `<org>` of `…/<org>/git/<repo>`. */
export async function driveOrgs(session: DriveSession, f: typeof fetch = fetch): Promise<string[]> {
  const res = await f(`${session.server}/api/drives`, { headers: { cookie: `aindrive_session=${session.token}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null) as { drives?: { org?: { slug?: string } | null }[] } | null;
  return [...new Set((body?.drives ?? []).map((d) => d.org?.slug).filter((s): s is string => !!s && SLUG.test(s)))].sort();
}

/** `https://<server>/<org>/git/<repo>` → its parts; anything else (GitHub, a URL with credentials) is not ours. */
export function parseDeployRemote(url: string, server = DEFAULT_AINDRIVE_SERVER): { org: string; repo: string } | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.origin !== new URL(server).origin || u.username || u.password) return null;
  const m = /^\/([^/]+)\/git\/([^/]+?)(?:\.git)?\/?$/.exec(u.pathname);
  return m && SLUG.test(m[1]!) && SLUG.test(m[2]!) ? { org: m[1]!, repo: m[2]! } : null;
}

interface GitResult { code: number; stdout: string; stderr: string }
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env, inherit = false): Promise<GitResult> {
  return new Promise((done, reject) => {
    const child = spawn('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', inherit ? 'inherit' : 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr?.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-8192); });
    child.on('error', (e) => reject(new CliError(`git is not available: ${e.message}`)));
    child.on('close', (code) => done({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/** Git credentials for one command, through the environment only: no helper, nothing in the URL, nothing on disk. */
export function gitAuthEnv(session: DriveSession, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const n = Number(base.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    ...base, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'credential.helper', [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: `http.${session.server}/.extraHeader`,
    [`GIT_CONFIG_VALUE_${n + 1}`]: `Authorization: Basic ${Buffer.from(`x-access-token:${session.token}`).toString('base64')}`,
  };
}

function manifestKind(root: string): string {
  const file = join(root, 'ainize.json');
  if (existsSync(file)) {
    let m: { kind?: unknown };
    try { m = JSON.parse(readFileSync(file, 'utf8')) as { kind?: unknown }; } catch (e) { throw new CliError(`ainize.json is not valid JSON: ${(e as Error).message}`); }
    return typeof m.kind === 'string' ? m.kind : 'unknown';
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    if (pkg.dependencies?.next) return 'nextjs';
  } catch { /* no package.json */ }
  throw new CliError(`nothing to deploy in ${root}: add an ainize.json at the repository root, e.g.\n`
    + `  {"kind":"nextjs","name":"My app","port":3000,"healthcheck":"/api/health"}`);
}

export interface DeployArgs { dir?: string; org?: string; repo?: string; branch?: string; server?: string; hub?: string; wait?: boolean; open?: boolean; force?: boolean; timeoutMs?: number; pollMs?: number; fetch?: typeof fetch; credentialsFile?: string }
export interface DeployResult { repo: string; org: string; name: string; branch: string; commit: string; kind: string; status: string; page: string; url: string | null; deployment: string | null; error?: string }

interface ProjectView { id: string; pageUrl?: string; lastDeployment?: { id: string; sha?: string; status: string; error?: string; outputUrl?: string } | null }

export async function deploy(ctx: CliContext, a: DeployArgs = {}): Promise<DeployResult> {
  const f = a.fetch ?? fetch;
  const server = (a.server ?? DEFAULT_AINDRIVE_SERVER).replace(/\/+$/, '');
  const dir = resolve(a.dir ?? '.');
  if (!existsSync(dir)) throw new CliError(`no such directory: ${dir}`);

  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new CliError(`${dir} is not a git repository. Make it one, then deploy:\n  git init -b main && git add -A && git commit -m "first deploy" && ${PROG} deploy`);
  const root = top.stdout;
  const kind = manifestKind(root);
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (head.code !== 0) throw new CliError(`this repository has no commit yet:\n  git add -A && git commit -m "first deploy" && ${PROG} deploy`);
  const commit = head.stdout;
  if ((await git(root, ['status', '--porcelain'])).stdout) warn(ctx, 'uncommitted changes are not deployed — only what is committed is pushed');

  const session = await driveSession(ctx, server, { fetch: f, open: a.open, credentialsFile: a.credentialsFile, pollMs: a.pollMs });

  const remembered = parseDeployRemote((await git(root, ['remote', 'get-url', DEPLOY_REMOTE])).stdout, server);
  let org = a.org ?? remembered?.org ?? process.env.AINDRIVE_ORG;
  if (!org) {
    const orgs = await driveOrgs(session, f);
    if (orgs.length === 1) org = orgs[0];
    else throw new CliError(orgs.length
      ? `which organization? Pass one: ${orgs.map((o) => `--org ${o}`).join('  |  ')}`
      : `you are not in an organization with a shared drive on ${server}. Ask an admin to add you, or pass --org.`);
  }
  const name = a.repo ?? remembered?.repo ?? basename(root);
  if (!SLUG.test(org!) || !SLUG.test(name)) throw new CliError(`--org and --repo take letters, digits, dot, dash and underscore — got "${org}/${name}". Pass --repo <name>.`);
  const branch = a.branch ?? 'main';
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) throw new CliError(`not a branch name: ${branch}`);
  const repo = `${server}/${org}/git/${name}`;

  const current = await git(root, ['remote', 'get-url', DEPLOY_REMOTE]);
  if (current.code !== 0) await git(root, ['remote', 'add', DEPLOY_REMOTE, repo]);
  else if (current.stdout !== repo) await git(root, ['remote', 'set-url', DEPLOY_REMOTE, repo]);

  info(ctx, `pushing ${commit.slice(0, 7)} to ${repo} (${branch})`);
  const pushed = await git(root, ['push', ...(a.force ? ['--force'] : []), repo, `HEAD:refs/heads/${branch}`], gitAuthEnv(session));
  if (pushed.code !== 0) {
    const secret = Buffer.from(`x-access-token:${session.token}`).toString('base64');
    const text = pushed.stderr.split(session.token).join('[redacted]').split(secret).join('[redacted]');
    if (/403|denied|not allowed|forbidden/i.test(text)) throw new CliError(`AinDrive refused the push to ${org}/${name}: you need to be an editor of that organization's drive.\n${text}`, 3);
    if (/non-fast-forward|fetch first|rejected/i.test(text)) throw new CliError(`the repository on AinDrive has commits this one does not. Pull them (git pull ${DEPLOY_REMOTE} ${branch}) or pass --force to replace them.\n${text}`);
    throw new CliError(`git push failed:\n${text}`);
  }

  const hub = (a.hub ?? (ctx.nodeSource === 'default' || ctx.nodeSource === 'config' ? DEFAULT_WEBSITE : ctx.nodeUrl)).replace(/\/+$/, '');
  const page = `${hub}/${org}/${name}`;
  const result: DeployResult = { repo, org: org!, name, branch, commit, kind, status: 'pushed', page, url: null, deployment: null };

  if (a.wait !== false) {
    const headers: Record<string, string> = ctx.token && hub === ctx.nodeUrl.replace(/\/+$/, '') ? { authorization: `Bearer ${ctx.token}` } : {};
    const deadline = Date.now() + (a.timeoutMs ?? 15 * 60_000);
    let seen = '', misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, a.pollMs ?? 3000));
      const res = await f(`${hub}/api/projects/by-repo?repo=${encodeURIComponent(repo)}`, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      const view = res?.ok ? await res.json().catch(() => null) as ProjectView | null : null;
      const d = view?.lastDeployment && view.lastDeployment.sha === commit ? view.lastDeployment : null;
      if (!d) {
        // An organization's project is shown only to its members: without a session that the node ties to the
        // organization the push still deployed, it just cannot be watched from here.
        if (res?.status === 404 && ++misses >= 20) { result.status = 'unknown'; break; }
        if (Date.now() > deadline) { result.status = 'timeout'; break; }
        continue;
      }
      result.deployment = d.id;
      if (d.status !== seen) { seen = d.status; info(ctx, `deployment ${d.id}: ${d.status}`); }
      if (d.status === 'ready') { result.status = 'ready'; result.url = d.outputUrl ?? null; if (view?.pageUrl) result.page = view.pageUrl; break; }
      if (d.status === 'error') { result.status = 'error'; result.error = d.error ?? 'the build failed'; break; }
      if (Date.now() > deadline) { result.status = 'timeout'; break; }
    }
  }

  emit(ctx, result, (r) => [
    r.status === 'ready' ? c.ok('✓ deployed') : r.status === 'error' ? c.warn(`! deployment failed: ${r.error}`)
      : r.status === 'pushed' ? c.ok('✓ pushed') + c.dim(' (not waiting for the build)')
      : r.status === 'unknown' ? c.ok('✓ pushed') + c.dim(` — the build cannot be followed from here; run \`${PROG} login\` as a member of ${r.org}, or open the page`)
      : c.warn('! pushed, but the build did not finish in time — it may still be running'),
    kv([['repository', r.repo], ['commit', r.commit.slice(0, 12)], ['kind', r.kind], ['page', c.id(r.page)], ...(r.url ? [['app', c.id(r.url)] as [string, unknown]] : [])]),
  ].join('\n'));
  if (result.status === 'error') process.exitCode = 1;
  return result;
}
