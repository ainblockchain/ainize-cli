/**
 * Where a detached node keeps its pid and its log, and whether that process is alive. Shared by the lifecycle
 * commands and by `config set`, which must know whether an edit will only take effect at the next start.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const pidFile = (home: string): string => join(home, 'node.pid');
export const logFile = (home: string): string => join(home, 'node.log');

/** The pid of a node started with `start -d` from this home, or null when there is no live process for it. */
export function runningPid(home: string): number | null {
  const p = pidFile(home);
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, 'utf8').trim());
  if (!Number.isFinite(pid)) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}
