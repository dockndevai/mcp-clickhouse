import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CHClient } from "../src/clickhouse/client.js";
import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

/** End to end: CLICKHOUSE_DATABASE_ALLOWLIST and destructive gating are enforced from the SQL text. */
function config(over: Partial<AppConfig["security"]> = {}, database = "app"): AppConfig {
  return {
    connection: { url: "http://localhost:8123", username: "u", password: "p", database, requestTimeout: 1000 },
    security: {
      mode: "admin",
      databaseAllowlist: ["app"],
      protectedDatabases: ["system"],
      allowDelete: true,
      dryRun: false,
      maxRows: 1000,
      auditLog: false,
      requireHumanApproval: false,
      ...over,
    },
  };
}

async function connect(cfg: AppConfig, answer: () => { action: "accept" | "decline"; content?: Record<string, unknown> }) {
  const { server } = buildServer(cfg);
  const prompts: string[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    prompts.push(req.params.message);
    return answer();
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, prompts };
}

const yes = () => ({ action: "accept" as const, content: { confirm: true, typed: "app.t" } });
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isErr = (r: unknown) => (r as { isError?: boolean }).isError === true;

afterEach(() => vi.restoreAllMocks());

function spies() {
  return {
    read: vi.spyOn(CHClient.prototype, "runReadQuery").mockResolvedValue({ rows: 0, data: [], truncatedAtMaxRows: false }),
    cmd: vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue(),
    tv: vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1"),
    dv: vi.spyOn(CHClient.prototype, "databaseVersion").mockResolvedValue("d1"),
  };
}

describe("CLICKHOUSE_DATABASE_ALLOWLIST is enforced on the databases the SQL names", () => {
  const refused: Array<[string, string]> = [
    ["DROP TABLE other.t", "DROP of a table in another database"],
    ["TRUNCATE TABLE other.t", "TRUNCATE in another database"],
    ["INSERT INTO other.t VALUES (1)", "INSERT into another database"],
    ["INSERT INTO app.t SELECT * FROM other.t", "INSERT … SELECT from another database"],
    ["CREATE TABLE other.t (a Int8) ENGINE = Memory", "CREATE in another database"],
    ["CREATE TABLE app.t AS other.t2", "CREATE … AS another database's table"],
    ["CREATE MATERIALIZED VIEW app.mv TO other.t AS SELECT 1 AS a", "materialized view TO another database"],
    ["ALTER TABLE other.t DELETE WHERE 1", "mutation in another database"],
    ["ALTER TABLE app.t MOVE PARTITION 1 TO TABLE other.t", "MOVE PARTITION TO TABLE another database"],
    ["ALTER TABLE app.t REPLACE PARTITION 1 FROM other.t", "REPLACE PARTITION FROM another database"],
    ["RENAME TABLE app.t TO other.t", "RENAME across databases"],
    ["EXCHANGE TABLES app.t AND other.t", "EXCHANGE with another database"],
    ["OPTIMIZE TABLE other.t", "OPTIMIZE in another database"],
    ["DROP DATABASE other", "DROP DATABASE"],
    ["CREATE DATABASE other", "CREATE DATABASE"],
    ["USE other", "USE another database"],
    ["DELETE FROM other.t WHERE 1", "lightweight DELETE"],
    ["SELECT * FROM other.t", "SELECT from another database"],
    ["SELECT * FROM app.t JOIN other.t2 ON 1", "JOIN to another database"],
    ["SELECT * FROM app.t, other.t2", "comma join to another database"],
    ["SELECT * FROM app.t WHERE id IN (SELECT id FROM other.t)", "subquery on another database"],
    ["SELECT * FROM app.t WHERE id IN other.t", "IN <table> on another database"],
    ["WITH x AS (SELECT * FROM other.t) SELECT * FROM x", "CTE on another database"],
    ["SELECT * FROM app.t UNION ALL SELECT * FROM other.t", "UNION on another database"],
    ["SELECT * FROM app.t ARRAY JOIN arr AS a, other.t2", "table after ARRAY JOIN list"],
    ["SELECT 1 FROM `other`.`t`", "quoted identifiers"],
    ['SELECT 1 FROM "other"."t"', "double-quoted identifiers"],
    ["SELECT 1 FROM /* c */ other . t -- x", "comments and spacing"],
    ["SELECT other.t.col FROM app.t", "db.table.column reference"],
    ["SELECT dictGet('other.d', 'x', 1)", "dictGet on a dictionary in another database"],
    ["SELECT joinGet('other.j', 'x', 1)", "joinGet on a table in another database"],
    ["SELECT * FROM dictionary('other.d')", "dictionary() table function"],
    ["SELECT * FROM remote('127.0.0.1', 'other', 't')", "remote() table function"],
    ["SELECT * FROM cluster('c', other.t)", "cluster() table function"],
    ["SELECT * FROM merge('other', '.*')", "merge() table function"],
    ["SELECT hasColumnInTable('other', 't', 'c')", "hasColumnInTable"],
    ["SELECT $$'$$ FROM other.t WHERE a = '1' OR b = $$'$$", "heredoc hiding a database reference from a naive quote scanner"],
    ["SELECT 1 # ' \n FROM other.t WHERE a = '1' # '", "'#' comment hiding a reference"],
    ["SYSTEM SYNC REPLICA other.t", "SYSTEM statements are not scoped"],
    ["GRANT SELECT ON other.* TO bob", "GRANT on another database"],
    ["SHOW TABLES FROM other", "SHOW TABLES FROM"],
    ["SHOW COLUMNS FROM t FROM other", "SHOW COLUMNS FROM t FROM db"],
    ["DESCRIBE other.t", "DESCRIBE"],
    ["EXISTS TABLE other.t", "EXISTS"],
    ["SHOW CREATE TABLE other.t", "SHOW CREATE"],
    ["SELECT * FROM app.t t1 CROSS JOIN other.t2", "CROSS JOIN"],
    ["FROBNICATE other.t", "unknown statement type fails closed"],
  ];
  // The default database is "app", which IS allowlisted, so unqualified names are fine here; a separate test
  // below covers a default database that is not allowlisted.
  for (const [sql, why] of refused) {
    it(`refuses (execute): ${why}`, async () => {
      const s = spies();
      const { client } = await connect(config(), yes);
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), `${sql} -> ${text(res)}`).toBe(true);
      expect(text(res), sql).toMatch(/allowlist|cannot determine/i);
      expect(s.cmd).not.toHaveBeenCalled();
      expect(s.read).not.toHaveBeenCalled();
    });
  }

  const readOnly = refused.filter(([s]) => /^(SELECT|WITH|SHOW|DESCRIBE|EXISTS)/.test(s));
  for (const [sql, why] of readOnly) {
    it(`refuses (query, read-only mode): ${why}`, async () => {
      const s = spies();
      const { client } = await connect(config({ mode: "read-only" }), yes);
      const res = await client.callTool({ name: "query", arguments: { sql } });
      expect(isErr(res), `${sql} -> ${text(res)}`).toBe(true);
      expect(text(res)).toMatch(/allowlist|cannot determine/i);
      expect(s.read).not.toHaveBeenCalled();
    });
  }

  it("a `database` argument naming an allowed database cannot launder a statement on another one", async () => {
    const s = spies();
    const { client } = await connect(config(), yes);
    const res = await client.callTool({ name: "execute", arguments: { sql: "DROP TABLE other.t", database: "app" } });
    expect(isErr(res)).toBe(true);
    expect(s.cmd).not.toHaveBeenCalled();
  });

  it("unqualified names resolve to the default database, which must be allowlisted too", async () => {
    const s = spies();
    const { client } = await connect(config({}, "default"), yes);
    const res = await client.callTool({ name: "execute", arguments: { sql: "DROP TABLE t", database: "app" } });
    expect(isErr(res)).toBe(true);
    expect(text(res)).toContain("'default'");
    expect(s.cmd).not.toHaveBeenCalled();
    const q = await client.callTool({ name: "query", arguments: { sql: "SELECT * FROM t" } });
    expect(isErr(q)).toBe(true);
    expect(s.read).not.toHaveBeenCalled();
  });

  const allowed = [
    "SELECT * FROM app.t",
    "SELECT * FROM t",
    "SELECT a.id, t.x FROM app.t AS a JOIN t ON a.id = t.id",
    "SELECT o.id FROM app.orders o WHERE o.id IN (SELECT id FROM app.vip)",
    "WITH c AS (SELECT 1 AS n) SELECT * FROM c",
    "SELECT * FROM numbers(10)",
    "SELECT 1",
    "SELECT 'other.t' AS s, \"x\" FROM t -- from other.t",
    "SELECT /* FROM other.t */ 1",
    "SELECT extract(year FROM d) FROM app.t",
    "SELECT * FROM app.t ARRAY JOIN arr AS a",
    "SELECT dictGet('app.d', 'x', 1)",
    "SELECT dictGet('d', 'x', 1)",
    "SELECT count() FROM app.t GROUP BY a, b",
    "SHOW TABLES FROM app",
    "SHOW TABLES",
    "SHOW DATABASES",
    "SHOW COLUMNS FROM t FROM app",
    "DESCRIBE app.t",
    "EXISTS TABLE app.t",
  ];
  for (const sql of allowed) {
    it(`still allows: ${sql.slice(0, 60)}`, async () => {
      const s = spies();
      const { client } = await connect(config({ mode: "read-only" }), yes);
      const res = await client.callTool({ name: "query", arguments: { sql } });
      expect(isErr(res), `${sql} -> ${text(res)}`).toBe(false);
      expect(s.read).toHaveBeenCalledWith(sql, 1000);
    });
  }

  it("allows writes entirely inside the allowlist", async () => {
    const s = spies();
    const { client } = await connect(config(), yes);
    for (const sql of ["INSERT INTO app.t VALUES (1)", "CREATE TABLE app.n (a Int8) ENGINE = Memory", "INSERT INTO t SELECT * FROM app.s"]) {
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), `${sql} -> ${text(res)}`).toBe(false);
    }
    expect(s.cmd).toHaveBeenCalledTimes(3);
  });

  it("is a no-op when no allowlist is configured", async () => {
    const s = spies();
    const { client } = await connect(config({ databaseAllowlist: [] }), yes);
    const res = await client.callTool({ name: "execute", arguments: { sql: "FROBNICATE other.t" } });
    expect(s.cmd).toHaveBeenCalled();
    expect(isErr(res)).toBe(false);
  });

  it("an allowlisted statement the parser cannot analyse is refused, with the reason", async () => {
    const s = spies();
    const { client } = await connect(config(), yes);
    const res = await client.callTool({ name: "execute", arguments: { sql: "SELECT * FROM remote('h', 'app', 't')" } });
    expect(isErr(res)).toBe(true);
    expect(text(res)).toMatch(/cannot determine which databases/i);
    expect(s.cmd).not.toHaveBeenCalled();
  });
});

describe("protected databases are found by the same extraction", () => {
  it("refuses a write that names a protected database through a form the old text scan missed", async () => {
    const s = spies();
    const { client } = await connect(config({ databaseAllowlist: [] }), yes);
    for (const sql of [
      "RENAME TABLE app.t TO system.t",
      "ALTER TABLE app.t MOVE PARTITION 1 TO TABLE system.t",
      "ALTER TABLE app.t REPLACE PARTITION 1 FROM system.t",
    ]) {
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), sql).toBe(true);
      expect(text(res), sql).toContain("protected");
    }
    expect(s.cmd).not.toHaveBeenCalled();
  });
});

describe("data-losing and data-hiding statements are destructive", () => {
  const cases = [
    "ALTER TABLE app.t DROP PARTITION 202401",
    "ALTER TABLE app.t DROP PART 'all_1_1_0'",
    "ALTER TABLE app.t DROP COLUMN c",
    "ALTER TABLE app.t DROP INDEX i",
    "ALTER TABLE app.t DROP PROJECTION p",
    "ALTER TABLE app.t DROP CONSTRAINT k",
    "ALTER TABLE app.t DETACH PARTITION 1",
    "ALTER TABLE app.t CLEAR COLUMN c IN PARTITION 1",
    "ALTER TABLE app.t RENAME COLUMN a TO b",
    "ALTER TABLE app.t REPLACE PARTITION 1 FROM app.s",
    "ALTER TABLE app.t MOVE PARTITION 1 TO TABLE app.s",
    "ALTER TABLE app.t ADD COLUMN c Int8, DROP COLUMN d",
    "ALTER TABLE app.t COMMENT COLUMN c '--', DROP PARTITION 1",
    "RENAME TABLE app.t TO app.u",
    "EXCHANGE TABLES app.t AND app.u",
  ];

  for (const sql of cases) {
    it(`needs CLICKHOUSE_ALLOW_DELETE: ${sql}`, async () => {
      const s = spies();
      const { client } = await connect(config({ allowDelete: false }), yes);
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), text(res)).toBe(true);
      expect(text(res)).toContain("CLICKHOUSE_ALLOW_DELETE");
      expect(s.cmd).not.toHaveBeenCalled();
    });

    it(`needs admin mode: ${sql}`, async () => {
      const s = spies();
      const { client } = await connect(config({ mode: "read-write" }), yes);
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), text(res)).toBe(true);
      expect(text(res)).toMatch(/admin/);
      expect(s.cmd).not.toHaveBeenCalled();
    });

    it(`asks the human and is not run when declined: ${sql}`, async () => {
      const s = spies();
      const { client, prompts } = await connect(config(), () => ({ action: "decline" }));
      await client.callTool({ name: "execute", arguments: { sql } });
      expect(prompts).toHaveLength(1);
      expect(s.cmd).not.toHaveBeenCalled();
    });
  }

  it("runs after approval and pins the table version across the prompt", async () => {
    const s = spies();
    const { client, prompts } = await connect(config(), yes);
    await client.callTool({ name: "execute", arguments: { sql: "ALTER TABLE app.t DROP PARTITION 1" } });
    expect(s.tv).toHaveBeenCalledWith("app", "t");
    expect(prompts[0]).toContain("resource version: v1");
    expect(s.cmd).toHaveBeenCalledWith("ALTER TABLE app.t DROP PARTITION 1");
  });

  it("does not run when the table changed while the human was deciding", async () => {
    const s = spies();
    const versions = ["v1", "v2"];
    s.tv.mockImplementation(async () => versions.shift());
    const { client } = await connect(config(), yes);
    const res = await client.callTool({ name: "execute", arguments: { sql: "ALTER TABLE app.t DROP COLUMN c" } });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(s.cmd).not.toHaveBeenCalled();
  });

  it("pins every table named by RENAME / EXCHANGE", async () => {
    const s = spies();
    const { client } = await connect(config(), yes);
    await client.callTool({ name: "execute", arguments: { sql: "RENAME TABLE app.a TO app.b, c TO d" } });
    expect(s.tv.mock.calls.map((c) => c.join("."))).toEqual(
      expect.arrayContaining(["app.a", "app.b", "app.c", "app.d"]),
    );
    s.tv.mockClear();
    await client.callTool({ name: "execute", arguments: { sql: "EXCHANGE TABLES app.a AND app.b" } });
    expect(s.tv.mock.calls.map((c) => c.join("."))).toEqual(expect.arrayContaining(["app.a", "app.b"]));
  });

  it("plain schema changes are still ordinary writes", async () => {
    const s = spies();
    const { client, prompts } = await connect(config({ mode: "read-write", allowDelete: false }), yes);
    for (const sql of ["ALTER TABLE app.t ADD COLUMN c Int8", "ALTER TABLE app.t MODIFY COLUMN c Int16", "ALTER TABLE app.t ATTACH PARTITION 1 FROM app.s"]) {
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), `${sql}: ${text(res)}`).toBe(false);
    }
    expect(prompts).toHaveLength(0);
    expect(s.cmd).toHaveBeenCalledTimes(3);
  });
});

describe("read-only enforcement and the row cap are intact", () => {
  it("the query tool still refuses non-read statements and still passes the row cap", async () => {
    const s = spies();
    const { client } = await connect(config({ mode: "read-only", databaseAllowlist: [], maxRows: 7 }), yes);
    const bad = await client.callTool({ name: "query", arguments: { sql: "ALTER TABLE app.t DROP PARTITION 1" } });
    expect(isErr(bad)).toBe(true);
    expect(text(bad)).toContain("destructive");
    await client.callTool({ name: "query", arguments: { sql: "SELECT * FROM app.t" } });
    expect(s.read).toHaveBeenCalledWith("SELECT * FROM app.t", 7);
    expect(s.cmd).not.toHaveBeenCalled();
  });
});
