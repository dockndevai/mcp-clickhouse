import { z } from "zod";
import { classifyStatement } from "../sql.js";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";

export const readTools: ToolDef[] = [
  {
    name: "list_databases",
    capability: "read",
    config: { title: "List databases", description: "List databases and their engines.", inputSchema: {} },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "list_databases", capability: "read" });
      const res = await client.listDatabases();
      const data = (res.data as Array<{ name: string }>).filter((d) => policy.isDatabaseAllowed(d.name));
      return jsonResult(data);
    },
  },
  {
    name: "list_tables",
    capability: "read",
    config: {
      title: "List tables",
      description: "List tables in a database with engine, row count, and size.",
      inputSchema: { database: z.string().describe("Database name") },
    },
    handler: async (args, { client, policy }) => {
      const database = args.database as string;
      policy.guard({ tool: "list_tables", capability: "read", database });
      return jsonResult((await client.listTables(database)).data);
    },
  },
  {
    name: "describe_table",
    capability: "read",
    config: {
      title: "Describe table",
      description: "Column names, types, defaults, and comments for a table.",
      inputSchema: {
        database: z.string().describe("Database name"),
        table: z.string().describe("Table name"),
      },
    },
    handler: async (args, { client, policy }) => {
      const database = args.database as string;
      policy.guard({ tool: "describe_table", capability: "read", database });
      return jsonResult((await client.describeTable(database, args.table as string)).data);
    },
  },
  {
    name: "show_create_table",
    capability: "read",
    config: {
      title: "Show CREATE TABLE",
      description: "Return the full CREATE TABLE statement (schema, engine, settings) for a table.",
      inputSchema: {
        database: z.string().describe("Database name"),
        table: z.string().describe("Table name"),
      },
    },
    handler: async (args, { client, policy }) => {
      const database = args.database as string;
      policy.guard({ tool: "show_create_table", capability: "read", database });
      return textResult(await client.showCreateTable(database, args.table as string));
    },
  },
  {
    name: "table_stats",
    capability: "read",
    config: {
      title: "Table stats",
      description: "Part count, row count, on-disk size, and time range from system.parts.",
      inputSchema: {
        database: z.string().describe("Database name"),
        table: z.string().describe("Table name"),
      },
    },
    handler: async (args, { client, policy }) => {
      const database = args.database as string;
      policy.guard({ tool: "table_stats", capability: "read", database });
      return jsonResult((await client.tableStats(database, args.table as string)).data);
    },
  },
  {
    name: "running_queries",
    capability: "read",
    config: {
      title: "Running queries",
      description: "Currently executing queries from system.processes (id, user, elapsed, memory).",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "running_queries", capability: "read" });
      return jsonResult((await client.runningQueries()).data);
    },
  },
  {
    name: "server_metrics",
    capability: "read",
    config: {
      title: "Server metrics",
      description: "Non-zero metrics from system.metrics (connections, merges, memory, etc.).",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "server_metrics", capability: "read" });
      return jsonResult((await client.serverMetrics()).data);
    },
  },
  {
    name: "cluster_info",
    capability: "read",
    config: {
      title: "Cluster info",
      description: "Cluster topology from system.clusters (shards, replicas, hosts).",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "cluster_info", capability: "read" });
      return jsonResult((await client.clusterInfo()).data);
    },
  },
  {
    name: "query",
    capability: "read",
    config: {
      title: "Run a read-only query",
      description:
        "Run a SELECT/SHOW/DESCRIBE query and return rows. Non-read statements are refused here — use " +
        "`execute` (read-write mode) for those. Results are capped at CLICKHOUSE_MAX_ROWS.",
      inputSchema: { sql: z.string().describe("A single read-only SQL statement") },
    },
    handler: async (args, { client, policy }) => {
      const sql = args.sql as string;
      const classification = classifyStatement(sql);
      if (classification.class !== "read") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Refused: '${classification.keyword}' is a ${classification.class} statement, not read-only. Use the 'execute' tool in read-write/admin mode.`,
            },
          ],
          isError: true,
        };
      }
      if (classification.multiStatement) {
        return {
          content: [{ type: "text" as const, text: "Refused: multiple statements are not allowed in 'query'." }],
          isError: true,
        };
      }
      policy.guard({ tool: "query", capability: "read" });
      const result = await client.runReadQuery(sql, policy.maxRows);
      return jsonResult(result);
    },
  },
];
