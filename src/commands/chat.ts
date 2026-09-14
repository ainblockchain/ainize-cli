/**
 * `ainize chat` — live-test a knowledge patch (ChatMode): ask the serving model the same question *before*
 * and *after* the patch is loaded, and see whether the answer became the benchmark's expected one.
 *
 *   ainize chat --list                                   patches whose bodies are on this node → testable
 *   ainize chat pixelplus-087600 "Pixelplus ticker code? Digits only."   one-shot compare (base vs patched)
 *   ainize chat pixelplus-087600                         interactive REPL (one transcript per column, /quit to exit)
 *   ainize chat --patch krx-all-2761,pixelplus-087600 "…"  load up to 3 knowledges together (list order; the last wins on overlap)
 */
import { createInterface } from 'node:readline';
import { verificationCount } from '@ainize/core';
import type { CatalogEntry, RuntimeStatus } from '@ainize/core';
import { NodeClient } from '../client.js';
import { readChatStream } from '../chat-stream.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, emit, fitLine, info, statusColor, table } from '../output.js';

export type ChatMode = 'base' | 'patched' | 'compare';
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatArgs { mode?: ChatMode; thinking?: boolean; maxTokens?: number; system?: string; onDelta?: (text: string, mode: string) => void }

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
  /** how many messages each column was sent, and whether the two conversations differed */
  history?: { base: number; patched: number; split: boolean };
}
/** A knowledge this node's model could run but cannot load, and why (item 297). */
export interface ElsewhereRow {
  patch_id: string; name: string; author: string; author_name: string | null;
  price: string; currency: string; status: string; rows: number; queries: number;
  reason: 'not_held' | 'not_licensed' | 'verify_only'; buyable: boolean; requests: number; gateway_url: string | null;
}
export interface ChatPatchesResponse {
  items: CatalogEntry[]; runtime: RuntimeStatus; lock: { owner: string; label: string; since: number } | null;
  /** knowledge the operator keeps loaded for everyone (part of every "before" answer) */
  applied?: string[];
  /** bodies a recent live test found on the shared model that this node never loaded (item 211) */
  dirty?: string[];
  /** knowledge this node could run but does not hold, or holds only because it verified it (item 297) */
  elsewhere?: ElsewhereRow[];
  overlaps?: { a: string; b: string; rows: number }[];
  /** whether the caller is this node's operator (drafts are listed only for them — item 108) */
  operator?: boolean;
}

/** One row of the picker table: a public entry, or the operator's own unannounced draft. */
interface PickerRowView { e: CatalogEntry; draft: boolean }

/** VERIFIED first, then what is still being verified, then drafts, then retired versions (item 107). */
const LIST_ORDER: Record<string, number> = { VERIFIED: 0, ANNOUNCED: 1, VERIFYING: 1, CHALLENGED: 2, DRAFT: 3, SUPERSEDED: 4, RETIRED: 5, REJECTED: 6 };

/**
 * The operator's own DRAFT knowledge whose body is on this node (item 108).
 *
 * `GET /api/chat/patches` answers with what the PUBLIC picker may test, and the node drops every DRAFT from that
 * list — while `POST /api/chat` loads one happily. So the publisher's "hold it back, try it, then announce" loop had
 * no discoverable path: the list that calls itself authoritative hid exactly what `--no-announce` exists for. The
 * drafts are read here from the two operator routes that already hold the facts (own anchors, held bodies), and a
 * draft trained for another model is left out for the same reason the node leaves one out of the public list.
 */
async function ownDrafts(ctx: CliContext, model: string | null): Promise<CatalogEntry[]> {
  const client = new NodeClient(ctx);
  const [mine, blobs] = await Promise.all([
    client.get<{ items: CatalogEntry[] }>('/api/me/patches').catch(() => null),
    client.get<{ items: { sha256: string }[] }>('/api/me/blobs').catch(() => null),
  ]);
  if (!mine || !blobs) return [];
  const held = new Set(blobs.items.map((b) => b.sha256));
  return mine.items.filter((e) => e.status === 'DRAFT' && held.has(e.anchor.patch_sha256)
    && (!model || e.anchor.model.id_M.startsWith(model)));
}

/**
 * Why nothing can be tested here (item 108). "no testable patch on this node" was one sentence for three different
 * situations, and one of them told the operator to buy a knowledge whose file is already in their own blob store.
 */
function emptyPicker(x: ChatPatchesResponse): string {
  const rt = x.runtime;
  const held = (x.elsewhere ?? []).filter((e) => e.reason !== 'not_held');
  if (!rt.available) return `nothing can be tested until this node's model server answers${rt.error ? ` (${rt.error})` : ''} — a live test needs a serving node (\`--node <url>\` of one).`;
  if (held.length) {
    return `${held.length} knowledge file(s) are on this node but none of them can be tested: `
      + held.map((e) => `${e.patch_id} (${e.reason === 'verify_only' ? 'held because this node verified it — verifying is not a licence' : 'never bought'})`).join('; ')
      + `\n${PROG} patch buy <id>   records the licence and makes it testable`;
  }
  if ((x.elsewhere ?? []).length) return `no knowledge file on this node yet — the ${x.elsewhere!.length} listed below are sold by other nodes (\`${PROG} patch buy <id>\`), or publish your own with \`${PROG} publish <file.npz>\`.`;
  return `no knowledge on this node yet${rt.model ? ` for ${rt.model}` : ''} — publish one with \`${PROG} publish <file.npz> …\`, or buy one from a peer (\`${PROG} patch ls\`).`;
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

/** `ainize chat --list` → GET /api/chat/patches, plus the operator's own drafts (item 108). */
export async function chatPatches(ctx: CliContext): Promise<ChatPatchesResponse> {
  const d = await new NodeClient(ctx).get<ChatPatchesResponse>('/api/chat/patches');
  const drafts = d.operator ? await ownDrafts(ctx, d.runtime.model ?? null) : [];
  emit(ctx, { ...d, drafts }, (x) => {
    const rt = x.runtime;
    const head = rt.available
      ? `${c.ok('runtime ready')}  model ${c.bold(rt.model ?? '?')}  ${rt.hook ? 'live-apply hook on' : c.warn('no live-apply hook')}${rt.applied.length ? `  applied: ${rt.applied.join(', ')}` : ''}`
      : c.warn(`runtime unavailable${rt.error ? ` — ${rt.error}` : ''}`) + c.dim('  (chat needs a serving node; pass --node <url> of one)');
    const lock = x.lock ? c.dim(`runtime busy: ${x.lock.label} by ${x.lock.owner} since ${new Date(x.lock.since).toLocaleTimeString()}`) : '';
    const pinned = x.applied?.length ? c.warn(`always loaded on this node (part of every "before" answer): ${x.applied.join(', ')}`) : '';
    // Item 211 — a body on the shared model that this node never loaded: the next live test unloads it and does not put it back.
    const dirty = x.dirty?.length ? c.warn(`left on the shared model by something else (this node did not load it): ${x.dirty.join(', ')} — a live test unloads it first and does not put it back`) : '';
    // Item 216 — an overlap between two bodies that are NOT loaded decides nothing about the answers this node
    // gives. The loaded pairs are printed with what they mean; the rest are counted and left alone.
    const loadedIds = new Set(x.applied ?? []);
    const livePairs = (x.overlaps ?? []).filter((o) => loadedIds.has(o.a) && loadedIds.has(o.b));
    const restPairs = (x.overlaps?.length ?? 0) - livePairs.length;
    const overlaps = livePairs.length
      ? c.warn('loaded together and overlapping: ') + livePairs.map((o) => `${o.a} ∩ ${o.b} = ${o.rows.toLocaleString('en-US')} entries (the one loaded later wins on them)`).join('; ')
        + (restPairs ? c.dim(`  (+${restPairs} more overlapping pair(s) among held bodies that are not loaded)`) : '')
      : restPairs ? c.dim(`${restPairs} pair(s) of held bodies overlap; none of them are loaded together, so nothing is being overridden right now`) : '';
    // Item 297 — what this node's model could run but cannot load: it used to be missing from this list entirely.
    const why: Record<string, string> = {
      not_held: 'not on this node',
      verify_only: 'held only because this node verified it — verifying is not a licence',
      not_licensed: 'body here, never bought',
    };
    const elsewhere = x.elsewhere?.length
      ? [c.head('not on this node (buy it to test or teach on it)'), table(x.elsewhere, [
        { key: 'id', title: 'ID', get: (e) => c.id(e.patch_id) },
        { key: 'name', title: 'NAME', get: (e) => e.name },
        { key: 'price', title: 'PRICE', get: (e) => `${e.price} ${e.currency}`, align: 'right' },
        { key: 'from', title: 'SELLER', get: (e) => e.author_name ?? e.author.slice(0, 10) + '…' },
        { key: 'why', title: 'WHY', get: (e) => c.dim(why[e.reason] ?? e.reason) },
        { key: 'ask', title: 'ASKED FOR', get: (e) => (e.requests ? `${e.requests}×` : c.dim('-')), align: 'right' },
      ]), c.dim(`${PROG} patch buy <ID>   then   ${PROG} chat <ID> "<question>"`)].join('\n')
      : '';
    /*
     * Item 107 — four rows of `2/2 ✓` in green, one of them the knowledge on sale and three of them training runs
     * it retired months ago. The status is on every one of these objects and was simply not printed, so a buyer
     * spent one of twenty free tries an hour on a version nobody sells any more and was never told a newer one
     * exists. Retired rows stay (a point-in-time version is legitimately testable) and are dimmed, sorted last, and
     * footnoted with what replaced them; a green tick is never printed unqualified on a retired row.
     */
    const rows: PickerRowView[] = [
      ...x.items.map((e) => ({ e, draft: false })),
      ...(drafts.map((e) => ({ e, draft: true }))),
    ].sort((p, q) => (LIST_ORDER[p.e.status] ?? 9) - (LIST_ORDER[q.e.status] ?? 9) || q.e.anchor.created_at - p.e.anchor.created_at);
    const retired = (r: PickerRowView) => r.e.status === 'SUPERSEDED' || r.e.status === 'RETIRED';
    const dimIf = (r: PickerRowView, s: string) => (retired(r) ? c.dim(s) : s);
    const superseded = rows.filter((r) => r.e.superseded_by.length);
    const sameModel = new Set(rows.map((r) => r.e.anchor.model.id_M)).size <= 1;
    // Item 115 — the widest thing on this screen was never the table but the prose around it (the overlaps line
    // measured 293 display columns). Tables fit themselves; these are wrapped to the same budget.
    return [...[head, lock, pinned, dirty, overlaps].map((l) => (l ? fitLine(l) : l)), table(rows, [
      { key: 'id', title: 'ID', get: (r) => (retired(r) ? c.dim(r.e.anchor.id) : c.id(r.e.anchor.id)) },
      { key: 'name', title: 'NAME', get: (r) => dimIf(r, r.e.anchor.name) },
      { key: 'status', title: 'STATUS', get: (r) => statusColor(r.e.status) + (r.draft ? c.dim(' (yours)') : '') },
      ...(sameModel ? [] : [{ key: 'model', title: 'MODEL', get: (r: PickerRowView) => r.e.anchor.model.id_M }]),
      { key: 'facts', title: 'FACTS', get: (r) => String(r.e.anchor.benchmark.queries), align: 'right' as const },
      { key: 'rows', title: 'MEMORY ROWS', get: (r) => r.e.anchor.rows.toLocaleString('en-US'), align: 'right' as const },
      { key: 'att', title: 'VERIFIED', get: (r) => {
        if (r.draft) return c.dim('not announced');
        const v = verificationCount(r.e);
        const s = v.extra ? `${v.fraction}+${v.extra}` : v.fraction;
        return r.e.quorum_ok ? (retired(r) ? c.dim(s + ' ✓') : c.ok(s + ' ✓')) : c.warn(s);
      }, align: 'right' as const },
      { key: 'sample', title: 'TRY', get: (r) => { const s = r.e.anchor.benchmark.samples?.[0]; return s ? dimIf(r, `${JSON.stringify(s.prompt.trim())} → ${s.expect}`) : c.dim('-'); } },
    ], emptyPicker(x)),
    ...superseded.map((r) => c.dim(fitLine(`  ${r.e.anchor.id} → superseded by ${r.e.superseded_by.join(', ')} (a newer version of the same subject — test that one unless you need this exact version)`, 4))),
    drafts.length ? c.dim(fitLine(`  ${drafts.length} DRAFT row(s) are your own knowledge, not announced: only this node can test them (\`${PROG} patch announce <id>\` publishes one).`, 4)) : '',
    rows.length ? '\n' + c.dim(fitLine(`${PROG} chat <ID> "<question>"   or   ${PROG} chat <ID>   for an interactive session   (${PROG} chat --patch a,b loads up to ${MAX_CHAT_PATCHES} together)`)) : '',
    elsewhere ? '\n' + elsewhere : ''].filter(Boolean).join('\n');
  });
  return d;
}

/** One request → POST /api/chat. One id sends `patch_id` (works on every node); several send `patch_ids` (teach-mode nodes). */
export async function chatOnce(ctx: CliContext, patchIds: string | string[], messages: ChatMessage[], a: ChatArgs = {}, split?: { base: ChatMessage[]; patched: ChatMessage[] }): Promise<ChatResponse> {
  if (!messages.some((m) => m.role === 'user' && m.content.trim())) throw new CliError('prompt is empty');
  const ids = parsePatchIds(patchIds);
  const target = ids.length === 1 ? { patch_id: ids[0] } : { patch_ids: ids };
  // Compare mode past the first turn: each column replays its OWN earlier answers (see ReplState below).
  const histories = split ? { messages_base: split.base, messages_patched: split.patched } : {};
  const body = { ...target, mode: a.mode ?? 'compare', messages, ...histories, max_tokens: a.maxTokens ?? 200, thinking: !!a.thinking };
  if (a.onDelta) {
    const response = await new NodeClient(ctx).request<Response>('/api/chat', { method: 'POST', body: { ...body, stream: true },
      headers: { accept: 'text/event-stream' }, raw: true, timeoutMs: CHAT_TIMEOUT_MS });
    return readChatStream<ChatResponse>(response, a.onDelta);
  }
  return new NodeClient(ctx).post<ChatResponse>('/api/chat', body, { timeoutMs: CHAT_TIMEOUT_MS });
}

// ---------------------------------------------------------------- the benchmark behind the verdict (item 106)
/** One question of a knowledge's published benchmark, as the anchor carries it. */
export interface BenchSample { prompt: string; expect: string }
/** What was scored for one knowledge on this turn: the sample the question matched, and the first sample as a hint. */
export interface BenchMatch { matched: BenchSample | null; first: BenchSample | null }

/** Shortest question that may be matched to a sample by containment — the node's own floor (market.ts BENCH_MATCH_MIN). */
const BENCH_MATCH_MIN = 8;

/**
 * Which published sample a question is scored against. This is the node's rule (`matchBenchmarkSample` in
 * packages/node/src/market.ts, mirrored again in the web's chat/util.ts): trimmed equality first — so a sample sent
 * verbatim, trailing space and all, scores against itself — then containment, and only for questions long enough
 * that "코드" cannot match a ticker nobody asked about.
 */
export function matchBenchmarkSample(samples: BenchSample[] | undefined, userText: string): BenchSample | null {
  const u = (userText ?? '').trim();
  if (!u || !samples?.length) return null;
  const exact = samples.find((x) => x.prompt.trim() === u);
  if (exact) return exact;
  if (u.length < BENCH_MATCH_MIN) return null;
  return samples.find((x) => u.includes(x.prompt.trim()) || x.prompt.trim().includes(u)) ?? null;
}

/** The published benchmark samples of each knowledge in a live test (one public GET each; a failure just means no hint). */
export async function benchmarksFor(ctx: CliContext, ids: string[]): Promise<Map<string, BenchSample[]>> {
  const client = new NodeClient(ctx);
  const out = new Map<string, BenchSample[]>();
  await Promise.all(ids.map(async (id) => {
    const d = await client.get<{ anchor?: { benchmark?: { samples?: BenchSample[] } } }>(`/api/patches/${encodeURIComponent(id)}`).catch(() => null);
    const s = d?.anchor?.benchmark?.samples;
    if (s?.length) out.set(id, s);
  }));
  return out;
}

/** What each loaded knowledge was scored on for this question. */
export function benchMatches(samples: Map<string, BenchSample[]>, question: string, ids: string[]): Record<string, BenchMatch> {
  const out: Record<string, BenchMatch> = {};
  for (const id of ids) {
    const list = samples.get(id);
    if (!list?.length) continue;
    out[id] = { matched: matchBenchmarkSample(list, question), first: list[0] ?? null };
  }
  return out;
}

const shortAnswer = (s: string | null | undefined): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? JSON.stringify(t.length > 40 ? t.slice(0, 40) + '…' : t) : '(nothing)';
};

/**
 * The verdict, with the value it was measured against (item 106).
 *
 * `correct ✓` on its own asks the reader to take a tick on faith, and `wrong ✗` on its own cannot tell a knowledge
 * that failed from a question that missed the trained phrasing — the commonest cause on prompts that end in a
 * significant trailing space. The expected value is in the anchor the CLI already has, so it is printed beside the
 * verdict; when nothing was scored, the phrasing that WOULD be scored is printed instead.
 */
const marker = (hit: boolean | null | undefined, m?: BenchMatch, answer?: string | null): string => {
  if (hit === true) return c.ok('correct ✓ (benchmark)') + (m?.matched ? c.dim(` — the benchmark expects ${JSON.stringify(m.matched.expect)}`) : '');
  if (hit === false) {
    return c.err('wrong ✗ (benchmark)')
      + (m?.matched ? ` — expected ${c.ok(JSON.stringify(m.matched.expect))}, the model answered ${c.err(shortAnswer(answer))}` : '');
  }
  return c.dim('(no benchmark sample for this question)')
    + (m?.first ? c.dim(` — this knowledge is scored on ${JSON.stringify(m.first.prompt)} → ${m.first.expect}; ask that phrasing to be scored`) : '');
};

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

/**
 * Pretty-print a chat response: both answers, latency / applied ms and the correct-answer marker.
 * `bench` (item 106) is what each knowledge publishes as its benchmark, so the verdict can name the expected value.
 */
export function renderChat(r: ChatResponse, a: ChatArgs = {}, bench: Record<string, BenchMatch> = {}): string {
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
  const said = r.patched?.raw_content ?? r.patched?.content ?? null;
  if (r.patched) {
    if (ids.length > 1 && r.benchmark_hits) foot.push(...ids.map((id) => `${c.id(id)}: ${marker(r.benchmark_hits?.[id], bench[id], said)}`));
    else foot.push(marker(r.benchmark_hit, bench[ids[0]], said));
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
  const ids = parsePatchIds(patchIds);
  // Item 106: the expected value is on the anchor, not in the chat response — read it while the model answers and
  // print it with the verdict. `--json` gets it too, as `benchmark_samples`, so a script can report what a ✗ meant.
  const benchP = benchmarksFor(ctx, ids);
  const r = await chatOnce(ctx, ids, [...initialMessages(a), { role: 'user', content: prompt }], { ...a, onDelta: a.onDelta ?? livePreview(ctx) });
  const bench = benchMatches(await benchP, prompt, ids);
  emit(ctx, { ...r, benchmark_samples: bench }, (x) => renderChat(x, a, bench));
  return r;
}

/**
 * The answer that continues the conversation: the patched (ainized) one when present, else the base one.
 * The REPL keeps a transcript per column instead (see chatRepl) — this stays for one-shot callers and scripts.
 */
export function assistantTurn(r: ChatResponse): string | null {
  return r.patched?.content ?? r.base?.content ?? null;
}

function livePreview(ctx: CliContext): ChatArgs['onDelta'] {
  if (ctx.json || ctx.quiet) return undefined;
  let previousMode = '';
  return (text, mode) => {
    if (mode !== previousMode) { process.stderr.write(`\n${mode}:\n`); previousMode = mode; }
    process.stderr.write(text);
  };
}

/**
 * The REPL keeps ONE transcript per column. Replaying the patched answer to the un-patched model would tell it that
 * it already produced the knowledge's answer, and from the second turn the "before" column just repeats it — the
 * comparison would disprove itself. `transcript` stays as the patched (continuing) conversation for callers that
 * read it; `baseTranscript` is what the base column is replayed.
 */
export interface ReplState { transcript: ChatMessage[]; baseTranscript: ChatMessage[]; turns: number; mode: ChatMode }

/**
 * Interactive REPL: reads lines from stdin, keeps one transcript per column (system + user + that column's own
 * answer), `/quit` to exit. Slash commands: /mode base|patched|compare, /reset, /help.
 */
export async function chatRepl(ctx: CliContext, patchIds: string | string[], a: ChatArgs = {}, io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<ReplState> {
  const ids = parsePatchIds(patchIds);
  const state: ReplState = { transcript: initialMessages(a), baseTranscript: initialMessages(a), turns: 0, mode: a.mode ?? 'compare' };
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const tty = !!(input as NodeJS.ReadStream).isTTY;
  const rl = createInterface({ input, output: tty ? output : undefined, prompt: c.bold('you> '), terminal: tty });
  const say = (s: string) => { if (!ctx.quiet && !ctx.json) output.write(s + '\n'); };
  /** The knowledges' published benchmarks — fetched on the first question, not on `/quit` (item 106). */
  let samples: Map<string, BenchSample[]> | null = null;
  say(c.dim(`live test of ${ids.map((x) => c.id(x)).join(' + ')} · mode ${state.mode} · /quit to exit, /help for commands`));
  if (state.mode === 'compare') say(c.dim('follow-ups: each column replays only its own earlier answers — the base model is never shown the patched one'));

  const handle = async (line: string): Promise<boolean> => {
    const text = line.trim();
    if (!text) return true;
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case 'quit': case 'exit': case 'q': return false;
        case 'reset': state.transcript = initialMessages(a); state.baseTranscript = initialMessages(a); say(c.dim('transcript cleared')); return true;
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
    const ask = { role: 'user' as const, content: text };
    const messages = [...state.transcript, ask];
    const baseMessages = [...state.baseTranscript, ask];
    try {
      const r = await chatOnce(ctx, ids, state.mode === 'base' ? baseMessages : messages, { ...a, mode: state.mode, onDelta: a.onDelta ?? livePreview(ctx) },
        state.mode === 'compare' ? { base: baseMessages, patched: messages } : undefined);
      state.turns++;
      // Each column keeps only the turns IT answered: a question asked in `patched` mode never happened for the
      // base model, and its answer must not be replayed as if the base model had produced it.
      const grow = (prev: ChatMessage[], answer: string | null | undefined): ChatMessage[] =>
        (answer?.trim() ? [...prev, ask, { role: 'assistant' as const, content: answer }].slice(-24) : prev);
      state.transcript = grow(state.transcript, r.patched?.content);
      state.baseTranscript = grow(state.baseTranscript, r.base?.content);
      // Item 106 — the published benchmark, read once per session and matched against the question just asked.
      samples ??= await benchmarksFor(ctx, ids);
      const bench = benchMatches(samples, text, ids);
      if (ctx.json) output.write(JSON.stringify({ ...r, benchmark_samples: bench }) + '\n');
      else if (!ctx.quiet) say(renderChat(r, a, bench) + '\n');
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
