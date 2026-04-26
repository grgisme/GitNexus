// gitnexus/src/core/ingestion/call-extractors/zig-static-gating.ts

/**
 * Zig static-gating resolver — file-local pass.
 *
 * Detects calls inside `if (CONST_FALSE)` blocks (and trivial boolean
 * extensions: `and`, `or`, simple negation) so the call edge can be
 * tagged with `staticGated: true`.  The flag lets impact-analysis
 * consumers filter out paper-tiger callers that live in dead branches
 * gated behind a comptime-known `false` constant.
 *
 * Conservative by design: we only tag an edge when we can prove the
 * gating expression evaluates to `false`.  Anything ambiguous → live.
 *
 * This commit lands the file-local resolver and the ancestor walker.
 * Cross-file `cfg.FOO` resolution arrives in a follow-up commit.
 *
 * Out of scope:
 *   - Cross-file flag references (handled in a follow-up commit).
 *   - Re-aliasing (`const FOO = OTHER;`).
 *   - Runtime-evaluated bools (`const FOO = computeIt();`).
 *   - Comparison ops in conditions (`==`, `!=`, `<`, …).
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';

/** Maximum number of `if_statement` ancestors we walk above a call. */
const MAX_IF_ANCESTORS = 5;

/** Maximum recursion depth when evaluating a boolean condition expression. */
const MAX_COND_DEPTH = 4;

/** A definite truth value, or `undefined` for "unknown / cannot prove". */
type TriBool = boolean | undefined;

/**
 * Per-file table of comptime-known booleans:
 *   `pub const FOO: bool = false;`  →  Map { 'FOO' → false }
 *   `pub const BAR = true;`         →  Map { 'BAR' → true }
 *
 * Constants whose RHS is anything other than a bare `boolean` literal
 * (e.g. function calls, struct accesses) are intentionally absent —
 * they resolve to `undefined`.
 */
export type ZigBoolConstMap = ReadonlyMap<string, boolean>;

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------

/**
 * Walk the top-level of a Zig source file and collect known-bool
 * constants.  Only `variable_declaration` nodes with an immediate
 * `boolean` child as the RHS qualify.
 *
 * The function is intentionally permissive about modifier tokens
 * (`pub`, `const`, optional type annotation): we look at the named
 * children of the `variable_declaration` and pick out (a) the first
 * `identifier` (the name) and (b) a direct `boolean` child (the
 * value).  Any other shape — a call, field access, struct literal —
 * yields no entry.
 */
export function buildZigBoolConstMap(rootNode: SyntaxNode): ZigBoolConstMap {
  const out = new Map<string, boolean>();
  for (const child of rootNode.namedChildren) {
    if (child.type !== 'variable_declaration') continue;
    const entry = extractBoolConst(child);
    if (entry) out.set(entry.name, entry.value);
  }
  return out;
}

function extractBoolConst(decl: SyntaxNode): { name: string; value: boolean } | null {
  let name: string | undefined;
  let value: boolean | undefined;

  for (const c of decl.namedChildren) {
    if (c.type === 'identifier' && name === undefined) {
      name = c.text;
      continue;
    }
    if (c.type === 'boolean') {
      const t = c.text;
      if (t === 'true') value = true;
      else if (t === 'false') value = false;
    }
  }

  if (name !== undefined && value !== undefined) {
    return { name, value };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ancestor walk + condition evaluation
// ---------------------------------------------------------------------------

/**
 * Decide whether a call expression sits inside an `if (FALSE)` branch
 * using only file-local constants.
 *
 * Walks up to {@link MAX_IF_ANCESTORS} `if_statement` ancestors and
 * evaluates each condition.  Returns `true` if any one of them
 * provably evaluates to `false`.
 *
 * Note: we don't currently distinguish the THEN vs ELSE branch.  Most
 * dead-code patterns we care about (`if (FOO) { ... }` without an
 * `else`) put the gated body in the THEN branch, and the inverse
 * (`if (FOO) {} else { gated body }`) is rare enough in practice that
 * we accept the false-negative.
 */
export function isCallStaticGated(
  callNode: SyntaxNode,
  localBools: ZigBoolConstMap,
): boolean {
  let current: SyntaxNode | null = callNode.parent;
  let ifCount = 0;
  while (current && ifCount < MAX_IF_ANCESTORS) {
    if (current.type === 'if_statement') {
      ifCount++;
      const cond = findIfCondition(current);
      if (cond) {
        const result = evalCond(cond, localBools, 0);
        if (result === false) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/** Pick the condition node out of an `if_statement`. The condition is
 * the first named child (the body / else branches come after). */
function findIfCondition(ifNode: SyntaxNode): SyntaxNode | null {
  return ifNode.namedChildren[0] ?? null;
}

/**
 * Evaluate a boolean condition expression to a tribool.
 *
 * Handles only the shapes we can resolve symbolically; everything else
 * returns `undefined` ("unknown — treat as live").
 */
function evalCond(
  node: SyntaxNode,
  localBools: ZigBoolConstMap,
  depth: number,
): TriBool {
  if (depth > MAX_COND_DEPTH) return undefined;

  switch (node.type) {
    case 'boolean': {
      // Bare literal: `if (false)`.
      if (node.text === 'true') return true;
      if (node.text === 'false') return false;
      return undefined;
    }

    case 'identifier': {
      // Bare flag check: `if (FOO)`.
      const v = localBools.get(node.text);
      return v === undefined ? undefined : v;
    }

    case 'binary_expression': {
      // `lhs and rhs` / `lhs or rhs`.
      const op = findOperatorToken(node);
      const lhs = node.namedChildren[0];
      const rhs = node.namedChildren[1];
      if (!lhs || !rhs) return undefined;
      const l = evalCond(lhs, localBools, depth + 1);
      const r = evalCond(rhs, localBools, depth + 1);
      if (op === 'and') {
        // `false and *` = false; `* and false` = false.
        if (l === false || r === false) return false;
        if (l === true && r === true) return true;
        return undefined;
      }
      if (op === 'or') {
        // Only `false or false` is provably false.
        if (l === false && r === false) return false;
        if (l === true || r === true) return true;
        return undefined;
      }
      return undefined;
    }

    case 'error_union_type': {
      // tree-sitter-zig misparses prefix `!FOO` (boolean negation) as
      // `error_union_type` because the same `!` token is used for
      // error-union types.  We handle the pragmatic case: a single
      // resolvable identifier inside an `error_union_type` whose
      // immediate parent is an `if_statement` condition position.
      const inner = node.namedChildren[0];
      if (!inner) return undefined;
      const v = evalCond(inner, localBools, depth + 1);
      if (v === undefined) return undefined;
      return !v;
    }

    default:
      return undefined;
  }
}

/**
 * Pull the textual operator (e.g. "and", "or") out of a
 * `binary_expression`.  In tree-sitter-zig, the operator is an
 * anonymous child token whose `type` equals the operator string.
 */
function findOperatorToken(binExpr: SyntaxNode): string | undefined {
  for (let i = 0; i < binExpr.childCount; i++) {
    const c = binExpr.child(i);
    if (!c) continue;
    if (!c.isNamed) {
      if (c.type === 'and' || c.type === 'or') return c.type;
    }
  }
  return undefined;
}
