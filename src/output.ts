/**
 * Terminal output helpers: tables, key/value blocks, status colours, JSON mode.
 */
import chalk from 'chalk';
import type { CliContext } from './context.js';

export const c = {
  ok: chalk.green, warn: chalk.yellow, err: chalk.red, dim: chalk.gray, bold: chalk.bold, head: chalk.magenta, id: chalk.cyan, num: chalk.white,
};

export function statusColor(status: string): string {
  switch (status) {
    case 'LISTED': return chalk.green(status);
    case 'VERIFYING': case 'ANNOUNCED': return chalk.yellow(status);
    case 'REJECTED': case 'CHALLENGED': return chalk.red(status);
    case 'SUPERSEDED': return chalk.gray(status);
    // The author took it off sale themselves (item 148) — not a failure, not a dispute.
    case 'RETIRED': return chalk.gray(status);
    case 'DRAFT': return chalk.blue(status);
    default: return status;
  }
}

export function shortAddr(a?: string | null, n = 6): string {
  if (!a) return '-';
  return a.length > n * 2 + 4 ? `${a.slice(0, n + 2)}…${a.slice(-4)}` : a;
}

export function shortHash(h?: string | null, n = 12): string {
  if (!h) return '-';
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

export function fmtBytes(n?: number | null): string {
  if (n === undefined || n === null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtTime(ts?: number | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const width = (s: string) => { let w = 0; for (const ch of s.replace(ANSI, '')) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1; return w; };
const padEnd = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)));

export interface Column<T> { key: string; title: string; get: (row: T) => string; align?: 'left' | 'right'; }

export function table<T>(rows: T[], cols: Column<T>[], empty = '(none)'): string {
  if (!rows.length) return c.dim(empty);
  const cells = rows.map((r) => cols.map((col) => col.get(r) ?? ''));
  const widths = cols.map((col, i) => Math.max(width(col.title), ...cells.map((r) => width(r[i]))));
  const line = (vals: string[], head = false) => vals.map((v, i) => {
    const w = widths[i];
    const s = cols[i].align === 'right' ? ' '.repeat(Math.max(0, w - width(v))) + v : padEnd(v, w);
    return head ? c.head(s) : s;
  }).join('  ');
  return [line(cols.map((x) => x.title), true), c.dim(widths.map((w) => '─'.repeat(w)).join('  ')), ...cells.map((r) => line(r))].join('\n');
}

export function kv(pairs: [string, unknown][]): string {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${c.dim(k.padEnd(w))}  ${v === undefined || v === null || v === '' ? c.dim('-') : String(v)}`).join('\n');
}

/** Print according to context: JSON mode dumps `data`, otherwise `render(data)`; quiet suppresses. */
export function emit<T>(ctx: CliContext, data: T, render: (d: T) => string | void): T {
  if (ctx.quiet) return data;
  if (ctx.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return data; }
  const s = render(data);
  if (typeof s === 'string') process.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
  return data;
}

export function info(ctx: CliContext, msg: string) { if (!ctx.quiet && !ctx.json) process.stdout.write(msg + '\n'); }
export function ok(ctx: CliContext, msg: string) { info(ctx, c.ok('✓ ') + msg); }
export function warn(ctx: CliContext, msg: string) { if (!ctx.quiet) process.stderr.write(c.warn('! ') + msg + '\n'); }
