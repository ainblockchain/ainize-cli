/**
 * `ainize chat` — live-test a knowledge patch (ChatMode): ask the serving model the same question *before*
 * and *after* the patch is loaded, and see whether the answer became the benchmark's expected one.
 *
 *   ainize chat --list                                   patches whose bodies are on this node → testable
 *   ainize chat pixelplus-087600 "Pixelplus ticker code? Digits only."   one-shot compare (base vs patched)
 *   ainize chat pixelplus-087600                         interactive REPL (transcript kept, /quit to exit)
 *   ainize chat --patch krx-all-2761,pixelplus-087600 "…"  load up to 3 knowledges together (list order; the last wins on overlap)
 */
import { createInterface } from 'node:readline';
import type { CatalogEntry, RuntimeStatus } from '@ngram/core';
import { NodeClient } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, info, table } from '../output.js';

export type ChatMode = 'base' | 'patched' | 'compare';
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatArgs { mode?: ChatMode; thinking?: boolean; maxTokens?: number; system?: string }

export interface ChatAnswer {
  content: string; reasoning?: string | null; usage?: Record<string, unknown>; latency_ms: number; model: string;
  /** D1 — the model got stuck repeating itself (answer cut here) or ran out of budget. */
  truncated?: 'repetition' | 'length' | null; shown_chars?: number; raw_chars?: number; raw_content?: string;
}
export interface ChatApplied { patch_id: string; applied_ms: number | null; was_applied: boolean }
export interface ChatResponse {
  patch_id: string;
  /** every knowledge loaded for this answer, in load order (nodes before teach mode omit it) */
  patch_ids?: string[];
  mode: ChatMode | string;
  base: ChatAnswer | null;
  patched: ChatAnswer | null;
  /** sum over all loaded knowledges */
  applied_ms: number | null;
  was_applied: boolean;
  model: string | null;
  /** OR over benchmark_hits */
  benchmark_hit?: boolean | null;
  applied?: ChatApplied[];
  benchmark_hits?: Record<string, boolean | null>;
  remaining_quota: number | null;
}
export interface ChatPatchesResponse {
  items: CatalogEntry[]; runtime: RuntimeStatus; lock: { owner: string; label: string; since: number } | null;
  /** knowledge the operator keeps loaded for everyone (part of every "before" answer) */
  applied?: string[];
  overlaps?: { a: string; b: string; rows: number }[];
}

/** Up to 3 knowledges per live test (server limit). */
export const MAX_CHAT_PATCHES = 3;

/** `a,b,c` / repeated values → unique trimmed ids (1..3). */
export function parsePatchIds(input: string | string[] | undefined): string[] {
  const raw = Array.isArray(input) ? input : input ? [input] : [];
  const ids = [...new Set(raw.flatMap((s) => String(s).split(/[,\s+]+/)).map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new CliError(`patch id required — \`${PROG} chat --list\` shows what this node can test`);
  if (ids.length > MAX_CHAT_PATCHES) throw new CliError(`at most ${MAX_CHAT_PATCHES} knowledges can be loaded together (got ${ids.length})`);
  return ids;
}

const CHAT_TIMEOUT_MS = 15 * 60_000;   // apply + two generations on a busy runtime

/** `ainize chat --list` → GET /api/chat/patches */
export async function chatPatches(ctx: CliContext): Promise<ChatPatchesResponse> {
  const d = await new NodeClient(ctx).get<ChatPatchesResponse>('/api/chat/patches');
  emit(ctx, d, (x) => {
    const rt = x.runtime;
    const head = rt.available
      ? `${c.ok('runtime ready')}  model ${c.bold(rt.model ?? '?')}  ${rt.hook ? 'live-apply hook on' : c.warn('no live-apply hook')}${rt.applied.length ? `  applied: ${rt.applied.join(', ')}` : ''}`
      : c.warn(`runtime unavailable${rt.error ? ` — ${rt.error}` : ''}`) + c.dim('  (chat needs a serving node; pass --node <url> of one)');
    const lock = x.lock ? c.dim(`runtime busy: ${x.lock.label} by ${x.lock.owner} since ${new Date(x.lock.since).toLocaleTimeString()}`) : '';
    const pinned = x.applied?.length ? c.warn(`always loaded on this node (part of every "before" answer): ${x.applied.join(', ')}`) : '';
    const overlaps = x.overlaps?.length ? c.dim('overlapping memory entries: ' + x.overlaps.map((o) => `${o.a} ∩ ${o.b} = ${o.rows.toLocaleString('en-US')}`).join('; ')) : '';
    return [head, lock, pinned, overlaps, table(x.items, [
      { key: 'id', title: 'ID', get: (e) => c.id(e.anchor.id) },
      { key: 'name', title: 'NAME', get: (e) => e.anchor.name },
      { key: 'model', title: 'MODEL', get: (e) => e.anchor.model.id_M },
      { key: 'facts', title: 'FACTS', get: (e) => String(e.anchor.benchmark.queries), align: 'right' },
      { key: 'rows', title: 'MEMORY ROWS', get: (e) => e.anchor.rows.toLocaleString('en-US'), align: 'right' },
      { key: 'att', title: 'VERIFIED', get: (e) => { const s = `${e.passed}/${e.quorum}`; return e.quorum_ok ? c.ok(s + ' ✓') : c.warn(s); }, align: 'right' },
      { key: 'sample', title: 'TRY', get: (e) => { const s = e.anchor.benchmark.samples?.[0]; return s ? `${JSON.stringify(s.prompt.trim())} → ${s.expect}` : c.dim('-'); } },
    ], 'no testable patch on this node — its body must be held here (seller node, or `' + PROG + ' patch buy <id>` first)'),
    x.items.length ? c.dim(`\n${PROG} chat <ID> "<question>"   or   ${PROG} chat <ID>   for an interactive session   (${PROG} chat --patch a,b loads up to ${MAX_CHAT_PATCHES} together)`) : ''].filter(Boolean).join('\n');
  });
  return d;
}

/** One request → POST /api/chat. One id sends `patch_id` (works on every node); several send `patch_ids` (teach-mode nodes). */
export async function chatOnce(ctx: CliContext, patchIds: string | string[], messages: ChatMessage[], a: ChatArgs = {}): Promise<ChatResponse> {
  if (!messages.some((m) => m.role === 'user' && m.content.trim())) throw new CliError('prompt is empty');
  const ids = parsePatchIds(patchIds);
  const target = ids.length === 1 ? { patch_id: ids[0] } : { patch_ids: ids };
  const body = { ...target, mode: a.mode ?? 'compare', messages, max_tokens: a.maxTokens ?? 200, thinking: !!a.thinking };
  return new NodeClient(ctx).post<ChatResponse>('/api/chat', body, { timeoutMs: CHAT_TIMEOUT_MS });
}

const marker = (hit: boolean | null | undefined): string => (hit === true ? c.ok('correct ✓ (benchmark)') : hit === false ? c.err('wrong ✗ (benchmark)') : c.dim('(no benchmark sample for this question)'));

function answerBlock(label: string, ans: ChatAnswer | null, extra: string[], showThinking: boolean): string {
  if (!ans) return '';
  const meta = [`${ans.latency_ms} ms`, ...extra].join(' · ');
  const lines = [`${c.head(label)}  ${c.dim(meta)}`];
  if (showThinking && ans.reasoning) lines.push(c.dim(ans.reasoning.trim().split('\n').map((l) => '  ┆ ' + l).join('\n')));
  lines.push(ans.content.trim() ? ans.content.trim().split('\n').map((l) => '  ' + l).join('\n') : c.dim('  (empty answer)'));
  // D1: say why the answer stops where it does — a silent cut reads as a wrong answer.
  if (ans.truncated === 'repetition') lines.push(c.dim(`  — the model started repeating itself, so the answer is cut here (showing ${ans.shown_chars} of ${ans.raw_chars} characters; usually the question is outside what this knowledge covers)`));
  else if (ans.truncated === 'length') lines.push(c.dim('  — the answer stopped at the length limit before it was finished'));
  return lines.join('\n');
}

/** Pretty-print a chat response: both answers, latency / applied ms and the correct-answer marker. */
export function renderChat(r: ChatResponse, a: ChatArgs = {}): string {
  const showThinking = !!a.thinking;
  const out: string[] = [];
  out.push(answerBlock('before (base model)', r.base, [], showThinking));
  const ids = r.patch_ids?.length ? r.patch_ids : [r.patch_id];
  const perPatch = r.applied?.length ? r.applied : [{ patch_id: r.patch_id, applied_ms: r.applied_ms, was_applied: r.was_applied }];
  const loadNote = (x: ChatApplied) => (x.applied_ms !== null ? `loaded in ${x.applied_ms} ms` : x.was_applied ? 'already loaded' : '');
  const patchedExtra = ids.length === 1
    ? [loadNote(perPatch[0])].filter(Boolean)
    : [perPatch.map((x, i) => `${i + 1}. ${x.patch_id}${loadNote(x) ? ` (${loadNote(x)})` : ''}`).join(' → ')];
  out.push(answerBlock(`after (${ids.length === 1 ? ids[0] : `${ids.length} knowledges`} loaded)`, r.patched, patchedExtra, showThinking));
  const foot: string[] = [];
  if (r.patched) {
    if (ids.length > 1 && r.benchmark_hits) foot.push(...ids.map((id) => `${c.id(id)}: ${marker(r.benchmark_hits?.[id])}`));
    else foot.push(marker(r.benchmark_hit));
  }
  if (r.model) foot.push(c.dim(`model ${r.model}`));
  if (r.remaining_quota !== null && r.remaining_quota !== undefined) foot.push(c.dim(`free live tests left this hour: ${r.remaining_quota}`));
  out.push(foot.join('  '));
  return out.filter(Boolean).join('\n\n');
}

export function initialMessages(a: ChatArgs): ChatMessage[] {
  return a.system ? [{ role: 'system', content: a.system }] : [];
}

/** One-shot: `ainize chat <patchId>[,<id2>] <prompt>` */
export async function chat(ctx: CliContext, patchIds: string | string[], prompt: string, a: ChatArgs = {}): Promise<ChatResponse> {
  const r = await chatOnce(ctx, patchIds, [...initialMessages(a), { role: 'user', content: prompt }], a);
  emit(ctx, r, (x) => renderChat(x, a));
  return r;
}

/** The answer that continues the conversation: the patched (ainized) one when present, else the base one. */
export function assistantTurn(r: ChatResponse): string | null {
  return r.patched?.content ?? r.base?.content ?? null;
}

export interface ReplState { transcript: ChatMessage[]; turns: number; mode: ChatMode }

/**
 * Interactive REPL: reads lines from stdin, keeps the transcript (system + user + the model's answer with the
 * patch loaded), `/quit` to exit. Slash commands: /mode base|patched|compare, /reset, /help.
 */
export async function chatRepl(ctx: CliContext, patchIds: string | string[], a: ChatArgs = {}, io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<ReplState> {
  const ids = parsePatchIds(patchIds);
  const state: ReplState = { transcript: initialMessages(a), turns: 0, mode: a.mode ?? 'compare' };
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const tty = !!(input as NodeJS.ReadStream).isTTY;
  const rl = createInterface({ input, output: tty ? output : undefined, prompt: c.bold('you> '), terminal: tty });
  const say = (s: string) => { if (!ctx.quiet && !ctx.json) output.write(s + '\n'); };
  say(c.dim(`live test of ${ids.map((x) => c.id(x)).join(' + ')} · mode ${state.mode} · /quit to exit, /help for commands`));

  const handle = async (line: string): Promise<boolean> => {
    const text = line.trim();
    if (!text) return true;
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case 'quit': case 'exit': case 'q': return false;
        case 'reset': state.transcript = initialMessages(a); say(c.dim('transcript cleared')); return true;
        case 'mode': {
          const m = rest[0] as ChatMode | undefined;
          if (m === 'base' || m === 'patched' || m === 'compare') { state.mode = m; say(c.dim(`mode → ${m}`)); } else say(c.warn('usage: /mode base|patched|compare'));
          return true;
        }
        case 'help': default:
          say([`/mode base|patched|compare  (now: ${state.mode})`, '/reset   forget the transcript', '/quit    exit'].join('\n'));
          return true;
      }
    }
    const messages = [...state.transcript, { role: 'user' as const, content: text }];
    try {
      const r = await chatOnce(ctx, ids, messages, { ...a, mode: state.mode });
      state.turns++;
      const reply = assistantTurn(r);
      state.transcript = [...messages, ...(reply ? [{ role: 'assistant' as const, content: reply }] : [])].slice(-24);
      if (ctx.json) output.write(JSON.stringify(r) + '\n');
      else if (!ctx.quiet) say(renderChat(r, a) + '\n');
    } catch (e) {
      const err = e as CliError;
      if (err instanceof CliError && err.exitCode === 2) throw err;   // node gone — stop the loop
      say(c.err('error: ') + (err.message ?? String(e)));
    }
    return true;
  };

  // Serialise line handling so a fast paste does not fire overlapping requests.
  let chain: Promise<boolean> = Promise.resolve(true);
  let alive = true;
  await new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      if (!alive) return;
      rl.pause();
      chain = chain.then(async (cont) => {
        if (!cont) return false;
        const next = await handle(line).catch((e) => { say(c.err('error: ') + (e as Error).message); return false; });
        if (!next) { alive = false; rl.close(); return false; }
        rl.resume(); if (tty) rl.prompt();
        return true;
      });
    });
    rl.on('close', () => { alive = false; chain.then(() => resolve(), () => resolve()); });
    if (tty) rl.prompt();
  });
  if (!ctx.json) info(ctx, c.dim(`bye — ${state.turns} turn(s)`));
  return state;
}
