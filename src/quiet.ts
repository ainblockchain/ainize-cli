/**
 * eccrypto (via ain-util) prints "secp256k1 unavailable, reverting to browser version" to stdout when its native
 * binding is missing, which would corrupt `--json` output. Drop that line.
 *
 * Imported by `bin.ts` — dynamically, and before the CLI itself, so this runs first. It must keep importing
 * nothing: see the note in bin.ts about why the graph cannot be linked before the version check.
 */
const NOISE = /secp256k1 unavailable/;
for (const k of ['log', 'info', 'warn'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => { if (typeof args[0] === 'string' && NOISE.test(args[0])) return; orig(...args); };
}
export {};
