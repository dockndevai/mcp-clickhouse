import { z } from "zod";
import { classifyStatement, referencesDatabase } from "../sql.js";
import { statementCapability } from "../security.js";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";

/**
 * A single `execute` tool covers writes and destructive statements. It is
 * registered at `write` capability (so it never appears in read-only mode), but
 * each call is re-classified: a destructive statement requires admin mode AND
 * CLICKHOUSE_ALLOW_DELETE, enforced by the policy guard.
 */
export const writeTools: ToolDef[] = [
  {
    name: "execute",
    capability: "write",
    // A single statement may be destructive (DROP/TRUNCATE/DELETE), gated at runtime.
    destructive: true,
    config: {
      title: "Execute a statement",
      description:
        "Execute a single SQL statement (INSERT/CREATE/ALTER, or a destructive DROP/TRUNCATE/DELETE). " +
        "The statement is classified: writes need read-write mode; destructive statements need admin mode " +
        "AND CLICKHOUSE_ALLOW_DELETE=true. Pass an optional `database` for allowlist/protection checks.",
      inputSchema: {
        sql: z.string().describe("A single SQL statement to execute"),
        database: z
          .string()
          .optional()
          .describe("Database the statement targets (for allowlist + protection checks)"),
      },
    },
    handler: async (args, { client, policy }) => {
      const sql = args.sql as string;
      const database = args.database as string | undefined;
      const classification = classifyStatement(sql);

      if (classification.multiStatement) {
        return {
          content: [{ type: "text" as const, text: "Refused: multiple statements are not allowed." }],
          isError: true,
        };
      }

      const capability = statementCapability(classification.class);
      const destructive = classification.class === "destructive";

      // Best-effort protection: refuse mutating statements that reference a
      // protected database even when no explicit `database` arg was given.
      if (capability !== "read") {
        const hit = referencesDatabase(sql, policy.protectedDatabases);
        if (hit) {
          return {
            content: [
              { type: "text" as const, text: `Refused: statement references protected database '${hit}'.` },
            ],
            isError: true,
          };
        }
      }

      const { dryRun } = policy.guard({ tool: "execute", capability, database, destructive });
      if (dryRun) {
        return textResult(
          `[dry-run] Would execute (${classification.class}/${classification.keyword}): ${sql}`,
        );
      }

      if (classification.class === "read") {
        const result = await client.runReadQuery(sql, policy.maxRows);
        return jsonResult(result);
      }
      await client.runCommand(sql);
      return jsonResult({ executed: true, class: classification.class, keyword: classification.keyword });
    },
  },
];
