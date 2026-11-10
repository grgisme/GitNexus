// ...existing code...
import { describe, it, expect } from 'vitest';
import { isWriteQuery as isWriteQueryAdapter } from '../../src/mcp/core/lbug-adapter';
import { isWriteQuery as isWriteQueryBackend } from '../../src/mcp/local/local-backend';

describe('isWriteQuery regex tests', () => {
  const writeQueries = [
    'CREATE (n:Test {name: "x"})',
    'MATCH (n) SET n.x = 1',
    'MERGE (n:Foo {id: 1})',
    'DELETE n',
    'DROP INDEX ON :Foo(prop)',
    'ALTER TABLE Something',
    'COPY TO something',
    'DETACH DELETE n',
    "MATCH (n) WHERE n.name = 'x' DELETE n", // write after a literal
    "MATCH (n) WHERE n.name = 'a\\' ' SET n.x = 1", // escaped quote must not hide a clause
  ];

  const readQueries = [
    'MATCH (n:CreateHelpers) RETURN n',
    'MATCH (a)-[:CALLS]->(b) RETURN a, b',
    'MATCH (f:File)-[r:DEFINES]->(n) RETURN n',
    "MATCH (n) WHERE n.name = 'MERGEHelper' RETURN n", // word present as data
    'MATCH (n) RETURN n',
    'MATCH (n) WHERE n.content CONTAINS ":CREATE" RETURN n',
    'MATCH (n:SomethingWithSET) RETURN n',
    // #11874: keywords inside string literals (FTS terms) are data, not writes
    "CALL QUERY_FTS_INDEX('Class', 'class_fts', 'ReclaimSite load complete', conjunctive := false) RETURN node, score",
    "CALL QUERY_FTS_INDEX('Class', 'class_fts', 'it''s set copy create', conjunctive := false) RETURN node",
    "CALL QUERY_FTS_INDEX('Class', 'class_fts', 'a\\'b delete', conjunctive := false) RETURN node",
    'MATCH (n) WHERE n.name = "remove drop" RETURN n',
  ];

  it('adapter isWriteQuery should detect real write queries', () => {
    for (const q of writeQueries) {
      expect(isWriteQueryAdapter(q), `adapter should detect write for: ${q}`).toBe(true);
    }
  });

  it('adapter isWriteQuery should not false-positive on label/rel or data', () => {
    for (const q of readQueries) {
      expect(isWriteQueryAdapter(q), `adapter false-positive on: ${q}`).toBe(false);
    }
  });

  it('backend isWriteQuery should detect real write queries', () => {
    for (const q of writeQueries) {
      expect(isWriteQueryBackend(q), `backend should detect write for: ${q}`).toBe(true);
    }
  });

  it('backend isWriteQuery should not false-positive on label/rel or data', () => {
    for (const q of readQueries) {
      expect(isWriteQueryBackend(q), `backend false-positive on: ${q}`).toBe(false);
    }
  });
});
