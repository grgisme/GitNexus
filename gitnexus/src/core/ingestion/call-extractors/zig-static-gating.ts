// gitnexus/src/core/ingestion/call-extractors/zig-static-gating.ts

/**
 * Zig static-gating resolver.
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
 * v1 supports two scopes of resolution:
 *
 *   (a) **File-local** consts (`pub const FOO = false;`) — built per
 *       Zig file once and cached.
 *   (b) **One-hop @import alias** (`const cfg = @import("./cfg.zig");
 *       if (cfg.FOO) { ... }`) — resolved via the existing Zig import
 *       resolver, with a separate per-file alias map.
 *
 * Out of scope for v1:
 *   - Multi-hop: `cfg.sub.FOO` (we only handle one identifier dot one).
 *   - Re-exported consts across multiple files.
 *   - Runtime-evaluated bools (`const FOO = computeIt();`).
 *   - Field re-aliasing (`const FOO = OTHER;`).
 *
 * Wire-up: see ./configs/zig.ts — the call extractor's
 * `extractLanguageCallSite` hook walks ancestors and consults the
 * resolver to decide whether to emit `staticGated: true`.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { resolveZigImportInternal } from '../import-resolvers/zig.js';
import type { ZigBuildZonConfig } from '../language-config.js';

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

/**
 * Per-file `@import` alias map, mapping a local identifier to the
 * resolved absolute file path of the imported module.  Used for the
 * `cfg.FOO` cross-file lookup pattern.
 *
 *   `const cfg = @import("./cfg.zig");`  →  Map { 'cfg' → 'src/cfg.zig' }
 */
export type ZigImportAliasMap = ReadonlyMap<string, string>;

/**
 * Cross-file lookup: given an alias-resolved file path, return that
 * file's known-bool map.  Implemented by the caller — the resolver
 * itself stays stateless.
 */
export type ZigBoolConstLookup = (filePath: string) => ZigBoolConstMap | undefined;

// ---------------------------------------------------------------------------
// Phase 2: per-file extraction
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
  // Require `const` and exclude `var`. tree-sitter-zig parses both with
  // the same `variable_declaration` shape; the qualifier is an anonymous
  // child token. A `pub var FOO = false;` is mutable global state — its
  // initial value is NOT a comptime constant and must not feed gating.
  let isConst = false;
  let isVar = false;
  for (let i = 0; i < decl.childCount; i++) {
    const c = decl.child(i);
    if (!c || c.isNamed) continue;
    if (c.type === 'const') isConst = true;
    else if (c.type === 'var') isVar = true;
  }
  if (!isConst || isVar) return null;

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

/**
 * Walk the top-level of a Zig source file and collect `@import` alias
 * declarations:
 *
 *   `const cfg = @import("./cfg.zig");`  →  Map { 'cfg' → 'src/cfg.zig' }
 *
 * Imports that don't resolve to a file in the repo (`@import("std")`,
 * package deps without a build.zig.zon path, etc.) are skipped.
 */
export function buildZigImportAliasMap(
  rootNode: SyntaxNode,
  currentFilePath: string,
  allFilePaths: Set<string>,
  buildZon: ZigBuildZonConfig | null | undefined,
): ZigImportAliasMap {
  const out = new Map<string, string>();
  for (const child of rootNode.namedChildren) {
    if (child.type !== 'variable_declaration') continue;
    const entry = extractImportAlias(child, currentFilePath, allFilePaths, buildZon);
    if (entry) out.set(entry.name, entry.target);
  }
  return out;
}

function extractImportAlias(
  decl: SyntaxNode,
  currentFilePath: string,
  allFilePaths: Set<string>,
  buildZon: ZigBuildZonConfig | null | undefined,
): { name: string; target: string } | null {
  // Require `const` (the idiomatic spelling for `@import` aliases).
  // `var cfg = @import(...)` is technically legal but would let a
  // later assignment shadow the import; we don't follow assignments.
  let isConst = false;
  let isVar = false;
  for (let i = 0; i < decl.childCount; i++) {
    const c = decl.child(i);
    if (!c || c.isNamed) continue;
    if (c.type === 'const') isConst = true;
    else if (c.type === 'var') isVar = true;
  }
  if (!isConst || isVar) return null;

  let name: string | undefined;
  let importPath: string | undefined;

  for (const c of decl.namedChildren) {
    if (c.type === 'identifier' && name === undefined) {
      name = c.text;
      continue;
    }
    if (c.type === 'builtin_function') {
      // Look for @import("...") shape.
      const ident = c.namedChildren.find((cc) => cc.type === 'builtin_identifier');
      if (!ident || ident.text !== '@import') continue;
      const args = c.namedChildren.find((cc) => cc.type === 'arguments');
      if (!args) continue;
      const str = args.namedChildren.find((cc) => cc.type === 'string');
      if (!str) continue;
      const content = str.namedChildren.find((cc) => cc.type === 'string_content');
      if (content) importPath = content.text;
    }
  }

  if (name === undefined || importPath === undefined) return null;
  const resolved = resolveZigImportInternal(currentFilePath, importPath, allFilePaths, buildZon);
  if (!resolved) return null;
  return { name, target: resolved };
}

// ---------------------------------------------------------------------------
// Phase 3: ancestor walk + condition evaluation
// ---------------------------------------------------------------------------

/**
 * Decide whether a call expression sits inside an `if (FALSE)` branch.
 *
 * Walks up to {@link MAX_IF_ANCESTORS} `if_statement` ancestors and
 * evaluates each condition.  Returns `true` if any one of them
 * provably evaluates to `false`.
 *
 * Note: we don't currently distinguish the THEN vs ELSE branch.  Most
 * dead-code patterns we care about (`if (FOO) { ... }` without an
 * `else`) put the gated body in the THEN branch, and the inverse
 * (`if (FOO) {} else { gated body }`) is rare enough in practice that
 * we accept the false-negative.  A more thorough v2 would track which
 * branch the call lives in.
 */
export function isCallStaticGated(
  callNode: SyntaxNode,
  localBools: ZigBoolConstMap,
  importAliases: ZigImportAliasMap,
  lookupBoolsForPath: ZigBoolConstLookup,
): boolean {
  let current: SyntaxNode | null = callNode.parent;
  let ifCount = 0;
  while (current && ifCount < MAX_IF_ANCESTORS) {
    if (current.type === 'if_statement') {
      ifCount++;
      const cond = findIfCondition(current);
      if (cond) {
        const result = evalCond(cond, localBools, importAliases, lookupBoolsForPath, 0);
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
  importAliases: ZigImportAliasMap,
  lookupBoolsForPath: ZigBoolConstLookup,
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

    case 'field_expression': {
      // `cfg.FOO` — alias hop.
      const obj = node.namedChildren[0];
      const member = node.namedChildren[1];
      if (
        obj?.type !== 'identifier' ||
        member?.type !== 'identifier'
      ) {
        return undefined;
      }
      const targetFile = importAliases.get(obj.text);
      if (!targetFile) return undefined;
      const targetBools = lookupBoolsForPath(targetFile);
      if (!targetBools) return undefined;
      const v = targetBools.get(member.text);
      return v === undefined ? undefined : v;
    }

    case 'binary_expression': {
      // `lhs and rhs` / `lhs or rhs`.
      const op = findOperatorToken(node);
      const lhs = node.namedChildren[0];
      const rhs = node.namedChildren[1];
      if (!lhs || !rhs) return undefined;
      const l = evalCond(lhs, localBools, importAliases, lookupBoolsForPath, depth + 1);
      const r = evalCond(rhs, localBools, importAliases, lookupBoolsForPath, depth + 1);
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
      // Comparison ops (==, !=, <, >, …) — not handled in v1.
      return undefined;
    }

    case 'error_union_type': {
      // tree-sitter-zig misparses prefix `!FOO` (boolean negation) as
      // `error_union_type` because the same `!` token is used for
      // error-union types.  We handle the pragmatic case: a single
      // resolvable identifier inside an `error_union_type` whose
      // immediate parent is an `if_statement` condition position.
      // Negate the inner value.
      const inner = node.namedChildren[0];
      if (!inner) return undefined;
      const v = evalCond(inner, localBools, importAliases, lookupBoolsForPath, depth + 1);
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
      // Anonymous tokens for boolean ops carry their text as the type.
      if (c.type === 'and' || c.type === 'or') return c.type;
    }
  }
  return undefined;
}
