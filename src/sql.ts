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

// --- Approval targets -------------------------------------------------------

export type TargetKind = "database" | "table" | "view" | "dictionary";

/** The object(s) a destructive statement acts on, as far as we can tell from the statement text. */
export interface StatementTarget {
  verb: "DROP" | "TRUNCATE" | "DELETE" | "ALTER";
  kind: TargetKind;
  /** For `kind: "database"` only `name` is set (it is the database). Otherwise `database` is absent when unqualified. */
  names: Array<{ database?: string; name: string }>;
}

type Tok = { k: "word" | "id" | "dot" | "comma" | "semi" | "other"; v: string };

/**
 * Minimal tokenizer: skips whitespace and line (`--`) and block comments, understands bare words and
 * `` `quoted` `` / `"quoted"` identifiers. Anything it does not understand becomes an `other` token and
 * the parsers below refuse it, so an exotic statement is left *unparsed* (never mis-parsed).
 * Returns undefined for unterminated quotes/comments and for identifiers containing a backslash.
 */
function tokenize(sql: string): Tok[] | undefined {
  const toks: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return undefined;
      i = end + 2;
    } else if (c === "`" || c === '"') {
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= sql.length) return undefined;
        const d = sql[j]!;
        if (d === "\\") return undefined;
        if (d === c) {
          if (sql[j + 1] === c) {
            v += c;
            j += 2;
            continue;
          }
          break;
        }
        v += d;
        j++;
      }
      toks.push({ k: "id", v });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      toks.push({ k: "word", v: sql.slice(i, j) });
      i = j;
    } else if (c === ".") {
      toks.push({ k: "dot", v: c });
      i++;
    } else if (c === ",") {
      toks.push({ k: "comma", v: c });
      i++;
    } else if (c === ";") {
      toks.push({ k: "semi", v: c });
      i++;
    } else {
      toks.push({ k: "other", v: c });
      i++;
    }
  }
  return toks;
}

class Cursor {
  constructor(readonly toks: Tok[], public pos = 0) {}
  peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  /** Consume the next token if it is the keyword `kw` (a bare word, case-insensitive). */
  kw(kw: string): boolean {
    const t = this.peek();
    if (t?.k === "word" && t.v.toUpperCase() === kw) {
      this.pos++;
      return true;
    }
    return false;
  }
  /** Consume a sequence of keywords, all or nothing. */
  kws(...words: string[]): boolean {
    const start = this.pos;
    for (const w of words) {
      if (!this.kw(w)) {
        this.pos = start;
        return false;
      }
    }
    return true;
  }
  ident(): string | undefined {
    const t = this.peek();
    if (t && (t.k === "word" || t.k === "id")) {
      this.pos++;
      return t.v;
    }
    return undefined;
  }
  /** `name` or `db.name`. */
  qualified(): { database?: string; name: string } | undefined {
    const first = this.ident();
    if (first === undefined) return undefined;
    if (this.peek()?.k === "dot") {
      this.pos++;
      const second = this.ident();
      return second === undefined ? undefined : { database: first, name: second };
    }
    return { name: first };
  }
  done(): boolean {
    if (this.peek()?.k === "semi") this.pos++;
    return this.pos >= this.toks.length;
  }
}

/** Trailing clauses that may follow the object name(s) of DROP/TRUNCATE: ON CLUSTER x, SYNC, NO DELAY. */
function trailingClauses(cur: Cursor): boolean {
  for (;;) {
    if (cur.kws("ON", "CLUSTER")) {
      if (cur.ident() === undefined) return false;
    } else if (cur.kws("NO", "DELAY") || cur.kw("SYNC")) {
      // accepted
    } else {
      return cur.done();
    }
  }
}

/**
 * Best-effort extraction of the object a destructive statement acts on, used only to read a
 * version token for the approval prompt. Conservative on purpose:
 *  - DROP DATABASE / TABLE / VIEW / DICTIONARY and TRUNCATE [TABLE] must match the whole statement
 *    (optional IF EXISTS / ON CLUSTER / SYNC / NO DELAY only); anything else is left unparsed.
 *  - DELETE FROM t … and ALTER TABLE t … DELETE|UPDATE … only need the table name.
 * Returns undefined when it cannot be sure; the human is still shown the exact statement.
 */
export function parseStatementTarget(sql: string): StatementTarget | undefined {
  const toks = tokenize(sql);
  if (!toks) return undefined;
  const cur = new Cursor(toks);

  if (cur.kw("DROP")) {
    let kind: TargetKind;
    if (cur.kw("DATABASE")) kind = "database";
    else if (cur.kw("TABLE")) kind = "table";
    else if (cur.kw("VIEW")) kind = "view";
    else if (cur.kw("DICTIONARY")) kind = "dictionary";
    else return undefined; // DROP TEMPORARY TABLE, USER, ROLE, FUNCTION, …
    cur.kws("IF", "EXISTS");
    if (kind === "table") cur.kws("IF", "EMPTY");
    const names: StatementTarget["names"] = [];
    for (;;) {
      const q = cur.qualified();
      if (!q) return undefined;
      if (kind === "database") {
        if (q.database !== undefined) return undefined;
        names.push({ name: q.name });
      } else {
        names.push(q);
      }
      if (kind === "table" && cur.peek()?.k === "comma") {
        cur.pos++;
        continue;
      }
      break;
    }
    return trailingClauses(cur) ? { verb: "DROP", kind, names } : undefined;
  }

  if (cur.kw("TRUNCATE")) {
    const next = cur.peek();
    if (next?.k === "word" && ["ALL", "DATABASE", "TEMPORARY"].includes(next.v.toUpperCase())) return undefined;
    cur.kw("TABLE");
    cur.kws("IF", "EXISTS");
    const q = cur.qualified();
    if (!q) return undefined;
    return trailingClauses(cur) ? { verb: "TRUNCATE", kind: "table", names: [q] } : undefined;
  }

  if (cur.kws("DELETE", "FROM")) {
    const q = cur.qualified();
    return q ? { verb: "DELETE", kind: "table", names: [q] } : undefined;
  }

  if (cur.kws("ALTER", "TABLE")) {
    cur.kws("IF", "EXISTS");
    const q = cur.qualified();
    return q ? { verb: "ALTER", kind: "table", names: [q] } : undefined;
  }

  return undefined;
}
