import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CHClient } from "../src/clickhouse/client.js";
import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { classifyStatement, parseStatementTarget, statementScope } from "../src/sql.js";

/** Statements that remove or replace data but used to classify as plain writes. */
const DESTRUCTIVE = [
  // CREATE OR REPLACE / REPLACE of something that holds data or a definition
  "CREATE OR REPLACE TABLE app.t (a Int8) ENGINE = Memory",
  "create or replace table t (a Int8) engine = Memory",
  "CREATE /* c */ OR -- x\n REPLACE TABLE IF NOT EXISTS app.t ON CLUSTER c (a Int8) ENGINE = Memory",
  "CREATE OR REPLACE TABLE app.t AS SELECT 1 AS a",
  "CREATE OR REPLACE TEMPORARY TABLE t (a Int8)",
  "CREATE OR REPLACE DICTIONARY app.d (id UInt64) PRIMARY KEY id SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)",
  "CREATE OR REPLACE VIEW app.v AS SELECT 1",
  "CREATE OR REPLACE MATERIALIZED VIEW app.mv ENGINE = Memory AS SELECT 1 AS a",
  "REPLACE TABLE app.t (a Int8) ENGINE = Memory",
  "REPLACE DICTIONARY app.d (id UInt64) PRIMARY KEY id SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)",
  // OPTIMIZE that removes rows
  "OPTIMIZE TABLE app.t FINAL DEDUPLICATE",
  "OPTIMIZE TABLE app.t DEDUPLICATE",
  "OPTIMIZE TABLE app.t FINAL DEDUPLICATE BY a, b",
  "OPTIMIZE TABLE app.t PARTITION 1 FINAL CLEANUP",
  "optimize table app.t final cleanup",
  "OPTIMIZE TABLE app.t ON CLUSTER c FINAL DEDUPLICATE BY * EXCEPT b",
  // MODIFY COLUMN that gives the column a type (or kind), or a TTL
  "ALTER TABLE app.t MODIFY COLUMN c UInt8",
  "ALTER TABLE app.t MODIFY COLUMN IF EXISTS c Nullable(String)",
  "ALTER TABLE app.t MODIFY COLUMN `c` LowCardinality(String) AFTER d",
  "ALTER TABLE app.t MODIFY COLUMN c String DEFAULT 'x' COMMENT 'restated type'",
  "ALTER TABLE app.t MODIFY COLUMN n.a Array(Int8)",
  "ALTER TABLE app.t MODIFY COLUMN c MATERIALIZED toString(d)",
  "ALTER TABLE app.t MODIFY COLUMN c ALIAS toString(d)",
  "ALTER TABLE app.t MODIFY COLUMN c EPHEMERAL",
  "ALTER TABLE app.t MODIFY COLUMN c TTL d + INTERVAL 1 DAY",
  "ALTER TABLE app.t MODIFY COLUMN c DEFAULT 1 TTL d + INTERVAL 1 DAY",
  "ALTER TABLE app.t ADD COLUMN x Int8, MODIFY COLUMN c UInt8",
  "ALTER TABLE app.t MODIFY COLUMN c Strange(unknown)",
];
/** Must stay ordinary writes. */
const WRITE = [
  "CREATE TABLE app.t (a Int8) ENGINE = Memory",
  "CREATE TABLE IF NOT EXISTS app.t (a Int8) ENGINE = Memory",
  "CREATE VIEW app.v AS SELECT 1",
  "CREATE TABLE app.t (a Int8 DEFAULT 1, b String COMMENT 'create or replace table x') ENGINE = Memory",
  "CREATE FUNCTION f AS (x) -> x + 1",
  "CREATE OR REPLACE FUNCTION f AS (x) -> x + 2",
  "OPTIMIZE TABLE app.t",
  "OPTIMIZE TABLE app.t FINAL",
  "OPTIMIZE TABLE app.t PARTITION 1 FINAL",
  "OPTIMIZE TABLE app.`deduplicate_log` FINAL",
  "OPTIMIZE TABLE app.t FINAL SETTINGS optimize_throw_if_noop = 1",
  "ALTER TABLE app.t MODIFY COLUMN c DEFAULT 5",
  "ALTER TABLE app.t MODIFY COLUMN IF EXISTS c COMMENT 'hello'",
  "ALTER TABLE app.t MODIFY COLUMN c CODEC(ZSTD(3))",
  "ALTER TABLE app.t MODIFY COLUMN c REMOVE COMMENT",
  "ALTER TABLE app.t MODIFY COLUMN c AFTER d",
  "ALTER TABLE app.t MODIFY COLUMN c FIRST",
  "ALTER TABLE app.t MODIFY COLUMN c MODIFY SETTING max_compress_block_size = 1",
  "ALTER TABLE app.t MODIFY COLUMN `c` DEFAULT 1 CODEC(LZ4) COMMENT 'x'",
  "ALTER TABLE app.t ADD COLUMN c UInt8",
  "ALTER TABLE app.t ADD COLUMN c UInt8 TTL d + INTERVAL 1 DAY",
  "ALTER TABLE app.t COMMENT COLUMN c 'MODIFY COLUMN c UInt8'",
  "ALTER TABLE app.t MODIFY ORDER BY (a, b)",
  "ALTER TABLE app.t MODIFY SETTING max_parts = 1",
];

describe("classifyStatement: replace / dedupe / retype", () => {
  for (const sql of DESTRUCTIVE) {
    it(`destructive: ${sql.replace(/\n/g, " ").slice(0, 80)}`, () => expect(classifyStatement(sql).class).toBe("destructive"));
  }
  for (const sql of WRITE) {
    it(`write: ${sql.slice(0, 80)}`, () => expect(classifyStatement(sql).class).toBe("write"));
  }
});

describe("parseStatementTarget: replace / optimize", () => {
  const t = (s: string) => parseStatementTarget(s);
  it("names the table being replaced or optimized", () => {
    expect(t("CREATE OR REPLACE TABLE app.t (a Int8) ENGINE = Memory")).toEqual({ verb: "REPLACE", kind: "table", names: [{ database: "app", name: "t" }] });
    expect(t("REPLACE TABLE IF NOT EXISTS `a`.`b` ON CLUSTER c (a Int8) ENGINE = Memory")).toEqual({ verb: "REPLACE", kind: "table", names: [{ database: "a", name: "b" }] });
    expect(t("CREATE OR REPLACE VIEW v AS SELECT 1")).toEqual({ verb: "REPLACE", kind: "view", names: [{ name: "v" }] });
    expect(t("CREATE OR REPLACE MATERIALIZED VIEW mv ENGINE = Memory AS SELECT 1")?.kind).toBe("view");
    expect(t("CREATE OR REPLACE DICTIONARY d (id UInt64) PRIMARY KEY id")?.kind).toBe("dictionary");
    expect(t("OPTIMIZE TABLE app.t FINAL DEDUPLICATE BY a")).toEqual({ verb: "OPTIMIZE", kind: "table", names: [{ database: "app", name: "t" }] });
    expect(t("OPTIMIZE TABLE t ON CLUSTER c FINAL CLEANUP")?.names).toEqual([{ name: "t" }]);
  });
  it("leaves other shapes unparsed", () => {
    for (const s of ["CREATE TABLE t (a Int8)", "CREATE OR REPLACE TEMPORARY TABLE t (a Int8)", "CREATE OR REPLACE FUNCTION f AS (x) -> x", "CREATE OR REPLACE TABLE", "OPTIMIZE t"]) {
      expect(t(s), s).toBeUndefined();
    }
  });
});

describe("statementScope: REPLACE", () => {
  it("scopes REPLACE like CREATE", () => {
    expect(statementScope("REPLACE TABLE b.t (a Int8) ENGINE = Memory", "d")).toEqual({ databases: ["b"] });
    expect(statementScope("CREATE OR REPLACE TABLE t AS b.u", "d").databases.sort()).toEqual(["b", "d"]);
  });
});

// --- end to end ---------------------------------------------------------------------------------

function config(over: Partial<AppConfig["security"]> = {}): AppConfig {
  return {
    connection: { url: "http://localhost:8123", username: "u", password: "p", database: "app", requestTimeout: 1000 },
    security: {
      mode: "admin",
      databaseAllowlist: [],
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
const yes = () => ({ action: "accept" as const, content: { confirm: true } });
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isErr = (r: unknown) => (r as { isError?: boolean }).isError === true;
afterEach(() => vi.restoreAllMocks());
const spies = () => ({
  cmd: vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue(),
  tv: vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1"),
});

describe("execute: replace / dedupe / retype need the delete flag, admin and a human", () => {
  for (const sql of DESTRUCTIVE.filter((s) => !s.startsWith("CREATE OR REPLACE TEMPORARY") && !s.includes("Strange"))) {
    const short = sql.replace(/\n/g, " ").slice(0, 70);
    it(`needs CLICKHOUSE_ALLOW_DELETE: ${short}`, async () => {
      const s = spies();
      const { client } = await connect(config({ allowDelete: false }), yes);
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), text(res)).toBe(true);
      expect(text(res)).toContain("CLICKHOUSE_ALLOW_DELETE");
      expect(s.cmd).not.toHaveBeenCalled();
    });
    it(`needs admin mode: ${short}`, async () => {
      const s = spies();
      const { client } = await connect(config({ mode: "read-write" }), yes);
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), text(res)).toBe(true);
      expect(text(res)).toMatch(/admin/);
      expect(s.cmd).not.toHaveBeenCalled();
    });
    it(`asks the human, and is not run if declined: ${short}`, async () => {
      const s = spies();
      const { client, prompts } = await connect(config(), () => ({ action: "decline" }));
      await client.callTool({ name: "execute", arguments: { sql } });
      expect(prompts).toHaveLength(1);
      expect(s.cmd).not.toHaveBeenCalled();
    });
  }

  it("CREATE OR REPLACE TABLE pins the replaced table's version, and refuses if it changed during the prompt", async () => {
    const s = spies();
    const { client, prompts } = await connect(config(), yes);
    await client.callTool({ name: "execute", arguments: { sql: "CREATE OR REPLACE TABLE app.t (a Int8) ENGINE = Memory" } });
    expect(s.tv).toHaveBeenCalledWith("app", "t");
    expect(prompts[0]).toContain("resource version: v1");
    expect(s.cmd).toHaveBeenCalledTimes(1);

    const versions = ["v1", "v2"];
    s.tv.mockImplementation(async () => versions.shift());
    s.cmd.mockClear();
    const res = await client.callTool({ name: "execute", arguments: { sql: "CREATE OR REPLACE TABLE app.t (a Int8) ENGINE = Memory" } });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(s.cmd).not.toHaveBeenCalled();
  });

  it("a table that does not exist yet is fine (version absent), unqualified names use the default database", async () => {
    const s = spies();
    s.tv.mockResolvedValue(undefined);
    const { client } = await connect(config(), yes);
    const res = await client.callTool({ name: "execute", arguments: { sql: "REPLACE TABLE fresh (a Int8) ENGINE = Memory" } });
    expect(isErr(res), text(res)).toBe(false);
    expect(s.tv).toHaveBeenCalledWith("app", "fresh");
    expect(s.cmd).toHaveBeenCalledTimes(1);
  });

  it("OPTIMIZE … FINAL DEDUPLICATE pins the table version", async () => {
    const s = spies();
    const { client } = await connect(config(), yes);
    await client.callTool({ name: "execute", arguments: { sql: "OPTIMIZE TABLE app.t FINAL DEDUPLICATE" } });
    expect(s.tv).toHaveBeenCalledWith("app", "t");
    expect(s.cmd).toHaveBeenCalledTimes(1);
  });

  it("the prompt says what is being run", async () => {
    spies();
    const { client, prompts } = await connect(config(), yes);
    await client.callTool({ name: "execute", arguments: { sql: "CREATE OR REPLACE TABLE app.t (a Int8) ENGINE = Memory" } });
    expect(prompts[0]).toContain("run CREATE OR REPLACE TABLE");
  });

  it("plain OPTIMIZE, plain CREATE, and ordinary MODIFY COLUMN stay writes (no prompt, no delete flag)", async () => {
    const s = spies();
    const { client, prompts } = await connect(config({ mode: "read-write", allowDelete: false }), yes);
    for (const sql of WRITE.filter((x) => !x.includes("FUNCTION") && !x.includes("SETTINGS"))) {
      const res = await client.callTool({ name: "execute", arguments: { sql } });
      expect(isErr(res), `${sql}: ${text(res)}`).toBe(false);
    }
    expect(prompts).toHaveLength(0);
    expect(s.cmd).toHaveBeenCalled();
  });

  it("the query tool still refuses them in read-only mode", async () => {
    const s = spies();
    const read = vi.spyOn(CHClient.prototype, "runReadQuery").mockResolvedValue({ rows: 0, data: [], truncatedAtMaxRows: false });
    const { client } = await connect(config({ mode: "read-only" }), yes);
    for (const sql of ["CREATE OR REPLACE TABLE t (a Int8) ENGINE = Memory", "OPTIMIZE TABLE t FINAL DEDUPLICATE", "ALTER TABLE t MODIFY COLUMN c UInt8"]) {
      const res = await client.callTool({ name: "query", arguments: { sql } });
      expect(isErr(res)).toBe(true);
      expect(text(res)).toContain("destructive");
    }
    expect(read).not.toHaveBeenCalled();
    expect(s.cmd).not.toHaveBeenCalled();
  });
});
