import { z } from "zod";
import { canonicalArgs } from "../elicit.js";
import { classifyStatement, parseStatementTarget, referencesDatabase, statementScope } from "../sql.js";
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
        "Execute a single SQL statement (INSERT/CREATE/ALTER, or a destructive DROP/TRUNCATE/DELETE/RENAME/EXCHANGE or data-losing ALTER). " +
        "The statement is classified: writes need read-write mode; destructive statements need admin mode " +
        "AND CLICKHOUSE_ALLOW_DELETE=true. Every database the statement names is checked against the allowlist/protection settings.",
      inputSchema: {
        sql: z.string().describe("A single SQL statement to execute"),
        database: z
          .string()
          .optional()
          .describe("Database the statement targets (for allowlist + protection checks)"),
      },
    },
    handler: async (args, { client, policy, confirm }) => {
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

      // The databases the statement itself names (the `database` argument is advisory: the connection
      // runs the SQL against its own default database, so unqualified names resolve there).
      const scope = statementScope(sql, client.defaultDatabase);
      const { dryRun } = policy.guard({
        tool: "execute",
        capability,
        database,
        databases: scope.databases,
        scopeUnresolved: scope.unresolved,
        defaultDatabase: client.defaultDatabase,
        destructive,
      });
      if (dryRun) {
        return textResult(
          `[dry-run] Would execute (${classification.class}/${classification.keyword}): ${sql}`,
        );
      }

      // Destructive statements (DROP/TRUNCATE/DELETE) get a human checkpoint. The prompt shows the
      // exact statement (the confirmer displays and fingerprints the arguments, `sql` included).
      if (destructive) {
        const parsed = parseStatementTarget(sql);
        const names = parsed?.names.map((n) => ({
          database: parsed.kind === "database" ? undefined : (n.database ?? client.defaultDatabase),
          name: n.name,
        }));
        const label = names?.map((n) => (n.database === undefined ? n.name : `${n.database}.${n.name}`)).join(", ");
        // The confirmer shows at most ~1500 chars of the arguments; never let the tail of a long
        // statement go unseen (e.g. a harmless-looking prefix padded with comments).
        const longStatement = canonicalArgs(args).length > 1400;
        const ok = await confirm.confirm({
          action:
            parsed?.verb === "REPLACE"
              ? `run CREATE OR REPLACE ${parsed.kind.toUpperCase()}`
              : `run ${classification.keyword}${parsed && parsed.verb !== "ALTER" && parsed.verb !== "DELETE" ? ` ${parsed.kind.toUpperCase()}` : ""}`,
          target: label ?? (sql.length > 120 ? `${sql.slice(0, 117)}…` : sql),
          details: { database, ...(longStatement ? { "full statement": sql } : {}) },
          // Highest-impact, irreversible: the human types the database / table name.
          typed: parsed?.verb === "DROP" && (parsed.kind === "database" || parsed.kind === "table"),
          // Pinned only when the target could be read off the statement; anything else is bound by the
          // fingerprint of the exact statement text alone. Reads system.tables / system.databases.
          probe: names
            ? async () => {
                const parts = await Promise.all(
                  names.map((n) =>
                    n.database === undefined ? client.databaseVersion(n.name) : client.tableVersion(n.database, n.name),
                  ),
                );
                return parts.every((p) => p === undefined) ? undefined : parts.map((p) => p ?? "absent").join("|");
              }
            : undefined,
        });
        if (!ok.approved) return textResult(`Statement cancelled — ${ok.reason}.`);
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
