/**
 * Zig: static-gated CALLS edges.
 *
 * Verifies that calls inside `if (CONST_FALSE)` branches (and trivial
 * boolean-and / boolean-or extensions) get tagged with
 * `staticGated: true` on the emitted CALLS edge, while calls outside
 * such branches keep `staticGated` falsy.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Zig static-gated edges', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'zig-static-gating'),
      () => {},
    );
  }, 60000);

  function isGated(callee: string): boolean | undefined {
    const calls = getRelationships(result, 'CALLS').filter((e) => e.target === callee);
    if (calls.length === 0) return undefined;
    // If any caller-edge to `callee` carries staticGated, treat as gated.
    return calls.some((c) => c.rel.staticGated === true);
  }

  it('tags calls inside `if (UPGRADERS_ENABLED)` as staticGated', () => {
    expect(isGated('gated_simple')).toBe(true);
  });

  it('tags `if (FALSE and other)` as staticGated (and-left)', () => {
    expect(isGated('gated_and_left')).toBe(true);
  });

  it('tags `if (other and FALSE)` as staticGated (and-right)', () => {
    expect(isGated('gated_and_right')).toBe(true);
  });

  it('tags `if (FALSE or FALSE)` as staticGated', () => {
    expect(isGated('gated_or_both_false')).toBe(true);
  });

  it('does NOT tag unconditional calls', () => {
    expect(isGated('live_unconditional')).toBe(false);
  });

  it('does NOT tag calls under `if (TRUE_CONST)`', () => {
    expect(isGated('live_under_true_const')).toBe(false);
  });

  it('does NOT tag `if (FALSE or TRUE)` (disjunction is true)', () => {
    expect(isGated('live_or_one_true')).toBe(false);
  });

  it('does NOT tag calls under unknown / runtime conditions', () => {
    expect(isGated('live_under_unknown')).toBe(false);
  });

  it('does NOT tag calls under `if (var FOO = false)` (var is mutable global, not const)', () => {
    expect(isGated('live_under_var')).toBe(false);
  });

  it('tags `if (FOO == true)` when FOO is false', () => {
    expect(isGated('gated_eq_true')).toBe(true);
  });

  it('tags `if (FOO == false)` when FOO is true', () => {
    expect(isGated('gated_eq_false')).toBe(true);
  });

  it('tags `if (FOO != false)` when FOO is false', () => {
    expect(isGated('gated_neq_false')).toBe(true);
  });

  it('tags `if (FOO != true)` when FOO is true', () => {
    expect(isGated('gated_neq_true')).toBe(true);
  });

  it('does NOT tag `if (false == FOO)` when FOO is false (provably TRUE)', () => {
    expect(isGated('live_sym_eq')).toBe(false);
  });
});
