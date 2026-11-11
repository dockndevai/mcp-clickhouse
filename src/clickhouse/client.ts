/**
 * Wrapper over @clickhouse/client. Read queries run with ClickHouse's own
 * `readonly=1` setting and a `max_result_rows` cap as defence in depth on top of
 * the policy engine; writes/DDL go through `command`.
 */
import { createHash } from "node:crypto";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { ClickHouseConnection } from "../config.js";

export interface QueryResult {
  rows: number;
  data: unknown[];
  statistics?: unknown;
  truncatedAtMaxRows: boolean;
}

export class CHClient {
  private readonly client: ClickHouseClient;
  private readonly database: string;

  constructor(conn: ClickHouseConnection) {
    this.database = conn.database;
    this.client = createClient({
      url: conn.url,
      username: conn.username,
      password: conn.password,
      database: conn.database,
      request_timeout: conn.requestTimeout,
    });
  }

  ping() {
    return this.client.ping();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Run a read query with a hard server-side row cap and readonly enforcement. */
  async runReadQuery(sql: string, maxRows: number): Promise<QueryResult> {
    const rs = await this.client.query({
      query: sql,
      format: "JSON",
      clickhouse_settings: {
        readonly: "1",
        // Cap the result and stop rather than error when the cap is hit.
        max_result_rows: String(maxRows),
        result_overflow_mode: "break",
      },
    });
    const body = (await rs.json()) as { data: unknown[]; rows: number; statistics?: unknown };
    return {
      rows: body.rows ?? body.data.length,
      data: body.data,
      statistics: body.statistics,
      truncatedAtMaxRows: (body.data?.length ?? 0) >= maxRows,
    };
  }

  /** Execute a write/DDL/destructive statement. */
  async runCommand(sql: string): Promise<void> {
    await this.client.command({ query: sql });
  }

  // --- Version tokens, pinned across an approval prompt -----------------------
  // Both go through runReadQuery, so they keep `readonly=1` and the row cap.

  /** The database unqualified names resolve against (CLICKHOUSE_DATABASE). */
  get defaultDatabase(): string {
    return this.database;
  }

  /**
   * Version token for a table / view / dictionary: its `system.tables` uuid, engine, metadata
   * modification time and a hash of its `create_table_query`. Changes on recreate (new uuid on Atomic
   * databases, new metadata mtime on Ordinary ones) and on any ALTER. It deliberately ignores row
   * counts and sizes, which change on every insert. Limits: it cannot see data changes, and an object
   * the user may not see in `system.tables` reads as "absent" both times.
   * Returns undefined when the object does not exist.
   */
  async tableVersion(database: string, table: string): Promise<string | undefined> {
    const rs = await this.runReadQuery(
      `SELECT toString(uuid) AS uuid, engine, toUInt32(metadata_modification_time) AS mtime, create_table_query ` +
        `FROM system.tables WHERE database = ${quote(database)} AND name = ${quote(table)}`,
      2,
    );
    const row = rs.data[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return sha(`${row.uuid}|${row.engine}|${row.mtime}|${row.create_table_query}`);
  }

  /**
   * Version token for a database: its `system.databases` uuid and engine plus an order-independent
   * hash of every table in it (name, uuid, metadata mtime). A table created, dropped, recreated or
   * altered while the human is deciding changes it. Limits: it cannot see data changes, and it does not
   * cover objects the user may not see in `system.tables`. Returns undefined when the database does not exist.
   */
  async databaseVersion(name: string): Promise<string | undefined> {
    const db = await this.runReadQuery(
      `SELECT toString(uuid) AS uuid, engine FROM system.databases WHERE name = ${quote(name)}`,
      2,
    );
    const row = db.data[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const tables = await this.runReadQuery(
      `SELECT count() AS n, toString(groupBitXor(cityHash64(name, toString(uuid), toUInt32(metadata_modification_time)))) AS h ` +
        `FROM system.tables WHERE database = ${quote(name)}`,
      2,
    );
    const t = tables.data[0] as Record<string, unknown> | undefined;
    return sha(`${row.uuid}|${row.engine}|${t?.n ?? 0}|${t?.h ?? 0}`);
  }

  // --- Convenience reads (built from trusted, parameter-free system queries) ---

  listDatabases() {
    return this.runReadQuery("SELECT name, engine FROM system.databases ORDER BY name", 10000);
  }

  listTables(database: string) {
    return this.runReadQuery(
      `SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = ${quote(database)} ORDER BY name`,
      10000,
    );
  }

  describeTable(database: string, table: string) {
    return this.runReadQuery(
      `SELECT name, type, default_kind, default_expression, comment FROM system.columns ` +
        `WHERE database = ${quote(database)} AND table = ${quote(table)} ORDER BY position`,
      10000,
    );
  }

  async showCreateTable(database: string, table: string): Promise<string> {
    const rs = await this.client.query({
      query: `SHOW CREATE TABLE ${ident(database)}.${ident(table)}`,
      format: "TabSeparatedRaw",
      clickhouse_settings: { readonly: "1" },
    });
    return rs.text();
  }

  tableStats(database: string, table: string) {
    return this.runReadQuery(
      `SELECT count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes_on_disk, ` +
        `min(min_time) AS min_time, max(max_time) AS max_time ` +
        `FROM system.parts WHERE active AND database = ${quote(database)} AND table = ${quote(table)}`,
      10,
    );
  }

  runningQueries() {
    return this.runReadQuery(
      `SELECT query_id, user, elapsed, formatReadableSize(memory_usage) AS memory, ` +
        `read_rows, substring(query, 1, 200) AS query FROM system.processes ORDER BY elapsed DESC`,
      500,
    );
  }

  serverMetrics() {
    return this.runReadQuery(
      `SELECT metric, value FROM system.metrics WHERE value != 0 ORDER BY metric`,
      1000,
    );
  }

  clusterInfo() {
    return this.runReadQuery(
      `SELECT cluster, shard_num, replica_num, host_name, port, is_local ` +
        `FROM system.clusters ORDER BY cluster, shard_num, replica_num`,
      1000,
    );
  }
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** Single-quote a string literal for embedding in a system query. */
function quote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Backtick-quote an identifier. */
function ident(s: string): string {
  return `\`${s.replace(/`/g, "``")}\``;
}
