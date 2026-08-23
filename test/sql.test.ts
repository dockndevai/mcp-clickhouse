import { describe, expect, it } from "vitest";
import { classifyStatement, referencesDatabase, stripNoise } from "../src/sql.js";
import { statementCapability } from "../src/security.js";

describe("classifyStatement", () => {
  const read = ["SELECT * FROM t", "  with x as (select 1) select * from x", "SHOW TABLES", "DESCRIBE t", "EXPLAIN SELECT 1"];
  for (const sql of read) {
    it(`reads: ${sql.slice(0, 24)}`, () => expect(classifyStatement(sql).class).toBe("read"));
  }

  const write = ["INSERT INTO t VALUES (1)", "CREATE TABLE t (a Int)", "OPTIMIZE TABLE t", "ALTER TABLE t ADD COLUMN b Int"];
  for (const sql of write) {
    it(`writes: ${sql.slice(0, 24)}`, () => expect(classifyStatement(sql).class).toBe("write"));
  }

  const destructive = ["DROP TABLE t", "TRUNCATE TABLE t", "DELETE FROM t WHERE 1", "KILL QUERY WHERE 1", "DETACH TABLE t"];
  for (const sql of destructive) {
    it(`destructive: ${sql.slice(0, 24)}`, () => expect(classifyStatement(sql).class).toBe("destructive"));
  }

  it("classifies ALTER ... DELETE as destructive (mutation)", () => {
    expect(classifyStatement("ALTER TABLE t DELETE WHERE id = 5").class).toBe("destructive");
  });

  it("classifies ALTER ... UPDATE as destructive (mutation)", () => {
    expect(classifyStatement("ALTER TABLE t UPDATE x = 1 WHERE id = 5").class).toBe("destructive");
  });

  it("treats unknown/empty keywords as destructive (fail safe)", () => {
    expect(classifyStatement("FOOBAR baz").class).toBe("destructive");
    expect(classifyStatement("   ").class).toBe("destructive");
  });

  it("does not get fooled by DROP inside a string/comment", () => {
    expect(classifyStatement("SELECT 'DROP TABLE t' AS note").class).toBe("read");
    expect(classifyStatement("-- DROP TABLE t\nSELECT 1").class).toBe("read");
  });

  it("detects multiple statements", () => {
    expect(classifyStatement("SELECT 1; DROP TABLE t").multiStatement).toBe(true);
    expect(classifyStatement("SELECT 1;").multiStatement).toBe(false);
  });
});

describe("statementCapability", () => {
  it("maps classes to capabilities", () => {
    expect(statementCapability("read")).toBe("read");
    expect(statementCapability("write")).toBe("write");
    expect(statementCapability("destructive")).toBe("admin");
  });
});

describe("stripNoise", () => {
  it("removes comments and string contents", () => {
    expect(stripNoise("SELECT /* x */ 1 -- y")).not.toContain("x");
    expect(stripNoise("SELECT 'secret'")).toContain("''");
  });
});

describe("referencesDatabase", () => {
  it("detects qualified and FROM references to protected databases", () => {
    expect(referencesDatabase("SELECT * FROM system.tables", ["system"])).toBe("system");
    expect(referencesDatabase("DROP TABLE system.foo", ["system"])).toBe("system");
    expect(referencesDatabase("SELECT * FROM app.orders", ["system"])).toBeUndefined();
  });
});
