import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CHClient } from "../src/clickhouse/client.js";
import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const config = (requireHumanApproval = false): AppConfig => ({
  connection: { url: "http://localhost:8123", username: "u", password: "p", database: "default", requestTimeout: 1000 },
  security: {
    mode: "admin",
    databaseAllowlist: [],
    protectedDatabases: ["system"],
    allowDelete: true,
    dryRun: false,
    maxRows: 1000,
    auditLog: false,
    requireHumanApproval,
  },
});

type Answer = { action: "accept" | "decline"; content?: Record<string, unknown> };

/** Connect an in-memory MCP client (optionally able to answer elicitation) to a freshly built server. */
async function connect(opts: { requireHuman?: boolean; answer?: (message: string) => Answer | Promise<Answer>; elicits?: boolean; typed?: string }) {
  const { server } = buildServer(config(opts.requireHuman));
  const prompts: string[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: opts.elicits === false ? {} : { elicitation: {} } });
  if (opts.elicits !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return (await opts.answer?.(req.params.message)) ?? { action: "accept", content: { confirm: true, typed: opts.typed ?? "default.events" } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, prompts };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const run = (client: Client, sql: string, database?: string) =>
  client.callTool({ name: "execute", arguments: { sql, ...(database ? { database } : {}) } });

afterEach(() => vi.restoreAllMocks());

describe("execute DROP TABLE approval (end to end)", () => {
  it("shows the tool, the exact statement, the version and a fingerprint, then runs it", async () => {
    vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client, prompts } = await connect({});
    const res = await run(client, "DROP TABLE events");
    expect(text(res)).toContain('"executed": true');
    expect(cmd).toHaveBeenCalledWith("DROP TABLE events");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("tool: execute");
    expect(prompts[0]).toContain('"sql":"DROP TABLE events"');
    expect(prompts[0]).toContain("resource version: v1");
    expect(prompts[0]).toMatch(/fingerprint: [0-9a-f]{16}/);
    // Unqualified names are resolved against the configured default database and shown that way.
    expect(prompts[0]).toContain('"default.events"');
  });

  it("probes the table named in the statement (db-qualified)", async () => {
    const tv = vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1");
    vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client } = await connect({ typed: "app.events" });
    await run(client, "DROP TABLE IF EXISTS `app`.`events` SYNC");
    expect(tv).toHaveBeenCalledWith("app", "events");
  });

  it("does NOT run when the table changed while the human was deciding", async () => {
    const versions = ["v1", "v2"];
    vi.spyOn(CHClient.prototype, "tableVersion").mockImplementation(async () => versions.shift());
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client } = await connect({});
    const res = await run(client, "DROP TABLE events");
    expect(text(res)).toContain("resource changed since the prompt");
    expect(cmd).not.toHaveBeenCalled();
  });

  it("does NOT run when the typed confirmation does not match", async () => {
    vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client } = await connect({ typed: "events" }); // not the resolved "default.events" shown
    const res = await run(client, "DROP TABLE events");
    expect(text(res)).toContain("typed confirmation did not match");
    expect(cmd).not.toHaveBeenCalled();
  });

  it("does NOT run when the human declines", async () => {
    vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client } = await connect({ answer: () => ({ action: "decline" }) });
    await run(client, "DROP TABLE events");
    expect(cmd).not.toHaveBeenCalled();
  });
});

describe("execute DROP DATABASE approval (end to end)", () => {
  it("pins the database version and asks for the database name", async () => {
    const dv = vi.spyOn(CHClient.prototype, "databaseVersion").mockResolvedValue("d1");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client, prompts } = await connect({ typed: "analytics" });
    await run(client, "DROP DATABASE analytics");
    expect(dv).toHaveBeenCalledWith("analytics");
    expect(prompts[0]).toContain("resource version: d1");
    expect(prompts[0]).toContain('"analytics"');
    expect(cmd).toHaveBeenCalledWith("DROP DATABASE analytics");
  });

  it("does NOT drop when a table appeared in the database during the prompt", async () => {
    const versions = ["d1", "d2"];
    vi.spyOn(CHClient.prototype, "databaseVersion").mockImplementation(async () => versions.shift());
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client } = await connect({ typed: "analytics" });
    const res = await run(client, "DROP DATABASE analytics");
    expect(text(res)).toContain("resource changed since the prompt");
    expect(cmd).not.toHaveBeenCalled();
  });

  it("does NOT drop when the typed name is wrong", async () => {
    vi.spyOn(CHClient.prototype, "databaseVersion").mockResolvedValue("d1");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client } = await connect({ typed: "other" });
    const res = await run(client, "DROP DATABASE analytics");
    expect(text(res)).toContain("typed confirmation did not match");
    expect(cmd).not.toHaveBeenCalled();
  });
});

describe("other destructive statements", () => {
  it("TRUNCATE is version-pinned but not typed", async () => {
    const versions = ["v1", "v2"];
    vi.spyOn(CHClient.prototype, "tableVersion").mockImplementation(async () => versions.shift());
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client, prompts } = await connect({});
    const res = await run(client, "TRUNCATE TABLE events");
    expect(text(res)).toContain("resource changed since the prompt");
    expect(cmd).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(1);
  });

  it("a mutation (ALTER … DELETE) pins the table version", async () => {
    const tv = vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client } = await connect({});
    await run(client, "ALTER TABLE app.events DELETE WHERE ts < '2020-01-01'");
    expect(tv).toHaveBeenCalledWith("app", "events");
    expect(cmd).toHaveBeenCalled();
  });

  it("a statement whose target cannot be read is bound by the statement text alone", async () => {
    const tv = vi.spyOn(CHClient.prototype, "tableVersion");
    const dv = vi.spyOn(CHClient.prototype, "databaseVersion");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client, prompts } = await connect({});
    await run(client, "KILL QUERY WHERE user = 'x'");
    expect(tv).not.toHaveBeenCalled();
    expect(dv).not.toHaveBeenCalled();
    expect(prompts[0]).not.toContain("resource version");
    expect(prompts[0]).toContain("KILL QUERY WHERE user = 'x'");
    expect(cmd).toHaveBeenCalled();
  });

  it("shows the whole of a long statement, not just the first part", async () => {
    vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1");
    vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client, prompts } = await connect({});
    const tail = "WHERE secret_marker_at_the_very_end = 1";
    await run(client, `ALTER TABLE events DELETE /* ${"x".repeat(3000)} */ ${tail}`);
    expect(prompts[0]).toContain(tail);
  });
});

describe("CLICKHOUSE_REQUIRE_HUMAN_APPROVAL", () => {
  it("falls back to the flags when the client cannot elicit (default)", async () => {
    vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client } = await connect({ elicits: false });
    await run(client, "DROP TABLE events");
    expect(cmd).toHaveBeenCalledWith("DROP TABLE events");
  });

  it("refuses to drop when the client cannot elicit and human approval is required", async () => {
    vi.spyOn(CHClient.prototype, "tableVersion").mockResolvedValue("v1");
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client, prompts } = await connect({ elicits: false, requireHuman: true });
    const res = await run(client, "DROP TABLE events");
    expect(text(res)).toContain("no human approval channel");
    expect(cmd).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(0);
  });

  it("does not affect reads or plain writes", async () => {
    const read = vi.spyOn(CHClient.prototype, "runReadQuery").mockResolvedValue({ rows: 0, data: [], truncatedAtMaxRows: false });
    const cmd = vi.spyOn(CHClient.prototype, "runCommand").mockResolvedValue();
    const { client, prompts } = await connect({ elicits: false, requireHuman: true });
    await run(client, "SELECT 1");
    await run(client, "INSERT INTO events VALUES (1)");
    expect(read).toHaveBeenCalledWith("SELECT 1", 1000);
    expect(cmd).toHaveBeenCalledWith("INSERT INTO events VALUES (1)");
    expect(prompts).toHaveLength(0);
  });
});

describe("version probes go through the read-only, row-capped path", () => {
  const rows = (data: unknown[]) => ({ rows: data.length, data, truncatedAtMaxRows: false });
  const conn = { url: "http://localhost:8123", username: "u", password: "p", database: "default", requestTimeout: 1000 };

  it("tableVersion is stable, changes with uuid / mtime / DDL, and is undefined for a missing table", async () => {
    const spy = vi.spyOn(CHClient.prototype, "runReadQuery");
    const row = { uuid: "u1", engine: "MergeTree", mtime: 1, create_table_query: "CREATE TABLE a.t (x Int8)" };
    const c = new CHClient(conn);
    spy.mockResolvedValueOnce(rows([row])).mockResolvedValueOnce(rows([row]));
    const a = await c.tableVersion("a", "t");
    expect(await c.tableVersion("a", "t")).toBe(a);
    expect(a).toBeDefined();
    expect(spy.mock.calls[0]![0]).toContain("system.tables");
    expect(spy.mock.calls[0]![1]).toBeLessThanOrEqual(10);
    for (const change of [{ uuid: "u2" }, { mtime: 2 }, { create_table_query: "CREATE TABLE a.t (x Int16)" }]) {
      spy.mockResolvedValueOnce(rows([{ ...row, ...change }]));
      expect(await c.tableVersion("a", "t")).not.toBe(a);
    }
    spy.mockResolvedValueOnce(rows([]));
    expect(await c.tableVersion("a", "t")).toBeUndefined();
  });

  it("databaseVersion changes when the set of tables changes and is undefined for a missing database", async () => {
    const spy = vi.spyOn(CHClient.prototype, "runReadQuery");
    const c = new CHClient(conn);
    const dbRow = rows([{ uuid: "d", engine: "Atomic" }]);
    spy.mockResolvedValueOnce(dbRow).mockResolvedValueOnce(rows([{ n: "2", h: "111" }]));
    const a = await c.databaseVersion("a");
    spy.mockResolvedValueOnce(dbRow).mockResolvedValueOnce(rows([{ n: "2", h: "111" }]));
    expect(await c.databaseVersion("a")).toBe(a);
    spy.mockResolvedValueOnce(dbRow).mockResolvedValueOnce(rows([{ n: "3", h: "999" }]));
    expect(await c.databaseVersion("a")).not.toBe(a);
    spy.mockResolvedValueOnce(rows([]));
    expect(await c.databaseVersion("missing")).toBeUndefined();
  });
});
