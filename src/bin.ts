#!/usr/bin/env node
/**
 * The launcher, and the reason it is separate from `main.ts`.
 *
 * Storage is `node:sqlite`, a built-in that does not exist before Node 22.5. On an older runtime the failure is:
 *
 *   Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 *
 * which names neither ainize nor the version it wanted. `engines` is declared, but npm only warns and installs
 * anyway, and that warning is one line among the install scripts' own.
 *
 * A check cannot simply live at the top of the CLI. An ES module's imports are RESOLVED AND LINKED before any
 * body executes — the whole graph, not just the first import — so a `node:sqlite` anywhere in it throws before
 * a single line of ours has run. (This was tried on Node 20 and crashed exactly as before.)
 *
 * So this file imports nothing statically. It checks the version, then loads the real CLI dynamically, which is
 * the point at which the graph is linked at all.
 */

/** `node:sqlite` landed in Node 22.5.0. package.json asks for 24; this is the floor below which nothing loads. */
const MIN = [22, 5] as const;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN[0] || (major === MIN[0] && minor < MIN[1])) {
  process.stderr.write(
    `ainize needs Node ${MIN[0]}.${MIN[1]} or newer, and this is Node ${process.versions.node}.\n`
    + '\n'
    + '  Its storage is `node:sqlite`, a built-in your version does not have — so it would fail while loading,\n'
    + '  with an error naming neither ainize nor the version it wanted.\n'
    + '\n'
    + "  nvm install 24 && nvm use 24     (or your distribution's Node 24 package)\n"
    + '  node -v && npm install -g ainize\n',
  );
  process.exit(78);   // EX_CONFIG — the environment is wrong, not the command
}

await import('./quiet.js');
await import('./main.js');
