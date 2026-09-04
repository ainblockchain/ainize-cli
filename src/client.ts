/**
 * Thin HTTP client for a marketplace node's API (mirrors ainize-cli's axios calls, on global fetch).
 */
import { CliError, PROG, type CliContext } from './context.js';

export interface RequestOptions { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; raw?: boolean; auth?: boolean; }

export class NodeClient {
  constructor(private readonly ctx: CliContext) {}

  get baseUrl(): string { return this.ctx.nodeUrl; }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.ctx.nodeUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['content-type'] = 'application/json';
    if (opts.auth !== false && this.ctx.token) headers.authorization = `Bearer ${this.ctx.token}`;
    let res: Response;
    const t0 = Date.now();
    try {
      res = await fetch(url, {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
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
      if (err?.issues?.length) msg += ': ' + err.issues.map((i) => `${(i.path ?? []).join('.')} ${i.message}`.trim()).join('; ');
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
