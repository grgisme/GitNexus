/**
 * Unit Tests: cwd / path based repo resolution (#7771)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  pickByCwd,
  pickDeepestContaining,
  looksLikePath,
} from '../../src/mcp/local/repo-path-match.js';

describe('repo-path-match (#7771)', () => {
  let root: string;
  let a: string;
  let b: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pm-')));
    a = path.join(root, 'reclaim-ue-procgen');
    b = path.join(root, 'reclaim-ue-qa');
    outside = path.join(root, 'elsewhere');
    for (const d of [a, b, outside]) fs.mkdirSync(path.join(d, 'src', 'deep'), { recursive: true });
    for (const d of [a, b]) execFileSync('git', ['init', '-q'], { cwd: d });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const handles = () => [
    { id: 'reclaim-ue', name: 'reclaim-ue', repoPath: a },
    { id: 'reclaim-ue-x', name: 'reclaim-ue', repoPath: b },
  ];

  it('cwd inside clone b resolves to b, inside a to a', () => {
    expect(pickByCwd(handles(), path.join(b, 'src', 'deep'))?.repoPath).toBe(b);
    expect(pickByCwd(handles(), a)?.repoPath).toBe(a);
  });

  it('cwd outside every registered repo returns null (caller keeps the old error)', () => {
    expect(pickByCwd(handles(), outside)).toBeNull();
  });

  it('deepest registered path wins when repos are nested', () => {
    const inner = path.join(a, 'src');
    const hs = [...handles(), { id: 'inner', name: 'inner', repoPath: inner }];
    expect(pickByCwd(hs, path.join(a, 'src', 'deep'))?.repoPath).toBe(inner);
    expect(pickDeepestContaining(hs, a)?.repoPath).toBe(a);
  });

  it('does not match a sibling that only shares a name prefix', () => {
    const hs = [{ id: 'x', name: 'x', repoPath: path.join(root, 'reclaim-ue') }];
    expect(pickDeepestContaining(hs, a)).toBeNull();
  });

  it('looksLikePath distinguishes names from paths', () => {
    expect(looksLikePath('/home/x/repo')).toBe(true);
    expect(looksLikePath('./repo')).toBe(true);
    expect(looksLikePath('reclaim-ue@reclaim-ue-qa')).toBe(false);
    expect(looksLikePath('reclaim-ue')).toBe(false);
  });
});
