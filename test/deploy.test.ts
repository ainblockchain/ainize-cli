/**
 * `ainize deploy` end to end against a real `git http-backend`: the AinDrive sign-in is collected in-process,
 * reaches git through the environment only, and the build is followed on the hub.
 *
 *   node --test --import tsx test/deploy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { buildContext } from '../src/context.js';
import { deploy, gitAuthEnv, parseDeployRemote } from '../src/commands/deploy.js';

const run = promisify(execFile);
const TOKEN = 'drive-session-token';
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;

test('a deploy remote is an AinDrive repository URL without credentials', () => {
  const s = 'https://aindrive.ainetwork.ai';
  assert.deepEqual(parseDeployRemote(`${s}/comcom/git/my-app`, s), { org: 'comcom', repo: 'my-app' });
  assert.deepEqual(parseDeployRemote(`${s}/comcom/git/my-app.git/`, s), { org: 'comcom', repo: 'my-app' });
  assert.equal(parseDeployRemote('https://github.com/comcom/git/my-app', s), null);
  assert.equal(parseDeployRemote(`https://x-access-token:secret@aindrive.ainetwork.ai/comcom/git/my-app`, s), null);
  assert.equal(parseDeployRemote(`${s}/comcom/git/a/b`, s), null);
  const env = gitAuthEnv({ server: s, token: 't', email: null }, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' });
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'a.b');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(env.GIT_CONFIG_KEY_2, `http.${s}/.extraHeader`);
});

test('deploy signs in to AinDrive, pushes without leaving a credential anywhere, and follows the build', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ainize-deploy-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args: string[]) => run('git', args, { env });
  const bare = join(root, 'repos', 'my-app.git');
  mkdirSync(join(root, 'repos'), { recursive: true });
  await git('init', '--bare', '-b', 'main', bare);
  await git('-C', bare, 'config', 'http.receivepack', 'true');
  const work = join(root, 'my-app');
  await git('init', '-b', 'main', work);
  writeFileSync(join(work, 'ainize.json'), JSON.stringify({ kind: 'nextjs', name: 'My app', port: 3000 }));
  await git('-C', work, 'add', '.'); await git('-C', work, 'commit', '-m', 'Initial');
  await git('-C', work, 'remote', 'add', 'origin', 'https://github.com/someone/my-app');
  const commit = (await git('-C', work, 'rev-parse', 'HEAD')).stdout.trim();

  let polls = 0, statusCalls = 0, approved = false;
  const pushes: string[] = [];
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = (req: IncomingMessage) => new Promise<string>((done) => { let b = ''; req.on('data', (ch) => { b += ch; }); req.on('end', () => done(b)); });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://drive');
    if (url.pathname === '/api/auth/me') return json(res, req.headers.cookie === `aindrive_session=${TOKEN}` ? 200 : 401, { user: req.headers.cookie === `aindrive_session=${TOKEN}` ? { email: 'dev@example.com' } : null });
    if (url.pathname === '/api/auth/cli/start') return json(res, 200, { linkId: 'link1', deviceSecret: 'device-secret' });
    if (url.pathname === '/api/auth/cli/poll') {
      assert.deepEqual(JSON.parse(await read(req)), { linkId: 'link1', deviceSecret: 'device-secret' });
      if (++polls < 2) return json(res, 202, {});
      approved = true;
      return json(res, 200, { token: TOKEN, user: { email: 'dev@example.com' } });
    }
    if (url.pathname === '/api/drives') return json(res, 200, { drives: [{ org: null }, { org: { slug: 'comcom' } }, { org: { slug: 'comcom' } }] });
    if (url.pathname === '/api/projects/by-repo') {
      assert.equal(url.searchParams.get('repo'), `${base}/comcom/git/my-app`);
      assert.equal(req.headers.authorization, 'Bearer ainize-session');
      const n = ++statusCalls;
      if (n === 1) return json(res, 404, { error: { code: 'not_found' } });
      return json(res, 200, { id: 'prj_1', pageUrl: `${base}/comcom/my-app`, lastDeployment: { id: 'dep_1', sha: commit, status: n === 2 ? 'building' : 'ready', outputUrl: 'https://my-app.example.test' } });
    }
    const m = /^\/comcom\/git\/(my-app)(\/.*)$/.exec(url.pathname);
    if (!m) return json(res, 404, {});
    if (req.headers.authorization !== BASIC) { res.writeHead(401, { 'www-authenticate': 'Basic realm="aindrive"' }); return res.end(); }
    if (url.pathname.endsWith('/git-receive-pack')) pushes.push(url.pathname);
    const child = spawn('git', ['http-backend'], { env: { ...env, GIT_PROJECT_ROOT: join(root, 'repos'), GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'dev', PATH_INFO: `/${m[1]}.git${m[2]}`, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '' } });
    req.pipe(child.stdin); let buffer = Buffer.alloc(0), started = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (started) { res.write(chunk); return; }
      buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const headers: Record<string, string> = {};
      for (const line of buffer.subarray(0, end).toString().split('\r\n')) { const at = line.indexOf(':'); headers[line.slice(0, at)] = line.slice(at + 1).trim(); }
      res.writeHead(200, headers); started = true; res.write(buffer.subarray(end + 4));
    });
    child.stdout.on('end', () => res.end());
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const credentialsFile = join(root, 'creds', 'credentials.json');
  const ctx = { ...buildContext({ home: join(root, 'home'), node: base, quiet: true }), token: 'ainize-session' };
  try {
    const first = await deploy(ctx, { dir: work, server: base, open: false, pollMs: 5, credentialsFile });
    assert.ok(approved, 'the sign-in was collected by deploy itself');
    assert.equal(first.status, 'ready');
    assert.equal(first.repo, `${base}/comcom/git/my-app`);
    assert.equal(first.url, 'https://my-app.example.test');
    assert.equal(first.commit, commit);
    assert.equal((await git('-C', bare, 'rev-parse', 'refs/heads/main')).stdout.trim(), commit);
    assert.equal(pushes.length, 1);

    // The credential is where the aindrive CLI keeps it, private, and nowhere git would persist it.
    assert.equal(JSON.parse(readFileSync(credentialsFile, 'utf8')).sessionCookie, TOKEN);
    assert.equal(statSync(credentialsFile).mode & 0o777, 0o600);
    const config = readFileSync(join(work, '.git', 'config'), 'utf8');
    assert.ok(config.includes(`[remote "ainize"]`) && config.includes(`${base}/comcom/git/my-app`));
    assert.ok(config.includes('https://github.com/someone/my-app'), 'origin is left alone');
    assert.doesNotMatch(config, new RegExp(`${TOKEN}|extraHeader|Authorization`));

    // The second deploy needs no flags and no browser: the remote and the sign-in are remembered.
    writeFileSync(join(work, 'page.txt'), 'v2');
    await git('-C', work, 'add', '.'); await git('-C', work, 'commit', '-m', 'Second');
    polls = 0; approved = false; statusCalls = 5;
    const next = (await git('-C', work, 'rev-parse', 'HEAD')).stdout.trim();
    const second = await deploy(ctx, { dir: work, server: base, open: false, wait: false, credentialsFile });
    assert.equal(second.status, 'pushed');
    assert.equal(polls, 0);
    assert.equal((await git('-C', bare, 'rev-parse', 'refs/heads/main')).stdout.trim(), next);

    // What cannot be deployed says what to do instead.
    const empty = join(root, 'plain'); mkdirSync(empty);
    await assert.rejects(deploy(ctx, { dir: empty, server: base, credentialsFile }), /not a git repository/);
    await git('init', '-b', 'main', empty);
    writeFileSync(join(empty, 'readme.md'), 'x'); await git('-C', empty, 'add', '.'); await git('-C', empty, 'commit', '-m', 'x');
    await assert.rejects(deploy(ctx, { dir: empty, server: base, credentialsFile }), /add an ainize\.json/);
    assert.ok(existsSync(credentialsFile));
  } finally { await new Promise<void>((done) => server.close(() => done())); rmSync(root, { recursive: true, force: true }); }
});
