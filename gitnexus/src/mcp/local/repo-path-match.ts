/**
 * Path-based repo matching for the registry resolver (#7771).
 *
 * Pure helpers (no registry access) so they can be unit-tested without
 * mocking LadybugDB. Used by LocalBackend.resolveRepo to
 *   1. pick the repo whose registered path contains the caller's cwd, and
 *   2. accept an absolute (or ./ ../ relative) path as the `repo` parameter.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const canon = (p: string): string => {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
};

const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when `child` equals `parent` or lives below it. Both canonical. */
export const isPathInside = (parent: string, child: string): boolean => {
  const a = norm(parent);
  const b = norm(child);
  if (a === b) return true;
  const withSep = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(withSep);
};

/** True when a `repo` parameter should be treated as a filesystem path. */
export const looksLikePath = (param: string): boolean =>
  path.isAbsolute(param) ||
  param.startsWith('./') ||
  param.startsWith('../') ||
  param.startsWith('.\\') ||
  param.startsWith('..\\') ||
  param === '.' ||
  param === '..';

/**
 * Pick the handle whose repoPath contains `target`; the deepest (longest)
 * registered path wins. Returns null when none contains it.
 */
export const pickDeepestContaining = <T extends { repoPath: string }>(
  handles: Iterable<T>,
  target: string,
): T | null => {
  const t = canon(target);
  let best: T | null = null;
  let bestLen = -1;
  for (const h of handles) {
    const rp = canon(h.repoPath);
    if (isPathInside(rp, t) && rp.length > bestLen) {
      best = h;
      bestLen = rp.length;
    }
  }
  return best;
};

/** Git toplevel of `cwd`, or null when cwd is not inside a git repo. */
export const gitToplevel = (cwd: string): string | null => {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
      .toString()
      .trim();
    return out ? path.resolve(out) : null;
  } catch {
    return null;
  }
};

/**
 * Resolve the registered repo for a working directory. Deepest registered
 * path containing the cwd wins (so a registered monorepo subproject beats
 * its parent); if none contains the raw cwd, retry with the git toplevel.
 */
export const pickByCwd = <T extends { repoPath: string }>(
  handles: Iterable<T>,
  cwd: string,
): T | null => {
  const list = [...handles];
  const direct = pickDeepestContaining(list, cwd);
  if (direct) return direct;
  const top = gitToplevel(cwd);
  return top ? pickDeepestContaining(list, top) : null;
};
