/**
 * The key this CLI signs with, and why it has one of its own.
 *
 * A command line cannot open a wallet prompt. It also should not hold the person's wallet key: copying a key that
 * owns real money onto every laptop that runs a command is the thing wallets exist to stop. So the CLI generates
 * its OWN key, keeps it here, and signs with it — an ordinary AIN identity, the same kind of thing the node's own
 * key is, verified by the same code.
 *
 * On its own that key is nobody. What makes it somebody is a binding: `ainize login` asks a person to approve it
 * in a browser, once, and the node writes down that this key acts as them. From then on the CLI signs in with
 * nothing but this file, and the session it gets belongs to the person — while the key that made it is recorded,
 * so they can end that machine without ending the others.
 *
 * WHAT THIS FILE IS WORTH. Whoever can read it can act as its owner on any node that has a binding for it, until
 * they revoke it. That is exactly as much as an ssh key is worth and is written with the same care: 0600, in
 * AINIZE_HOME, never printed, never sent — only its ADDRESS ever leaves this machine. It is separate from
 * config.json's identity on purpose: that one is the NODE, and a node's key signing for a person would make every
 * laptop that ran a node into that person.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createIdentity, identityFromPrivateKey } from '@ainize/core';

export interface CliKey { privateKey: string; address: string; created_at: number; label?: string }

export function cliKeyPath(home: string): string { return join(home, 'cli-key.json'); }

export function readCliKey(home: string): CliKey | null {
  const p = cliKeyPath(home);
  if (!existsSync(p)) return null;
  try {
    const k = JSON.parse(readFileSync(p, 'utf8')) as Partial<CliKey>;
    if (typeof k.privateKey !== 'string') return null;
    // The address is derived, never trusted from the file: a hand-edited or half-written one would otherwise make
    // the CLI ask a person to authorise an address that cannot sign.
    return { privateKey: k.privateKey, address: identityFromPrivateKey(k.privateKey).address, created_at: k.created_at ?? 0, label: k.label };
  } catch { return null; }
}

/** The key for this machine, made on first use. Stable after that: re-generating it would orphan every binding. */
export function ensureCliKey(home: string, label?: string): CliKey {
  const existing = readCliKey(home);
  if (existing) return existing;
  const id = createIdentity();
  const key: CliKey = { privateKey: id.privateKey, address: id.address, created_at: Date.now(), label };
  mkdirSync(home, { recursive: true });
  writeFileSync(cliKeyPath(home), JSON.stringify(key, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(cliKeyPath(home), 0o600); } catch { /* a filesystem without modes; the file is still ours */ }
  return key;
}

export function forgetCliKey(home: string): boolean {
  const p = cliKeyPath(home);
  if (!existsSync(p)) return false;
  // Overwritten before unlinking: a private key left in a freed block is the one thing worth the extra syscall.
  try { writeFileSync(p, '0'.repeat(256), { mode: 0o600 }); } catch { /* best effort */ }
  try { unlinkSync(p); } catch { return false; }
  return true;
}

/** What this machine calls itself when it asks to be authorised. Its own words — the node never vouches for them. */
export function defaultLabel(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? '';
  let host = '';
  try { host = hostname(); } catch { /* a container with no hostname */ }
  const name = [user, host].filter(Boolean).join('@');
  return (name || 'a command line').slice(0, 60);
}
