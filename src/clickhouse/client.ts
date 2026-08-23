/**
 * Wrapper over @clickhouse/client. Read queries run with ClickHouse's own
 * `readonly=1` setting and a `max_result_rows` cap as defence in depth on top of
 * the policy engine; writes/DDL go through `command`.
 */
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

  constructor(conn: ClickHouseConnection) {
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

/** Single-quote a string literal for embedding in a system query. */
function quote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Backtick-quote an identifier. */
function ident(s: string): string {
  return `\`${s.replace(/`/g, "``")}\``;
}
