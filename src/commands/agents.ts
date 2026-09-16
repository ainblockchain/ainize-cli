/**
 * `ainize agent ls|add|rm|on|off|card|call` — the A2A agents this node gives a public address to.
 *
 * The node has had an agent registry since agents were first proxied (`ainize-node/src/agents.ts`): it reads
 * `config.json`, serves each agent at `/agents/<id>`, rewrites the card's `url` to the public one and reports
 * whether the process behind it is answering. What it did not have was a way in. Registering an agent meant
 * hand-editing JSON, and the only way to find out whether it worked was to load the explorer in a browser.
 *
 * So: `add`/`rm`/`on`/`off` write the same config the node reads, `ls` renders what `/api/agents` already
 * computed, and `call` posts the JSON-RPC a workspace would post — through the node's own public path, so what
 * is exercised here is exactly what a stranger gets.
 */
import { randomUUID } from 'node:crypto';
import type { NodeAgentConfig } from '@ainize/core';
import { configPath, saveConfig } from '@ainize/core';
import { NodeClient } from '../client.js';
import { CliError, PROG, type CliContext } from '../context.js';
import { c, confirm, emit, fmtTime, info, ok, table, withProgress } from '../output.js';

/** What `/api/agents` returns per agent — the card summary plus how the node is finding it. */
export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  skills: { id: string; name: string; description?: string; tags: string[]; examples: string[] }[];
  protocols: string[];
  extensions: string[];
  provider: string | null;
  documentation_url: string | null;
  a2a_url: string;
  card_url: string;
  proxy_url?: string;
  reachable: boolean | null;
  last_checked: number | null;
  error: string | null;
  calls: number;
  last_call_at: number | null;
}

/** The A2UI extension, by URI prefix — the version moves (v0.8 → v0.9) and the column should not. */
const A2UI = 'a2ui.org';
const drawsUi = (a: AgentRow) => a.extensions.some((uri) => uri.includes(A2UI));

const idOk = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);

/**
 * An agent that is not answering is the normal state during setup, not an error — the process is started
 * separately from its registration. The reason is what makes the difference actionable, so it is shown next to
 * the state rather than swallowed.
 */
function state(a: AgentRow): string {
  if (a.reachable === null) return c.dim('not checked');
  if (a.reachable) return c.ok('answering');
  return c.warn('no answer') + (a.error ? c.dim(` — ${a.error.slice(0, 48)}`) : '');
}

/** Read the config this home owns, or say why there is none. Every write command needs it. */
function ownConfig(ctx: CliContext) {
  if (!ctx.cfg) {
    throw new CliError(
      `no node config in ${ctx.home} — \`${PROG} init\` creates one. (\`${PROG} agent ls --node <url>\` reads someone else's node without one.)`,
      2,
    );
  }
  return ctx.cfg;
}

/**
 * Agents as configured here, which is NOT the same list `ls` shows: `ls` asks a node (possibly another
 * machine's) and only sees the enabled ones, because a disabled agent has no public address to report.
 */
const configured = (ctx: CliContext): NodeAgentConfig[] => ownConfig(ctx).agents ?? [];

function writeAgents(ctx: CliContext, agents: NodeAgentConfig[]): string {
  const cfg = ownConfig(ctx);
  cfg.agents = agents;
  return saveConfig(cfg, ctx.home);
}

/** A running node read its config at boot; a change on disk is not live until it restarts. */
function restartHint(ctx: CliContext): string {
  return c.dim(`  the node reads this at startup — \`${PROG} stop && ${PROG} start -d\` to pick it up.`);
}

export async function agentLs(ctx: CliContext): Promise<AgentRow[]> {
  const d = await new NodeClient(ctx).get<{ agents: AgentRow[] }>('/api/agents', { auth: false });
  const local = ctx.cfg ? configured(ctx) : [];
  const disabled = local.filter((a) => a.enabled === false);

  emit(ctx, d.agents, () => [
    table(d.agents, [
      { key: 'id', title: 'ID', get: (a: AgentRow) => a.id },
      { key: 'name', title: 'NAME', get: (a: AgentRow) => a.name },
      { key: 'skills', title: 'SKILLS', get: (a: AgentRow) => (a.skills.length ? String(a.skills.length) : c.dim('0')) },
      { key: 'ui', title: 'A2UI', get: (a: AgentRow) => (drawsUi(a) ? c.ok('draws') : c.dim('-')) },
      { key: 'calls', title: 'CALLS', get: (a: AgentRow) => String(a.calls) },
      { key: 'seen', title: 'CHECKED', get: (a: AgentRow) => (a.last_checked ? fmtTime(a.last_checked) : '-') },
      { key: 'state', title: 'STATE', get: state },
      { key: 'url', title: 'A2A URL', get: (a: AgentRow) => a.a2a_url },
    ], `no agents — \`${PROG} agent add <id> --upstream http://127.0.0.1:9200\``),
    ...(disabled.length
      ? ['', c.dim(`disabled here and therefore unpublished: ${disabled.map((a) => a.id).join(', ')} — \`${PROG} agent on <id>\``)]
      : []),
    ...(d.agents.some((a) => a.reachable === false)
      ? ['', c.dim('an agent with no answer is registered but its process is not up; the address stays reserved.')]
      : []),
  ].join('\n'));
  return d.agents;
}

export async function agentAdd(
  ctx: CliContext,
  id: string,
  opts: { upstream?: string; name?: string; description?: string; disabled?: boolean },
): Promise<void> {
  if (!idOk(id)) {
    throw new CliError(`agent id must be lowercase letters, digits and dashes (max 40) — got ${JSON.stringify(id)}`);
  }
  if (!opts.upstream) throw new CliError(`--upstream is required: where the agent process listens, e.g. http://127.0.0.1:9200`);
  // `new URL('localhost:9200')` PARSES — with protocol "localhost:" — so a missing scheme has to be caught by
  // checking the protocol, not by catching. Both spellings get the same suggestion (context.ts, item 116).
  let upstream: URL | null = null;
  try { upstream = new URL(opts.upstream); } catch { /* not a URL at all */ }
  if (!upstream || (upstream.protocol !== 'http:' && upstream.protocol !== 'https:')) {
    const guess = opts.upstream.replace(/^\w+:\/\//, '').replace(/^\/+/, '');
    throw new CliError(`--upstream must be a full http(s) URL — did you mean http://${guess}?`);
  }

  const agents = configured(ctx);
  if (agents.some((a) => a.id === id)) {
    throw new CliError(`agent ${id} is already registered — \`${PROG} agent rm ${id}\` first, or edit ${configPath(ctx.home)}`);
  }

  const entry: NodeAgentConfig = {
    id,
    upstream: opts.upstream.replace(/\/+$/, ''),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.disabled ? { enabled: false } : {}),
  };
  writeAgents(ctx, [...agents, entry]);

  const base = ctx.cfg?.publicUrl?.replace(/\/+$/, '') ?? `http://localhost:${ctx.cfg?.port}`;
  ok(ctx, `agent registered: ${id} → ${entry.upstream}`);
  info(ctx, [
    `  public address:  ${base}/agents/${id}`,
    `  agent card:      ${base}/agents/${id}/.well-known/agent-card.json`,
    restartHint(ctx),
  ].join('\n'));

  // Say now, not after a restart, whether anything is actually listening there.
  const probe = await probeCard(entry.upstream);
  if (probe.ok) info(ctx, c.dim(`  upstream answers: ${probe.name ?? '(card has no name)'}`));
  else info(ctx, c.dim(`  upstream is not answering yet (${probe.error}) — that is fine if the process is not started.`));
}

/** Ask an upstream for its card directly, the way the node will. */
async function probeCard(upstream: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  for (const path of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
    try {
      const r = await fetch(`${upstream.replace(/\/+$/, '')}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const card = (await r.json()) as { name?: string };
      return { ok: true, name: card?.name };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  return { ok: false, error: 'no agent card at any well-known path' };
}

export async function agentRm(ctx: CliContext, id: string, opts: { yes?: boolean } = {}): Promise<void> {
  const agents = configured(ctx);
  if (!agents.some((a) => a.id === id)) {
    throw new CliError(`no such agent here: ${id} — \`${PROG} agent ls\` lists them (nothing was changed)`);
  }
  await confirm(ctx, `remove agent ${id}? its public address stops resolving.`, { yes: opts.yes, flag: '--yes' });
  writeAgents(ctx, agents.filter((a) => a.id !== id));
  ok(ctx, `agent removed: ${id}`);
  info(ctx, restartHint(ctx));
}

export async function agentEnable(ctx: CliContext, id: string, enabled: boolean): Promise<void> {
  const agents = configured(ctx);
  const found = agents.find((a) => a.id === id);
  if (!found) throw new CliError(`no such agent here: ${id} — \`${PROG} agent ls\` lists them`);
  writeAgents(ctx, agents.map((a) => (a.id === id ? { ...a, enabled } : a)));
  ok(ctx, `agent ${id} ${enabled ? 'enabled' : 'disabled'}`);
  info(ctx, restartHint(ctx));
}

/** The card as the node serves it — what a workspace reads when someone pastes the URL. */
export async function agentCard(ctx: CliContext, id: string): Promise<unknown> {
  const card = await new NodeClient(ctx).get<Record<string, unknown>>(
    `/agents/${id}/.well-known/agent-card.json`,
    { auth: false },
  );
  emit(ctx, card, () => {
    const skills = (card.skills as { id: string; name: string; examples?: string[] }[] | undefined) ?? [];
    const caps = (card.capabilities ?? {}) as { streaming?: boolean; extensions?: { uri: string }[] };
    return [
      `${c.bold(String(card.name ?? id))}  ${c.dim(String(card.version ?? ''))}`,
      card.description ? String(card.description) : '',
      '',
      `${c.dim('a2a url')}    ${String(card.url ?? '-')}`,
      `${c.dim('protocol')}   ${String(card.protocolVersion ?? '-')}${caps.streaming ? c.dim(' · streaming') : ''}`,
      `${c.dim('extensions')} ${(caps.extensions ?? []).map((e) => e.uri).join(', ') || c.dim('(none)')}`,
      '',
      table(skills, [
        { key: 'id', title: 'SKILL', get: (s) => s.id },
        { key: 'name', title: 'NAME', get: (s) => s.name },
        { key: 'ex', title: 'EXAMPLE', get: (s) => s.examples?.[0] ?? '-' },
      ], 'the card declares no skills — a listing can only show its name'),
    ].join('\n');
  });
  return card;
}

/** One A2A part, in either spelling a card may use. */
type Part = { kind?: string; text?: string; data?: unknown; metadata?: { mimeType?: string } };

const A2UI_MIME = 'application/json+a2ui';

/**
 * Send a message the way a workspace does: JSON-RPC `message/send` to the agent's public path.
 *
 * Silence is not failure — an agent that heard and chose not to reply returns no text part, which is how it
 * stays quiet in a busy channel. That is reported as silence rather than as an error.
 */
export async function agentCall(ctx: CliContext, id: string, prompt: string): Promise<unknown> {
  if (!prompt.trim()) throw new CliError('nothing to say — `' + PROG + ` agent call ${id} "your question"\``);
  const body = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: prompt }],
      },
    },
  };

  const reply = await withProgress(ctx, `${id} is working`, () =>
    new NodeClient(ctx).post<Record<string, any>>(`/agents/${id}`, body, { auth: false, timeoutMs: 600_000 }),
  );

  if (reply?.error) {
    throw new CliError(`${id} refused: ${reply.error.message ?? JSON.stringify(reply.error)}`, 1, reply.error);
  }

  const result = reply?.result ?? {};
  const parts: Part[] = result?.status?.message?.parts ?? result?.parts ?? [];
  const text = parts.filter((p) => p.kind === 'text' && p.text).map((p) => p.text).join('\n');
  const surfaces = parts.filter((p) => p.metadata?.mimeType === A2UI_MIME).length;

  emit(ctx, reply, () => [
    text || c.dim('(the agent answered with no text — silence is a valid A2A reply)'),
    ...(surfaces
      ? ['', c.dim(`+ ${surfaces} A2UI message(s): this agent also describes its answer as a drawable surface.`)]
      : []),
  ].join('\n'));
  return reply;
}
