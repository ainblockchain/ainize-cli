/**
 * Terminal output helpers: tables, key/value blocks, status colours, JSON mode.
 */
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { CliError, type CliContext } from './context.js';

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
const ANSI = /\x1b\[[0-9;]*m/g;
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
export const width = (s: string) => { let w = 0; for (const ch of s.replace(ANSI, '')) w += WIDE_CHAR.test(ch) ? 2 : 1; return w; };
const padEnd = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)));

/**
 * Cut a coloured string to `n` display cells (item 115). Escape sequences cost nothing on screen, so they are copied
 * through and never counted; a cut string ends with `…` and a reset, so a truncated cyan id does not colour the rest
 * of the row. CJK cells count as two, the same way `width` counts them, so a Korean name is cut on a character
 * boundary and the column below it still lines up.
 */
export function clip(s: string, n: number): string {
  if (width(s) <= n) return s;
  const room = Math.max(0, n - 1);        // the … itself occupies one cell
  let out = '';
  let w = 0;
  let coloured = false;
  for (let i = 0; i < s.length;) {
    // eslint-disable-next-line no-control-regex
    const esc = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (esc) { out += esc[0]; coloured = true; i += esc[0].length; continue; }
    const ch = [...s.slice(i)][0] ?? '';
    const cw = WIDE_CHAR.test(ch) ? 2 : 1;
    if (w + cw > room) break;
    out += ch; w += cw; i += ch.length;
  }
  return out + '…' + (coloured ? '\x1b[0m' : '');
}

/**
 * `--wide` (item 115). Tables are fitted to the terminal; this turns the fitting off for a session that wants every
 * column whatever the width. Piped output is never fitted either — a script reading `patch ls` gets the full cells.
 */
let wideOutput = false;
export function setWide(v: boolean): void { wideOutput = v; }

/**
 * How many display columns this output may use. `Infinity` means "do not fit": not a terminal (a pipe, a CI log, a
 * file) or `--wide`. 60 is the floor, below which a table cannot be a table.
 */
export function budget(): number {
  if (wideOutput || !process.stdout.isTTY) return Infinity;
  return Math.max(60, process.stdout.columns || 100);
}

export interface Column<T> { key: string; title: string; get: (row: T) => string; align?: 'left' | 'right'; }

/**
 * A table fitted to the terminal (item 115). Natural widths first; when they do not fit, the text columns are
 * shrunk (widest first, down to 8 cells) with `clip`, and only if that is still not enough are columns dropped from
 * the right — with a line saying how many and how to get them back. Right-aligned columns are numbers and are never
 * shrunk. Piped output and `--wide` skip the whole mechanism.
 */
export function table<T>(rows: T[], cols: Column<T>[], empty = '(none)'): string {
  if (!rows.length) return c.dim(fitLine(empty));
  const cells = rows.map((r) => cols.map((col) => col.get(r) ?? ''));
  const natural = cols.map((col, i) => Math.max(width(col.title), ...cells.map((r) => width(r[i]))));
  const GAP = 2;
  const max = budget();
  let show = cols.map((_, i) => i);
  const widths = natural.slice();
  const total = (idx: number[], w: number[]) => idx.reduce((a, i) => a + w[i], 0) + GAP * Math.max(0, idx.length - 1);

  if (max !== Infinity && total(show, widths) > max) {
    // 1. shrink the text columns, widest first, to a floor of 8 cells (or their title, when that is shorter)
    const floor = (i: number) => Math.min(natural[i], Math.max(8, Math.min(width(cols[i].title), 12)));
    const shrinkable = () => show.filter((i) => cols[i].align !== 'right' && widths[i] > floor(i));
    for (;;) {
      const over = total(show, widths) - max;
      if (over <= 0) break;
      const cand = shrinkable();
      if (!cand.length) break;
      const widest = cand.reduce((a, b) => (widths[a] >= widths[b] ? a : b));
      const next = cand.map((i) => widths[i]).filter((w) => w < widths[widest]).sort((a, b) => b - a)[0] ?? floor(widest);
      widths[widest] = Math.max(floor(widest), next, widths[widest] - over);
    }
    // 2. still too wide: drop columns from the right, keeping at least the first two
    while (show.length > 2 && total(show, widths) > max) show = show.slice(0, -1);
  }

  const dropped = cols.length - show.length;
  const line = (vals: string[], head = false) => show.map((i) => {
    const v = clip(vals[i], widths[i]);
    const s = cols[i].align === 'right' ? ' '.repeat(Math.max(0, widths[i] - width(v))) + v : padEnd(v, widths[i]);
    return head ? c.head(s) : s;
  }).join(' '.repeat(GAP));
  const out = [
    line(cols.map((x) => x.title), true),
    c.dim(show.map((i) => '─'.repeat(widths[i])).join(' '.repeat(GAP))),
    ...cells.map((r) => line(r)),
  ];
  if (dropped) out.push(c.dim(fitLine(`(${dropped} more column${dropped === 1 ? '' : 's'} not shown: ${cols.slice(show.length).map((x) => x.title).join(', ')} — --wide, or a wider terminal, shows ${dropped === 1 ? 'it' : 'them'})`)));
  return out.join('\n');
}

/**
 * A prose line fitted to the same budget (item 115): the widest thing on the screen was never a table but the
 * `overlapping memory entries: …` line. Wrapped, not cut, and continuation lines are indented under the first.
 */
export function fitLine(s: string, indent = 2): string {
  const max = budget();
  if (max === Infinity || width(s) <= max) return s;
  return s.split('\n').map((one) => {
    const lines: string[] = [];
    let cur = '';
    for (const w of one.split(' ')) {
      if (cur && width(cur) + 1 + width(w) > max) { lines.push(cur); cur = ' '.repeat(indent) + w; continue; }
      cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) lines.push(cur);
    return lines.join('\n');
  }).join('\n');
}

export function kv(pairs: [string, unknown][]): string {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${c.dim(k.padEnd(w))}  ${v === undefined || v === null || v === '' ? c.dim('-') : String(v)}`).join('\n');
}

// ---------------------------------------------------------------- the --json / --quiet contract (items 104, 220)
/**
 * Did a command already write its JSON document? `ok()` and `info()` are prose and have no place in a JSON stream,
 * but a command whose ONLY output is `ok()` (`logout`, `stop`, `config set`) must still say something a script can
 * read — so their messages are kept here and written as one `{ok:true,message}` document at the end, and only when
 * nothing else was emitted. One command, one document, always.
 */
let jsonEmitted = false;
const jsonNotes: string[] = [];

/** The id of the thing a mutating command just affected — what `--quiet` prints, the way git and kubectl do. */
function affectedId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const anchor = d.anchor as Record<string, unknown> | undefined;
  const job = d.job as Record<string, unknown> | undefined;
  for (const v of [d.patch_id, anchor?.id, d.dataset_id, d.job_id, job?.id, d.id]) {
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/**
 * Print according to context. `--json` wins over `--quiet` (item 104: `--json --quiet` used to print nothing at
 * all), `--quiet` prints the id of whatever was affected and nothing else, and a terminal gets `render(data)`.
 */
export function emit<T>(ctx: CliContext, data: T, render: (d: T) => string | void): T {
  if (ctx.json) { jsonEmitted = true; process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return data; }
  if (ctx.quiet) { const id = affectedId(data); if (id) process.stdout.write(id + '\n'); return data; }
  const s = render(data);
  if (typeof s === 'string') process.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
  return data;
}

/**
 * One step of a batch (`ainize use a b c`, item 219): a terminal still gets every step's own lines, but the JSON
 * document belongs to the command, not to each step — the batch writes one at the end.
 */
export function emitStep<T>(ctx: CliContext, batched: boolean, data: T, render: (d: T) => string | void): T {
  if (batched && ctx.json) return data;
  return emit(ctx, data, render);
}

/** End of a command: under `--json`, a command that only spoke through `ok()` still owes the script one document. */
export function flushJson(ctx: CliContext): void {
  if (!ctx.json || jsonEmitted || !jsonNotes.length) return;
  jsonEmitted = true;
  process.stdout.write(JSON.stringify({ ok: true, message: jsonNotes.join('\n') }, null, 2) + '\n');
}

/**
 * A failure as a document (item 104). `--json` used to answer every error with `error: <prose>` on stderr and
 * nothing on stdout, so a CI job had to string-match the prose and could never read the reason the node gave —
 * which `CliError.details` has been carrying all along.
 */
export function jsonError(err: { message?: string; exitCode?: number; details?: unknown }, command: string | null, code: number): void {
  const body: Record<string, unknown> = { error: { message: err.message ?? 'failed', code, command: command ?? undefined } };
  if (err.details !== undefined) (body.error as Record<string, unknown>).details = err.details;
  process.stderr.write(JSON.stringify(body, null, 2) + '\n');
}

/**
 * Ask before doing something irreversible (item 102). Three answers, and none of them is a guess:
 *  - a terminal gets the question and must answer `y`;
 *  - `--yes` is the answer given in advance;
 *  - anything else (a pipe, a cron, a CI job) is REFUSED, because a script that never saw the question has not
 *    agreed to anything. Silence is not consent when the next step spends money.
 */
/**
 * A yes/no question whose *no* is not a cancellation (design §13: "also needs {name} ({price}); buy both? [y/N]").
 *
 * `confirm` cannot express this: its no throws, and here a no still buys the one thing that was asked for. Nothing
 * is ever assumed — without a terminal, and when the answer was pre-given with a flag, the default stands and the
 * caller says so in its own words. It never spends money on its own: the purchase is confirmed by `confirm` after.
 */
export async function ask(ctx: CliContext, question: string, opts: { default?: boolean; skip?: boolean } = {}): Promise<boolean> {
  const def = opts.default ?? false;
  if (opts.skip || !process.stdin.isTTY || ctx.json || ctx.quiet) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(`${question} `, (a) => { rl.close(); res(a.trim().toLowerCase()); }));
  if (!answer) return def;
  return answer === 'y' || answer === 'yes';
}

export async function confirm(ctx: CliContext, question: string, opts: { yes?: boolean; flag?: string } = {}): Promise<void> {
  const flag = opts.flag ?? '--yes';
  if (opts.yes) { info(ctx, c.dim(`${question} ${flag}`)); return; }
  if (!process.stdin.isTTY) throw new CliError(`refusing to continue without an answer: stdin is not a terminal, so nobody can be asked. Pass ${flag} to answer in advance.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(`${question} `, (a) => { rl.close(); res(a.trim().toLowerCase()); }));
  if (answer !== 'y' && answer !== 'yes') throw new CliError('cancelled — nothing was bought, nothing was charged', 130);
}

export function info(ctx: CliContext, msg: string) {
  if (ctx.json) { jsonNotes.push(msg.replace(ANSI, '')); return; }
  if (!ctx.quiet) process.stdout.write(msg + '\n');
}
/** The tick is decoration for a terminal; a JSON note keeps the sentence and nothing else. */
export function ok(ctx: CliContext, msg: string) {
  if (ctx.json) { jsonNotes.push(msg.replace(ANSI, '')); return; }
  info(ctx, c.ok('✓ ') + msg);
}
export function warn(ctx: CliContext, msg: string) { if (!ctx.quiet) process.stderr.write(c.warn('! ') + msg + '\n'); }

// ---------------------------------------------------------------- the wait (item 105)
/** What a slow command can say about itself while it waits. `note` replaces the line's tail as the node reports it. */
export interface Progress { note(msg: string | null): void }

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Run something slow with the terminal told what is happening (item 105). Every heavy verb here is one awaited fetch
 * behind a shared GPU lock — up to 30 minutes — and printed nothing at all until it finished, which is
 * indistinguishable from a hang.
 *
 * stdout stays pipe-clean: the clock is written to stderr, and only when stderr is a terminal. A non-terminal (CI, a
 * cron log) gets one line every 30 s instead of an animation, and `--json` / `--quiet` get nothing at all.
 */
export async function withProgress<T>(ctx: CliContext, label: string, fn: (p: Progress) => Promise<T>): Promise<T> {
  const tty = !!process.stderr.isTTY;
  const silent = ctx.json || ctx.quiet;
  let tail: string | null = null;
  let lastLine = 0;
  const p: Progress = { note: (m) => {
    tail = m;
    // a log file gets the queue when it changes and at most every 30 s, not a new line every poll
    if (!silent && !tty && m && Date.now() - lastLine > 30_000) { lastLine = Date.now(); process.stderr.write(c.dim(`… ${m}\n`)); }
  } };
  if (silent) return fn(p);
  const t0 = Date.now();
  let frame = 0;
  let printed = 0;
  const secs = () => Math.round((Date.now() - t0) / 1000);
  const clear = () => { if (tty && printed) { process.stderr.write('\r' + ' '.repeat(printed) + '\r'); printed = 0; } };
  const draw = () => {
    // one line, never wider than the terminal: a wrapped spinner cannot be erased by a carriage return
    const line = clip(`${FRAMES[frame++ % FRAMES.length]} ${label} · ${secs()}s${tail ? ` · ${tail}` : ''}`, Math.max(20, (process.stderr.columns || 80) - 1));
    clear();
    process.stderr.write(c.dim(line));
    printed = width(line);
  };
  const timer = tty
    ? setInterval(draw, 100)
    : setInterval(() => { lastLine = Date.now(); process.stderr.write(c.dim(`… still waiting for ${label} (${secs()}s)${tail ? ` · ${tail}` : ''}\n`)); }, 30_000);
  timer.unref?.();
  try {
    if (tty) draw();
    return await fn(p);
  } finally {
    clearInterval(timer);
    clear();
  }
}
