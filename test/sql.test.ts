import { describe, expect, it } from "vitest";
import { classifyStatement, parseStatementTarget, referencesDatabase, statementScope, stripNoise } from "../src/sql.js";
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

describe("parseStatementTarget", () => {
  const t = (sql: string) => parseStatementTarget(sql);

  it("reads DROP TABLE / DATABASE / VIEW / DICTIONARY", () => {
    expect(t("DROP TABLE events")).toEqual({ verb: "DROP", kind: "table", names: [{ name: "events" }] });
    expect(t("drop table if exists app.events;")).toEqual({ verb: "DROP", kind: "table", names: [{ database: "app", name: "events" }] });
    expect(t("DROP DATABASE IF EXISTS analytics ON CLUSTER c1 SYNC")).toEqual({ verb: "DROP", kind: "database", names: [{ name: "analytics" }] });
    expect(t("DROP VIEW v")?.kind).toBe("view");
    expect(t("DROP DICTIONARY d NO DELAY")?.kind).toBe("dictionary");
  });

  it("handles quoting, comments and multiple tables", () => {
    expect(t("DROP /* hi */ TABLE `my db`.`we``ird` -- bye")).toEqual({
      verb: "DROP",
      kind: "table",
      names: [{ database: "my db", name: "we`ird" }],
    });
    expect(t('DROP TABLE "a"."b", c')?.names).toEqual([{ database: "a", name: "b" }, { name: "c" }]);
  });

  it("reads TRUNCATE, DELETE FROM and ALTER TABLE … DELETE/UPDATE", () => {
    expect(t("TRUNCATE TABLE a.b")).toEqual({ verb: "TRUNCATE", kind: "table", names: [{ database: "a", name: "b" }] });
    expect(t("TRUNCATE b")?.names).toEqual([{ name: "b" }]);
    expect(t("DELETE FROM a.b WHERE x = 1")).toEqual({ verb: "DELETE", kind: "table", names: [{ database: "a", name: "b" }] });
    expect(t("ALTER TABLE a.b ON CLUSTER c DELETE WHERE x = 1")?.names).toEqual([{ database: "a", name: "b" }]);
  });

  it("leaves anything it cannot be sure about unparsed", () => {
    for (const sql of [
      "DROP USER bob",
      "DROP TEMPORARY TABLE t",
      "DROP TABLE t FORMAT JSON", // unknown trailing clause
      "DROP TABLE t # trailing comment style we do not parse",
      "DROP TABLE `a\\`b`",
      "DROP TABLE t; DROP TABLE u",
      "DROP DATABASE a.b",
      "TRUNCATE ALL TABLES FROM db",
      "TRUNCATE DATABASE db",
      "KILL QUERY WHERE user = 'x'",
      "DETACH TABLE t",
      "SELECT 1",
      "DROP TABLE",
      "DROP TABLE /* unterminated",
    ]) {
      expect(t(sql), sql).toBeUndefined();
    }
  });
});

describe("classifyStatement: data-losing and data-hiding statements", () => {
  const destructiveAlters = [
    "ALTER TABLE t DROP PARTITION 202401",
    "ALTER TABLE t DROP PARTITION ID 'x'",
    "ALTER TABLE t DROP PART 'all_1_1_0'",
    "ALTER TABLE t DROP DETACHED PARTITION 1",
    "ALTER TABLE t DROP COLUMN c",
    "ALTER TABLE IF EXISTS db.t ON CLUSTER c DROP COLUMN IF EXISTS c",
    "ALTER TABLE t DROP INDEX i",
    "ALTER TABLE t DROP PROJECTION p",
    "ALTER TABLE t DROP CONSTRAINT k",
    "ALTER TABLE t DETACH PARTITION 1",
    "ALTER TABLE t DETACH PART 'p'",
    "ALTER TABLE t CLEAR COLUMN c IN PARTITION 1",
    "ALTER TABLE t CLEAR INDEX i IN PARTITION 1",
    "ALTER TABLE t RENAME COLUMN a TO b",
    "ALTER TABLE t REPLACE PARTITION 1 FROM s",
    "ALTER TABLE t MOVE PARTITION 1 TO TABLE s",
    "ALTER TABLE t MOVE PART 'p' TO TABLE db.s",
    "ALTER TABLE t MODIFY TTL d + INTERVAL 1 DAY",
    "ALTER TABLE t FORGET PARTITION 1",
    "alter table t drop partition 1",
    "ALTER TABLE t ADD COLUMN c Int8, DROP COLUMN d",
    "ALTER TABLE t MODIFY COLUMN c Int8, DROP INDEX i",
    // a '--' inside a string must not hide the second command from the classifier
    "ALTER TABLE t COMMENT COLUMN c '--', DROP PARTITION 1",
    "ALTER TABLE t COMMENT COLUMN c '/*', DROP PARTITION 1 /* */",
    "ALTER TABLE t COMMENT COLUMN c $$--$$, DROP PARTITION 1",
    "ALTER TABLE t /* x */ DROP -- y\n PARTITION 1",
  ];
  for (const sql of destructiveAlters) {
    it(`destructive: ${sql.slice(0, 70).replace(/\n/g, " ")}`, () => expect(classifyStatement(sql).class).toBe("destructive"));
  }

  const writeAlters = [
    "ALTER TABLE t ADD COLUMN c Int8",
    "ALTER TABLE t ADD COLUMN c String DEFAULT replace(a, 'x', 'y')",
    "ALTER TABLE t ADD COLUMN `drop` Int8",
    "ALTER TABLE t MODIFY COLUMN c DEFAULT 5",
    "ALTER TABLE t MODIFY COLUMN c COMMENT 'drop partition'",
    "ALTER TABLE t COMMENT COLUMN c 'rename and clear'",
    "ALTER TABLE t ADD INDEX i x TYPE minmax GRANULARITY 1",
    "ALTER TABLE t ATTACH PARTITION 1 FROM s",
    "ALTER TABLE t MOVE PARTITION 1 TO DISK 'd'",
    "ALTER TABLE t MOVE PART 'p' TO VOLUME 'v'",
    "ALTER TABLE t MODIFY SETTING max_parts = 1",
    "ALTER TABLE t FREEZE PARTITION 1",
    "ALTER USER bob IDENTIFIED BY 'x'",
  ];
  for (const sql of writeAlters) {
    it(`still a write: ${sql.slice(0, 70)}`, () => expect(classifyStatement(sql).class).toBe("write"));
  }

  it("an ALTER the tokenizer cannot read is destructive", () => {
    expect(classifyStatement("ALTER TABLE t ADD COLUMN c String COMMENT 'unterminated").class).toBe("destructive");
    expect(classifyStatement("ALTER TABLE `a\\`b` ADD COLUMN c Int8").class).toBe("destructive");
    expect(classifyStatement("ALTER TABLE").class).toBe("destructive");
  });

  it("RENAME and EXCHANGE are destructive", () => {
    for (const sql of ["RENAME TABLE a TO b", "RENAME TABLE a.t TO b.t", "RENAME DATABASE a TO b", "EXCHANGE TABLES a AND b", "EXCHANGE DICTIONARIES a AND b"]) {
      expect(classifyStatement(sql).class, sql).toBe("destructive");
    }
  });

  it("comment and string tricks do not hide a second statement", () => {
    expect(classifyStatement("SELECT '--'; DROP TABLE t").multiStatement).toBe(true);
    expect(classifyStatement("SELECT '/*'; DROP TABLE t; SELECT '*/'").multiStatement).toBe(true);
    expect(classifyStatement("SELECT $$x$$; DROP TABLE t").multiStatement).toBe(true);
    expect(classifyStatement("SELECT 1 # c\n; DROP TABLE t").multiStatement).toBe(true);
    expect(classifyStatement("SELECT 'a;b'").multiStatement).toBe(false);
    expect(classifyStatement("SELECT 1; -- done").multiStatement).toBe(false);
  });
});

describe("stripNoise lexing", () => {
  it("keeps what follows a '--' that is inside a string", () => {
    expect(stripNoise("SELECT '--', x FROM system.t")).toContain("system.t");
  });
  it("drops a quote inside a comment", () => {
    expect(stripNoise("SELECT 1 -- it's\nFROM system.t")).toContain("system.t");
    expect(stripNoise("SELECT 1 /* ' */ FROM system.t")).toContain("system.t");
    expect(stripNoise("SELECT 1 # it's\nFROM system.t")).toContain("system.t");
  });
  it("treats heredocs as strings and keeps backtick identifiers", () => {
    expect(stripNoise("SELECT $$ DROP TABLE x $$ AS a")).not.toContain("DROP");
    expect(stripNoise("SELECT $t$ ' $t$, y FROM system.t")).toContain("system.t");
    expect(stripNoise("SELECT 1 FROM `we--ird`.t")).toContain("`we--ird`");
  });
  it("still finds a protected database after a '--' string", () => {
    expect(referencesDatabase("INSERT INTO app.t SELECT '--', 1 FROM system.tables", ["system"])).toBe("system");
  });
});

describe("parseStatementTarget: RENAME / EXCHANGE", () => {
  const t = (sql: string) => parseStatementTarget(sql);
  it("reads every name on both sides", () => {
    expect(t("RENAME TABLE a.t TO b.u, v TO w ON CLUSTER c")).toEqual({
      verb: "RENAME",
      kind: "table",
      names: [{ database: "a", name: "t" }, { database: "b", name: "u" }, { name: "v" }, { name: "w" }],
    });
    expect(t("RENAME DATABASE a TO b")).toEqual({ verb: "RENAME", kind: "database", names: [{ name: "a" }, { name: "b" }] });
    expect(t("RENAME DICTIONARY d TO e")?.kind).toBe("dictionary");
    expect(t("EXCHANGE TABLES a.t AND b.u")).toEqual({ verb: "EXCHANGE", kind: "table", names: [{ database: "a", name: "t" }, { database: "b", name: "u" }] });
    expect(t("EXCHANGE DICTIONARIES d AND e")?.kind).toBe("dictionary");
  });
  it("leaves odd shapes unparsed", () => {
    for (const sql of ["RENAME TABLE a TO", "RENAME TABLE a b", "RENAME DATABASE a.b TO c", "EXCHANGE TABLES a", "EXCHANGE a AND b", "RENAME TABLE a TO b FORMAT x"]) {
      expect(t(sql), sql).toBeUndefined();
    }
  });
  it("still names the table of an ALTER … DROP PARTITION", () => {
    expect(t("ALTER TABLE app.t DROP PARTITION 1")).toEqual({ verb: "ALTER", kind: "table", names: [{ database: "app", name: "t" }] });
  });
});

describe("statementScope", () => {
  const dbs = (sql: string, def = "def") => [...statementScope(sql, def).databases].sort();
  const unresolved = (sql: string) => statementScope(sql, "def").unresolved;

  const cases: Array<[string, string[]]> = [
    ["SELECT 1", []],
    ["SELECT * FROM numbers(10)", []],
    ["SELECT * FROM a.t", ["a"]],
    ["SELECT * FROM t", ["def"]],
    ["SELECT * FROM `a`.`t`", ["a"]],
    ['SELECT * FROM "a"."t"', ["a"]],
    ["SELECT * FROM /* c */ a . t -- d", ["a"]],
    ["SELECT * FROM a.t1 AS x, b.t2 y WHERE x.id = y.id", ["a", "b"]],
    ["SELECT * FROM t1, b.t2", ["b", "def"]],
    ["SELECT * FROM a.t LEFT JOIN b.u USING (id)", ["a", "b"]],
    ["SELECT * FROM a.t JOIN a.u ON t.a = u.a, b.v", ["a", "b"]],
    ["SELECT * FROM a.t GLOBAL ANY LEFT JOIN b.u ON 1", ["a", "b"]],
    ["SELECT * FROM a.t LEFT ARRAY JOIN arr AS x, y", ["a"]],
    ["SELECT x FROM (SELECT x FROM b.t) AS s", ["b"]],
    ["SELECT x FROM (SELECT x FROM b.t) s, c.u", ["b", "c"]],
    ["SELECT * FROM a.t WHERE id IN (SELECT id FROM b.t)", ["a", "b"]],
    ["SELECT * FROM a.t WHERE id IN b.t", ["a", "b"]],
    ["SELECT * FROM a.t WHERE exists (SELECT 1 FROM b.u)", ["a", "b"]],
    ["WITH (SELECT max(x) FROM b.t) AS m SELECT * FROM a.t WHERE x = m", ["a", "b"]],
    ["WITH c AS (SELECT * FROM b.t) SELECT * FROM c", ["b"]],
    ["WITH c AS (SELECT 1 AS n) SELECT * FROM c", []],
    ["SELECT * FROM a.t UNION ALL SELECT * FROM b.t", ["a", "b"]],
    ["(SELECT * FROM b.t)", ["b"]],
    ["SELECT extract(year FROM d) FROM a.t", ["a"]],
    ["SELECT trim(BOTH ' ' FROM s) FROM a.t", ["a"]],
    ["SELECT 1 IS DISTINCT FROM 2 FROM a.t", ["a"]],
    ["SELECT x, y FROM a.t GROUP BY x, y ORDER BY x, y LIMIT 1, 2 SETTINGS a = 1, b = 2", ["a"]],
    ["SELECT 'FROM other.t' AS s, \"c\" FROM a.t -- FROM other.t", ["a"]],
    ["SELECT /* FROM other.t */ 1 FROM a.t", ["a"]],
    ["SELECT $$ FROM other.t $$ FROM a.t", ["a"]],
    ["SELECT o.id, t.x FROM a.orders o JOIN a.t ON o.id = t.id", ["a"]],
    ["SELECT other.t.col FROM a.t", ["a", "other"]],
    ["SELECT table, sum(rows) FROM system.parts GROUP BY table ORDER BY table DESC", ["system"]],
    ["SELECT dictGet('b.d', 'x', 1)", ["b"]],
    ["SELECT dictGetOrDefault('d', 'x', toUInt64(1), 0)", ["def"]],
    ["SELECT joinGet('b.j', 'x', 1)", ["b"]],
    ["SELECT * FROM dictionary('b.d')", ["b"]],
    ["SELECT * FROM view(SELECT * FROM b.t)", ["b"]],
    ["SELECT * FROM s3('http://x', 'CSV') INTO OUTFILE 'f'", []],
    ["INSERT INTO a.t VALUES (1)", ["a"]],
    ["INSERT INTO t (a, b) VALUES (1, 2)", ["def"]],
    ["INSERT INTO a.t SELECT * FROM b.u", ["a", "b"]],
    ["INSERT INTO TABLE a.t FORMAT CSV", ["a"]],
    ["INSERT INTO a.t FROM INFILE 'x' FORMAT CSV", ["a"]],
    ["CREATE TABLE a.t (x Int8, y Int8) ENGINE = MergeTree ORDER BY (x, y)", ["a"]],
    ["CREATE TABLE a.t AS b.u", ["a", "b"]],
    ["CREATE TABLE a.t AS u", ["a", "def"]],
    ["CREATE TABLE IF NOT EXISTS a.t ON CLUSTER c (x Int8) ENGINE = Memory", ["a"]],
    ["CREATE VIEW a.v AS SELECT table FROM b.t", ["a", "b"]],
    ["CREATE MATERIALIZED VIEW a.mv TO b.t AS SELECT 1 AS n", ["a", "b"]],
    ["CREATE DATABASE b", ["b"]],
    ["DROP DATABASE IF EXISTS b ON CLUSTER c", ["b"]],
    ["DROP TABLE IF EXISTS a.t1, b.t2 SYNC", ["a", "b"]],
    ["DROP TABLE t", ["def"]],
    ["TRUNCATE TABLE IF EXISTS a.t", ["a"]],
    ["TRUNCATE t", ["def"]],
    ["TRUNCATE ALL TABLES FROM b", ["b"]],
    ["TRUNCATE DATABASE b", ["b"]],
    ["OPTIMIZE TABLE a.t FINAL", ["a"]],
    ["DELETE FROM a.t WHERE id IN (SELECT id FROM b.u)", ["a", "b"]],
    ["ALTER TABLE a.t DELETE WHERE 1", ["a"]],
    ["ALTER TABLE a.t ON CLUSTER c ADD COLUMN x Int8", ["a"]],
    ["ALTER TABLE a.t MOVE PARTITION 1 TO TABLE b.u", ["a", "b"]],
    ["ALTER TABLE a.t MOVE PARTITION 1 TO TABLE u", ["a", "def"]],
    ["ALTER TABLE a.t MOVE PARTITION 1 TO DISK 'd'", ["a"]],
    ["ALTER TABLE a.t MODIFY TTL d + INTERVAL 1 DAY TO VOLUME 'v'", ["a"]],
    ["ALTER TABLE a.t REPLACE PARTITION 1 FROM b.u", ["a", "b"]],
    ["ALTER TABLE a.t UPDATE x = 1 IN PARTITION 1 WHERE 1", ["a"]],
    ["ALTER TABLE a.t DELETE WHERE id IN (SELECT id FROM b.t), DROP PARTITION 1", ["a", "b"]],
    ["RENAME TABLE a.t TO b.u, v TO w", ["a", "b", "def"]],
    ["RENAME DATABASE a TO b", ["a", "b"]],
    ["EXCHANGE TABLES a.t AND b.u", ["a", "b"]],
    ["USE b", ["b"]],
    ["SHOW TABLES", ["def"]],
    ["SHOW TABLES FROM b LIKE 'x%'", ["b"]],
    ["SHOW DICTIONARIES IN b", ["b"]],
    ["SHOW DATABASES", []],
    ["SHOW PROCESSLIST", []],
    ["SHOW CREATE TABLE b.t", ["b"]],
    ["SHOW CREATE t", ["def"]],
    ["SHOW CREATE DATABASE b", ["b"]],
    ["SHOW COLUMNS FROM t FROM b", ["b"]],
    ["SHOW COLUMNS FROM a.t", ["a"]],
    ["SHOW COLUMNS FROM t", ["def"]],
    ["DESCRIBE TABLE b.t", ["b"]],
    ["DESC b.t", ["b"]],
    ["DESCRIBE t", ["def"]],
    ["DESCRIBE (SELECT * FROM b.t)", ["b"]],
    ["EXISTS TABLE b.t", ["b"]],
    ["EXISTS DATABASE b", ["b"]],
    ["CHECK TABLE b.t", ["b"]],
    ["EXPLAIN SELECT * FROM b.t", ["b"]],
    ["EXPLAIN AST SELECT 1", []],
    ["GRANT SELECT ON b.t TO u", ["b"]],
    ["GRANT SELECT ON b.* TO u", ["b"]],
    ["GRANT SELECT ON t TO u", ["def"]],
    ["GRANT role1 TO u", []],
    ["SET max_threads = 1", []],
    ["KILL QUERY WHERE user = 'x'", []],
    ["SYSTEM FLUSH LOGS", []],
    ["SELECT * FROM a.t; DROP TABLE b.u", ["a", "b"]],
    ["SELECT * FROM a.t; DROP TABLE u", ["a", "def"]],
    ["SELECT 'it''s', r FROM a.t WHERE s = 'it\\'s' AND r IN (SELECT 1 FROM b.t)", ["a", "b"]],
    ["SELECT $tag$ ' $tag$ FROM b.t WHERE x = '1'", ["b"]],
    ["SELECT * FROM café.t", ["café"]],
  ];
  for (const [sql, expected] of cases) {
    it(`${sql.length > 80 ? `${sql.slice(0, 77)}…` : sql} -> [${expected.join(", ")}]`, () => {
      const scope = statementScope(sql, "def");
      expect(scope.unresolved, `${sql}: ${scope.unresolved}`).toBeUndefined();
      expect([...scope.databases].sort()).toEqual(expected);
    });
  }

  it("fails closed (unresolved) where it cannot tell", () => {
    for (const sql of [
      "",
      "-- just a comment",
      "FROBNICATE a.t",
      "SELECT 1 # ' \n FROM b.t WHERE x = '1' # '", // '#' comment
      "SELECT 'unterminated",
      "SELECT $$ unterminated",
      "SELECT 1 /* unterminated",
      "SELECT * FROM `a\\`.t",
      "SELECT * FROM remote('h', 'b', 't')",
      "SELECT * FROM remoteSecure('h', b.t)",
      "SELECT * FROM cluster('c', b.t)",
      "SELECT * FROM clusterAllReplicas('c', b.t)",
      "SELECT * FROM merge('b', '.*')",
      "SELECT * FROM some_future_function(1)",
      "INSERT INTO FUNCTION remote('h', 'b', 't') SELECT 1",
      "SELECT hasColumnInTable('b', 't', 'c')",
      "SELECT dictGet(name, 'x', 1) FROM a.t",
      "SELECT dictGet('a.b.c', 'x', 1)",
      "SELECT * FROM dictionary(dname)",
      "CREATE TABLE a.t (x Int8) ENGINE = Distributed('c', 'b', 't')",
      "CREATE TABLE a.t (x Int8) ENGINE = Merge('b', '.*')",
      "CREATE TABLE a.t (x Int8) ENGINE = Buffer(b, t, 1, 1, 1, 1, 1, 1, 1)",
      "CREATE TABLE a.t (x Int8) ENGINE = Dictionary(b.d)",
      "CREATE DICTIONARY a.d (id UInt64) PRIMARY KEY id SOURCE(CLICKHOUSE(DB 'b' TABLE 't')) LAYOUT(FLAT()) LIFETIME(0)",
      "CREATE ROW POLICY p ON b.t USING 1 TO ALL",
      "SYSTEM RELOAD DICTIONARY b.d",
      "SYSTEM SYNC REPLICA b.t",
      "GRANT SELECT ON *.* TO u",
      "SHOW CREATE ROW POLICY p ON b.t",
      "SHOW COLUMNS",
      "SHOW SOMETHING_NEW",
      "RENAME TABLE a TO",
      "EXCHANGE TABLES a",
      "TRUNCATE ALL TABLES",
      "WATCH a.lv",
      "BACKUP TABLE b.t TO Disk('x', 'y')",
    ]) {
      expect(unresolved(sql), sql).toBeDefined();
    }
  });

  it("reports the databases it did find even when part is unresolved", () => {
    expect(dbs("SELECT * FROM a.t JOIN remote('h','b','t') ON 1")).toContain("a");
  });

  it("resolves unqualified names against the default database it is given", () => {
    expect(statementScope("DROP TABLE t", "analytics").databases).toEqual(["analytics"]);
  });
});
