/**
 * Regression (#7771 bug B): scope extraction on Python files larger than
 * tree-sitter's default 32 KB buffer threw "Invalid argument" when the
 * ASTCache had no tree (parser.parse without bufferSize).
 */
import { describe, it, expect } from 'vitest';
import { emitPythonScopeCaptures } from '../../src/core/ingestion/languages/python/captures.js';

describe('emitPythonScopeCaptures large files', () => {
  it('parses a >64KB source without a cached tree', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `def fn_${i}(x):\n    return x + ${i}\n`).join('\n');
    expect(body.length).toBeGreaterThan(64 * 1024);
    const caps = emitPythonScopeCaptures(body, 'big.py');
    expect(caps.length).toBeGreaterThan(0);
  });
});
