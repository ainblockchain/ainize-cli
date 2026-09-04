/**
 * What the CLI says when the command line itself is wrong (item 103).
 *
 * yargs' own answers are written for whoever wrote the parser: `Not enough non-option arguments: got 0, need at
 * least 1` for `ainize publish`, `Unknown argument: statsu` for a one-character typo. Everything needed to answer
 * properly is already in the command's own help — its usage line, its positionals, its options, its examples — so
 * this module reads that help back and turns the parser's complaint into the sentence the person needed.
 *
 * Nothing here is a second copy of the command tree: the facts come from the help text yargs prints for the level
 * that failed, which is generated from the declarations in bin.ts.
 */

/** One command's help, as read back from the block yargs printed for it. */
export interface HelpFacts {
  /** the first line of the usage block: `ainize patch publish <file>` */
  usage: string;
  /** the command words in front of the first positional: `ainize patch publish` */
  path: string;
  /** every subcommand registered at this level, by its own word (`ls`, `get`, `publish`) */
  commands: string[];
  /** every option this level accepts, with dashes (`--price`, `-y`) */
  options: string[];
  /** each positional and what it is for */
  positionals: { name: string; describe: string | null }[];
  /** the option describes, so a missing `--benchmark` can be named in the command's own words */
  describes: Record<string, string>;
  /** the first `.example()`, command and description */
  example: { cmd: string; desc: string } | null;
}

const BLOCK = /^(Commands|Options|Positionals|Examples):$/;
/** The `[string] [required] [default: 3]` column yargs prints after a description — a type, not a sentence. */
const TYPES = /(\s*\[(?:string|number|boolean|array|count|required|deprecated|hidden|default:[^\]]*|choices:[^\]]*)\])+$/;

/** `ainize patch publish <file>` → `ainize patch publish` (stop at the first `<positional>` or `[option]`). */
function pathOf(usage: string): string {
  const out: string[] = [];
  for (const tok of usage.split(/\s+/)) { if (tok.startsWith('<') || tok.startsWith('[')) break; out.push(tok); }
  return out.join(' ');
}

/** `ainize patch get <id>` in a Commands: block → `get`: the word that names the subcommand at this level. */
function commandWord(line: string, depth: number): string | null {
  const toks = line.trim().split(/\s+/);
  const word = toks[depth];
  return word && /^[a-z0-9][\w:-]*$/i.test(word) ? word : null;
}

/**
 * Read a printed help block back into the facts an error message needs.
 *
 * yargs lays every block out the same way: two spaces, the name, two or more spaces, the description, and a type
 * column at the end. A description too long for the terminal wraps onto lines indented past the name column, so
 * those are folded back onto the entry they belong to instead of being read as another entry.
 */
export function readHelp(text: string): HelpFacts {
  const lines = text.split('\n');
  const usage = lines.find((l) => l.trim())?.trim() ?? '';
  const path = pathOf(usage);
  const depth = path.split(' ').filter(Boolean).length;
  const facts: HelpFacts = { usage, path, commands: [], options: [], positionals: [], describes: {}, example: null };

  // the indented lines under each `Commands:` / `Options:` / `Positionals:` / `Examples:` heading
  const blocks = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const head = BLOCK.exec(line.trim());
    if (head) { cur = []; blocks.set(head[1], cur); continue; }
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) { cur = null; continue; }
    cur?.push(line);
  }

  /**
   * Where an entry starts, per block: an option always begins with a dash (`  -h, --help` sits two columns left of
   * `      --price`, so an indent rule would fold every long option into the short-alias one above it); a command
   * and an example always begin with the program name; a positional is at the block's own left edge. Everything
   * indented past that is a description too long for the terminal, and is folded back into the entry it belongs to.
   */
  const prog = path.split(' ')[0];
  const entriesOf = (block: string): { name: string; desc: string; raw: string }[] => {
    const src = blocks.get(block) ?? [];
    if (!src.length) return [];
    const left = Math.min(...src.map((l) => l.length - l.trimStart().length));
    const isEntry = (line: string): boolean => {
      const body = line.trim();
      if (block === 'Options') return /^-{1,2}[A-Za-z0-9]/.test(body);
      if (block === 'Commands' || block === 'Examples') return body.split(/\s+/)[0] === prog;
      return line.length - line.trimStart().length <= left;
    };
    const out: { name: string; desc: string; raw: string }[] = [];
    for (const line of src) {
      const body = line.trim();
      const more = body.replace(TYPES, '').trim();
      if (!isEntry(line) && out.length) {
        const prev = out[out.length - 1];
        // a wrapped description when there is one, otherwise the rest of a long command
        if (prev.desc) prev.desc = `${prev.desc} ${more}`.trim(); else prev.name = `${prev.name} ${more}`.trim();
        prev.raw = `${prev.raw} ${more}`.trim();
        continue;
      }
      const at = body.search(/\s{2,}/);
      out.push({ name: (at === -1 ? body : body.slice(0, at)).trim(), desc: (at === -1 ? '' : body.slice(at)).replace(TYPES, '').trim(), raw: more });
    }
    return out;
  };

  for (const e of entriesOf('Commands')) { const w = commandWord(e.raw, depth); if (w && !facts.commands.includes(w)) facts.commands.push(w); }
  for (const e of entriesOf('Options')) {
    for (const n of e.name.split(/,\s*/)) if (n.startsWith('-')) { facts.options.push(n); if (e.desc) facts.describes[n] = e.desc; }
  }
  for (const e of entriesOf('Positionals')) facts.positionals.push({ name: e.name, describe: e.desc || null });
  const ex = entriesOf('Examples')[0];
  if (ex) facts.example = { cmd: ex.name, desc: ex.desc };
  return facts;
}

/** Levenshtein distance, for "did you mean". */
export function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = t;
    }
  }
  return prev[b.length];
}

/** The closest candidate within a small edit distance, or null when nothing is close enough to suggest. */
export function nearest(word: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const cand of candidates) {
    const d = distance(word.toLowerCase(), cand.toLowerCase());
    if (d < bestD && d <= Math.max(2, Math.floor(cand.length / 3))) { best = cand; bestD = d; }
  }
  return best;
}

export interface UsageError { message: string; hints: string[]; command: string }

const list = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Turn a yargs failure into the answer the person needed: what is missing or misspelled, in the command's own
 * words, with its usage line and its first worked example underneath.
 */
export function explainUsageError(msg: string | null, err: Error | undefined, help: string, argv: string[]): UsageError {
  const f = readHelp(help);
  const cmd = f.path || argv.filter((a) => !a.startsWith('-'))[0] || '';
  const seeHelp = f.path ? `try \`${f.path} --help\`` : 'try `--help`';
  const example = f.example ? [`example:`, `  ${f.example.cmd}${f.example.desc ? `   # ${f.example.desc}` : ''}`] : [];
  const usageLine = f.usage ? [`usage: ${f.usage}`] : [];

  // A `.check()` or a coercion threw: it already speaks the user's language.
  if (err?.message) return { message: err.message, hints: [seeHelp], command: cmd };

  const m = msg ?? 'invalid command line';

  // The word the user typed where a subcommand belongs — the one yargs' own "Did you mean" never names.
  const typed = argv.filter((a) => !a.startsWith('-'));
  const depth = f.path.split(' ').filter(Boolean).length - 1;   // minus the program name
  const typo = typed[depth] ?? typed[typed.length - 1] ?? null;

  const recommend = /^Did you mean (.+)\?$/.exec(m);
  if (recommend) {
    const suggestion = recommend[1].replace(/\?$/, '');
    return {
      message: typo ? `unknown command "${typo}" — did you mean \`${f.path} ${suggestion}\`?` : `did you mean \`${f.path} ${suggestion}\`?`,
      hints: [`\`${f.path} --help\` lists every command here.`],
      command: cmd,
    };
  }

  const unknown = /^Unknown arguments?: (.+)$/.exec(m);
  if (unknown) {
    const names = unknown[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    const flags = names.filter((n) => argv.some((a) => a === `--${n}` || a === `-${n}` || a.startsWith(`--${n}=`)));
    const words = names.filter((n) => !flags.includes(n));
    const parts: string[] = [];
    const hints: string[] = [];
    for (const w of words) {
      const near = nearest(w, f.commands);
      parts.push(`unknown command "${w}"${near ? ` — did you mean \`${f.path} ${near}\`?` : ''}`);
    }
    for (const flag of flags) {
      const near = nearest(`--${flag}`, f.options);
      parts.push(`unknown option "--${flag}"${near ? ` — did you mean \`${near}\`?` : ''}`);
    }
    if (words.length && !words.some((w) => nearest(w, f.commands))) hints.push(`\`${f.path} --help\` lists every command here.`);
    if (!parts.length) parts.push(m);
    hints.push(seeHelp);
    return { message: parts.join('; '), hints, command: cmd };
  }

  if (/^Not enough non-option arguments/.test(m)) {
    const need = f.positionals.filter((p) => p.describe !== null);
    const what = need.length ? list(need.map((p) => `<${p.name}>`)) : 'an argument';
    const said = need.map((p) => `${p.name}: ${p.describe}`);
    return { message: `\`${f.path}\` needs ${what}`, hints: [...said, ...usageLine, ...example, seeHelp], command: cmd };
  }

  const missing = /^Missing required arguments?: (.+)$/.exec(m);
  if (missing) {
    const names = missing[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    const said = names.map((n) => (f.describes[`--${n}`] ? `--${n}: ${f.describes[`--${n}`]}` : null)).filter((x): x is string => !!x);
    return { message: `\`${f.path}\` needs ${list(names.map((n) => `--${n}`))}`, hints: [...said, ...usageLine, ...example, seeHelp], command: cmd };
  }

  // demandCommand: "Specify a command…" / "Subcommand is required (ls|add|rm)."
  if (/command is required|Specify a command|Give a dataset file/i.test(m)) {
    // `ainize --hepl` reaches demandCommand before strict() ever looks at the flag, and used to be reported as a
    // missing command. An option that no longer exists is an option, and is named as one.
    const bad = argv.filter((a) => /^--?[A-Za-z]/.test(a)).map((a) => a.split('=')[0])
      .filter((a) => !f.options.includes(a) && !f.options.includes(a.replace(/^--no-/, '--')));
    if (bad.length) {
      const near = nearest(bad[0], f.options);
      return { message: `unknown option "${bad[0]}"${near ? ` — did you mean \`${near}\`?` : ''}`, hints: [seeHelp], command: cmd };
    }
    // the demandCommand message already names them on most groups; only add the list when it does not
    const hints = f.commands.length && !/\(.+\|.+\)/.test(m) ? [`commands here: ${f.commands.join(', ')}`, seeHelp] : [seeHelp];
    return { message: m, hints, command: cmd };
  }

  return { message: m, hints: [seeHelp], command: cmd };
}
