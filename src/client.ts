/**
 * Thin HTTP client for a marketplace node's API (mirrors ainize-cli's axios calls, on global fetch).
 */
import { CliError, PROG, type CliContext } from './context.js';
import { withProgress, type Progress } from './output.js';

export interface RequestOptions { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; raw?: boolean; auth?: boolean; progress?: boolean; }

/** A request whose own timeout is a minute or more is one a person sits and waits for (item 105). */
const SLOW_MS = 60_000;

/**
 * What the terminal is waiting for, in the words of the thing being waited on (item 105). Every heavy verb was a
 * single awaited fetch that printed nothing until it finished — up to 30 minutes of blank terminal, indistinguishable
 * from a hang, on a shared GPU somebody else may be holding.
 */
function slowLabel(method: string, path: string): string | null {
  if (/\/api\/chat$/.test(path)) return 'the live test';
  if (/\/verify$/.test(path)) return 'verification';
  if (/\/challenge$/.test(path)) return 'the challenge';
  if (/\/buy$/.test(path)) return 'the purchase';
  if (/\/collect$/.test(path)) return 'the download';
  if (/\/(apply|remove)$/.test(path)) return 'the model';
  if (/\/subscribe$/.test(path)) return 'the subscription';
  return `${method} ${path}`;
}

/** Requests that queue behind the one shared serving model, and can therefore say who is holding it up. */
const LOCK_BOUND = /\/api\/chat$|\/verify$|\/(apply|remove)$|\/subscribe$/;

/** `GET /api/chat/status` — free, unauthenticated, and it reports the shared model's lock and queue to anyone. */
interface QueueView { lock: { label: string; owner: string; since: number } | null; waiting: number; now: number }

export class NodeClient {
  constructor(private readonly ctx: CliContext) {}

  get baseUrl(): string { return this.ctx.nodeUrl; }

  /**
   * Ask the node, while a slow request is in flight, what is in front of it. The queue and the lock are node facts
   * (`GET /api/chat/status`, free and quota-free), so the line the terminal shows is measured, never guessed. A node
   * that does not answer it leaves the elapsed clock to stand on its own.
   */
  private async followQueue(p: Progress, stop: { done: boolean }): Promise<void> {
    const id = `cli-${Math.random().toString(36).slice(2, 10)}`;
    for (let i = 0; !stop.done; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 1200 : 3000));
      if (stop.done) return;
      try {
        const q = await this.get<QueueView>(`/api/chat/status?request_id=${id}`, { timeoutMs: 5000, auth: false, progress: false });
        if (stop.done) return;
        const held = q.lock ? Math.round((q.now - q.lock.since) / 1000) : 0;
        p.note(q.lock ? `model busy: ${q.lock.label} (${held}s)${q.waiting ? `, ${q.waiting} ahead` : ''}` : null);
      } catch { return; }   // an older node has no such route; the clock alone is still better than silence
    }
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.ctx.nodeUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['content-type'] = 'application/json';
    if (opts.auth !== false && this.ctx.token) headers.authorization = `Bearer ${this.ctx.token}`;
    let res: Response;
    const t0 = Date.now();
    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
    const send = () => fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    try {
      // Item 105: a request the caller is prepared to wait a minute or more for says so, once a second, on stderr —
      // with the shared model's own queue when it is what we are waiting for. stdout stays pipe-clean.
      const label = opts.progress === false || (opts.timeoutMs ?? 0) < SLOW_MS ? null : slowLabel(method, new URL(url).pathname);
      res = label === null ? await send() : await withProgress(this.ctx, `waiting for ${label}`, async (p) => {
        const stop = { done: false };
        if (LOCK_BOUND.test(new URL(url).pathname)) void this.followQueue(p, stop);
        try { return await send(); } finally { stop.done = true; }
      });
    } catch (e) {
      const msg = (e as Error).message;
      // Item 212 — "we stopped waiting" is not "the node is down". A request that outlives our own AbortSignal, or
      // undici's 300-second header timeout, was reported as `cannot reach node … (fetch failed)` with exit 2: the
      // script took the restart-and-retry branch while the node was healthy and ran the queued operation minutes
      // later. A timeout gets its own message and its own exit code (4), and says the work may still be running.
      if (NodeClient.isTimeout(e)) {
        const waited = Math.round((Date.now() - t0) / 1000);
        throw new CliError(`the node at ${this.ctx.nodeUrl} did not answer within ${waited}s — it is running, but this request is still waiting (the shared model lock is held by another live test or verification). The node may carry it out anyway: check \`${PROG} patch stack\` and \`${PROG} logs --kind runtime\` before retrying.`, 4);
      }
      throw new CliError(`cannot reach node at ${this.ctx.nodeUrl} (${msg}). Is it running? Try \`${PROG} start\` or pass --node <url>.`, 2);
    }
    if (opts.raw) return res as unknown as T;
    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const err = (data as { error?: string; issues?: { path?: (string | number)[]; message: string }[] } | null);
      let msg = err?.error ?? (typeof data === 'string' ? data : `HTTP ${res.status}`);
      // Item 169(d): the field name was joined onto a message that often starts with it, so a rejected price read
      // "price price must be a non-negative number". Name the field only when the message does not already.
      if (err?.issues?.length) {
        msg += ': ' + err.issues.map((i) => {
          const field = (i.path ?? []).join('.');
          return field && !i.message.toLowerCase().startsWith(field.toLowerCase()) ? `${field} ${i.message}` : i.message;
        }).join('; ');
      }
      if (res.status === 401) msg += ` — run \`${PROG} login\` first`;
      throw new CliError(msg, res.status === 401 ? 3 : 1, data);
    }
    return data as T;
  }

  get<T = unknown>(path: string, opts: RequestOptions = {}) { return this.request<T>(path, { ...opts, method: 'GET' }); }
  post<T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) { return this.request<T>(path, { ...opts, method: 'POST', body: body ?? {} }); }
  patch<T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) { return this.request<T>(path, { ...opts, method: 'PATCH', body: body ?? {} }); }
  delete<T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) { return this.request<T>(path, { ...opts, method: 'DELETE', body }); }

  /**
   * Did we give up waiting, rather than fail to connect? `AbortSignal.timeout` throws a TimeoutError; undici gives up
   * on response headers after 300 s by default and on a stalled body too, both as `fetch failed` with a `cause` code.
   */
  static isTimeout(e: unknown): boolean {
    const err = e as { name?: string; code?: string; cause?: { code?: string; name?: string } };
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
    const code = err?.code ?? err?.cause?.code ?? err?.cause?.name ?? '';
    return /UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT|TimeoutError/.test(String(code));
  }

  /** Is a node answering at the configured URL? */
  async alive(timeoutMs = 2000): Promise<boolean> {
    try { await this.get('/api/info', { timeoutMs, auth: false }); return true; } catch { return false; }
  }
}

export function query(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
