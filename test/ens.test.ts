/**
 * `ainize patch <name.eth>` — the resolution half, which is the half that can be tested without a node.
 *
 * The namehash vectors are the two every ENS implementation is checked against. They are here because the
 * hash has to come from keccak256 and node's built-in `sha3-256` is NOT keccak256 — same output length,
 * different padding, plausible-looking wrong answers. A test that only checked "returns 32 bytes" would pass
 * on the wrong hash, which is the shape of failure this project has spent its time removing.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksLikeEnsName, namehash, namesFileCandidates, resolveName } from '../src/ens.js';

test('namehash reproduces the canonical ENS vectors', () => {
  assert.equal(namehash(''), `0x${'0'.repeat(64)}`);
  assert.equal(namehash('eth'), '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
  assert.equal(namehash('vitalik.eth'), '0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835');
});

test('namehash is case-insensitive on the label, as ENSIP-1 requires', () => {
  assert.equal(namehash('VITALIK.ETH'), namehash('vitalik.eth'));
});

test('a knowledge id is not mistaken for a name', () => {
  // The failure this guards is a friendly one: `ainize patch krx-all-2761` should say "that is an id, use
  // `patch get`", not attempt a resolution and report that the name has no resolver.
  assert.equal(looksLikeEnsName('krx-all-2761'), false);
  assert.equal(looksLikeEnsName('graph-r1-armc'), false);
  assert.equal(looksLikeEnsName('http://localhost:3402'), false);
  assert.equal(looksLikeEnsName('vaults.defi.engram.eth'), true);
  assert.equal(looksLikeEnsName('engram.eth'), true);
});

test('a names file resolves both halves the old command line supplied by hand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ens-'));
  const file = join(dir, 'names.json');
  writeFileSync(file, JSON.stringify({
    'vaults.defi.engram.eth': { node: 'http://their-node:3402', patch: 'graph-r1-armc' },
  }));
  const r = await resolveName('vaults.defi.engram.eth', { namesFile: file });
  assert.equal(r.node, 'http://their-node:3402');   // the --node of `patch ls`
  assert.equal(r.patch, 'graph-r1-armc');           // the <id> of `use`
  assert.equal(r.source, 'names-file');
  assert.equal(r.where, file);
});

test('resolution is case-insensitive on the name the user types', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ens-'));
  const file = join(dir, 'names.json');
  writeFileSync(file, JSON.stringify({ 'a.engram.eth': { node: 'http://n:1', patch: 'p' } }));
  const r = await resolveName('A.Engram.ETH', { namesFile: file });
  assert.equal(r.patch, 'p');
});

test('an entry missing either half is not a resolution', async () => {
  // Half an answer is worse than none: it would send the buy at a node with no id, or an id with no seller.
  const dir = mkdtempSync(join(tmpdir(), 'ens-'));
  const file = join(dir, 'names.json');
  writeFileSync(file, JSON.stringify({ 'half.engram.eth': { node: 'http://n:1' } }));
  await assert.rejects(() => resolveName('half.engram.eth', { namesFile: file }), /cannot resolve/);
});

test('the config names block resolves when no file does', async () => {
  const r = await resolveName('cfg.engram.eth', {
    namesFile: join(mkdtempSync(join(tmpdir(), 'ens-')), 'absent.json'),
    config: { names: { 'cfg.engram.eth': { node: 'http://n:2', patch: 'q' } } },
  });
  assert.equal(r.source, 'config');
  assert.equal(r.node, 'http://n:2');
});

test('failure names every path it tried, and never guesses a registry address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ens-'));
  await assert.rejects(
    () => resolveName('missing.engram.eth', { namesFile: join(dir, 'absent.json'), rpc: 'http://rpc.invalid' }),
    (e: Error) => {
      // Both halves of the message matter. "cannot resolve" alone sends someone to the wrong place.
      assert.match(e.message, /Tried:/);
      assert.match(e.message, /on-chain \(no registry address given\)/);
      assert.match(e.message, /never assumed/);
      return true;
    },
  );
});

test('the names-file search order is explicit and puts an explicit file first', () => {
  const c = namesFileCandidates({ namesFile: '/x/names.json', home: '/home/n' });
  assert.equal(c[0], '/x/names.json');
  assert.equal(c[1], join('/home/n', 'names.json'));
  assert.ok(c[2].endsWith(join('.ainize', 'names.json')));
});
