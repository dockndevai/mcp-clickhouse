/**
 * SQL statement classification. Pure and fully unit-testable.
 *
 * This is the security core of the ClickHouse server: it decides whether a
 * statement is a read, a write, or a destructive operation, so the policy engine
 * can gate it by access mode. It errs toward the more privileged classification
 * when unsure.
 */

export type StatementClass = "read" | "write" | "destructive";

export interface Classification {
  class: StatementClass;
  keyword: string;
  /** True when the input contains more than one statement (a risk for the read path). */
  multiStatement: boolean;
}

/** Strip line/block comments and string literals so keyword detection is robust. */
export function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""'); // double-quoted identifiers/strings
}

const READ_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN", "CHECK"]);
const WRITE_KEYWORDS = new Set(["INSERT", "CREATE", "ATTACH", "OPTIMIZE", "SET", "RENAME", "GRANT", "REVOKE", "SYSTEM"]);
const DESTRUCTIVE_KEYWORDS = new Set(["DROP", "TRUNCATE", "DELETE", "KILL", "DETACH"]);

/** Classify a single-or-multi statement SQL string. */
export function classifyStatement(sql: string): Classification {
  const cleaned = stripNoise(sql).trim();
  const withoutTrailing = cleaned.replace(/;\s*$/, "");
  const multiStatement = /;\s*\S/.test(withoutTrailing);

  const firstKeyword = (withoutTrailing.match(/[A-Za-z_]+/)?.[0] ?? "").toUpperCase();

  // ALTER is context-sensitive: mutations (DELETE/UPDATE) are destructive; the
  // rest (ADD/MODIFY/DROP COLUMN etc.) are writes.
  if (firstKeyword === "ALTER") {
    const isMutation = /\bALTER\b[\s\S]*\b(DELETE|UPDATE)\b/i.test(withoutTrailing);
    return { class: isMutation ? "destructive" : "write", keyword: "ALTER", multiStatement };
  }

  let cls: StatementClass;
  if (DESTRUCTIVE_KEYWORDS.has(firstKeyword)) cls = "destructive";
  else if (WRITE_KEYWORDS.has(firstKeyword)) cls = "write";
  else if (READ_KEYWORDS.has(firstKeyword)) cls = "read";
  // Unknown/empty keyword: treat as destructive (most privileged) to be safe.
  else cls = "destructive";

  return { class: cls, keyword: firstKeyword || "(empty)", multiStatement };
}

/** Best-effort: does the statement reference any of the given (protected) database names? */
export function referencesDatabase(sql: string, databases: string[]): string | undefined {
  if (databases.length === 0) return undefined;
  const cleaned = stripNoise(sql);
  for (const db of databases) {
    // Match db as a qualified prefix (db.table) or after FROM/JOIN/INTO/DATABASE.
    const escaped = db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^A-Za-z0-9_])${escaped}\\s*\\.|\\b(DATABASE|FROM|JOIN|INTO)\\s+${escaped}\\b`, "i");
    if (re.test(cleaned)) return db;
  }
  return undefined;
}
