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

/** Index just past the quoted run (`'…'`, `"…"` or `` `…` ``) that starts at `sql[i]`; end of input when unterminated. */
function skipQuoted(sql: string, i: number): number {
  const q = sql[i]!;
  let j = i + 1;
  while (j < sql.length) {
    const d = sql[j]!;
    if (d === "\\") j += 2;
    else if (d === q) {
      if (sql[j + 1] === q) j += 2; // doubled quote
      else return j + 1;
    } else j++;
  }
  return sql.length;
}

/** Length of a ClickHouse heredoc (`$$ … $$` or `$tag$ … $tag$`) starting at `sql[i]`, or -1 when there is none / it is unterminated. */
function heredocLength(sql: string, i: number): number {
  const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 130));
  if (!m) return -1;
  const end = sql.indexOf(m[0], i + m[0].length);
  return end === -1 ? -1 : end + m[0].length - i;
}

/**
 * Strip line/block comments and string literals so keyword detection is robust. One pass using the
 * lexical rules ClickHouse uses: a `--` inside a string is not a comment, a quote inside a comment is
 * not a string, heredocs are strings, and `#` / `#!` start a line comment. Backtick identifiers are
 * kept verbatim.
 */
export function stripNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if ((c === "-" && next === "-") || (c === "#" && (next === " " || next === "!"))) {
      const nl = sql.indexOf("\n", i);
      out += " ";
      i = nl === -1 ? sql.length : nl;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"') {
      out += c + c;
      i = skipQuoted(sql, i);
    } else if (c === "`") {
      const j = skipQuoted(sql, i);
      out += sql.slice(i, j);
      i = j;
    } else if (c === "$" && heredocLength(sql, i) !== -1) {
      out += "''";
      i += heredocLength(sql, i);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const READ_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN", "CHECK"]);
const WRITE_KEYWORDS = new Set(["INSERT", "CREATE", "ATTACH", "OPTIMIZE", "SET", "GRANT", "REVOKE", "SYSTEM"]);
// RENAME and EXCHANGE swap tables out from under their names (and between databases): they hide data.
const DESTRUCTIVE_KEYWORDS = new Set(["DROP", "TRUNCATE", "DELETE", "KILL", "DETACH", "RENAME", "EXCHANGE", "REPLACE"]);

/** Classify a single-or-multi statement SQL string. */
export function classifyStatement(sql: string): Classification {
  const cleaned = stripNoise(sql).trim();
  const withoutTrailing = cleaned.replace(/;\s*$/, "");
  const multiStatement = /;\s*\S/.test(withoutTrailing);

  const firstKeyword = (withoutTrailing.match(/[A-Za-z_]+/)?.[0] ?? "").toUpperCase();

  // ALTER is context-sensitive: mutations (DELETE/UPDATE) and commands that lose or hide data (DROP
  // COLUMN/INDEX/PARTITION/…, DETACH/CLEAR/RENAME/REPLACE PARTITION, MOVE … TO TABLE, MODIFY TTL, …)
  // are destructive; the rest (ADD/MODIFY COLUMN, ATTACH PARTITION, …) are writes.
  if (firstKeyword === "ALTER") {
    return { class: alterIsDestructive(sql, withoutTrailing) ? "destructive" : "write", keyword: "ALTER", multiStatement };
  }

  // CREATE OR REPLACE TABLE|VIEW|DICTIONARY drops what it replaces (REPLACE TABLE … is in DESTRUCTIVE_KEYWORDS);
  // OPTIMIZE … DEDUPLICATE / CLEANUP removes rows. Plain CREATE and OPTIMIZE stay writes.
  if (firstKeyword === "CREATE" && /^\s*CREATE\s+OR\s+REPLACE\s+(?:TEMPORARY\s+)?(?:(?:MATERIALIZED|LIVE|WINDOW)\s+)?(?:TABLE|VIEW|DICTIONARY)\b/i.test(withoutTrailing)) {
    return { class: "destructive", keyword: firstKeyword, multiStatement };
  }
  if (firstKeyword === "OPTIMIZE" && optimizeRemovesRows(sql, withoutTrailing)) {
    return { class: "destructive", keyword: firstKeyword, multiStatement };
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
  verb: "DROP" | "TRUNCATE" | "DELETE" | "ALTER" | "RENAME" | "EXCHANGE" | "REPLACE" | "OPTIMIZE";
  kind: TargetKind;
  /** For `kind: "database"` only `name` is set (it is the database). Otherwise `database` is absent when unqualified. */
  names: Array<{ database?: string; name: string }>;
}

type Tok = { k: "word" | "id" | "str" | "dot" | "comma" | "semi" | "lp" | "rp" | "other"; v: string };

/** Content of a `'…'` string literal (naive unescaping: `''` is a quote, `\x` is `x`). */
function unquote(raw: string): string {
  let v = "";
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] === "\\") v += raw[++i] ?? "";
    else if (raw[i] === "'" && raw[i + 1] === "'") {
      v += "'";
      i++;
    } else v += raw[i];
  }
  return v;
}

/**
 * Minimal tokenizer: skips whitespace and line (`--`) and block comments, understands bare words,
 * `` `quoted` `` / `"quoted"` identifiers, `'string'` literals and `$$heredoc$$` strings. Anything else
 * becomes an `other` token and the parsers below refuse it, so an exotic statement is left *unparsed*
 * (never mis-parsed). Returns undefined for unterminated quotes/comments/heredocs, for identifiers
 * containing a backslash, and for `#` (a ClickHouse line-comment starter we deliberately do not follow:
 * a lexer that disagrees with the server about what is a comment can be made to hide code).
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
    } else if (c === "#") {
      return undefined;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return undefined;
      i = end + 2;
    } else if (c === "'") {
      const j = skipQuoted(sql, i);
      if (sql[j - 1] !== "'" || j - i < 2) return undefined; // unterminated
      toks.push({ k: "str", v: unquote(sql.slice(i, j)) });
      i = j;
    } else if (c === "$") {
      const n = heredocLength(sql, i);
      if (n === -1) {
        // `$` outside an identifier is only valid as a heredoc opener; an unterminated one is not a statement we understand.
        if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i, i + 130))) return undefined;
        toks.push({ k: "other", v: c });
        i++;
      } else {
        const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 130))![0];
        toks.push({ k: "str", v: sql.slice(i + tag.length, i + n - tag.length) });
        i += n;
      }
    } else if (c === "(") {
      toks.push({ k: "lp", v: c });
      i++;
    } else if (c === ")") {
      toks.push({ k: "rp", v: c });
      i++;
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
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j]!)) j++;
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

  // [CREATE OR] REPLACE [MATERIALIZED|LIVE|WINDOW] TABLE|VIEW|DICTIONARY [IF NOT EXISTS] name … — the replaced object
  // (absent is fine: a version probe on a missing object reads as "absent"). TEMPORARY objects are left unparsed.
  if (cur.pos === 0 && (cur.kws("CREATE", "OR", "REPLACE") || cur.kw("REPLACE"))) {
    cur.kw("MATERIALIZED") || cur.kw("LIVE") || cur.kw("WINDOW");
    const kind: TargetKind | undefined = cur.kw("TABLE") ? "table" : cur.kw("VIEW") ? "view" : cur.kw("DICTIONARY") ? "dictionary" : undefined;
    if (!kind) return undefined;
    cur.kws("IF", "NOT", "EXISTS");
    const q = cur.qualified();
    return q ? { verb: "REPLACE", kind, names: [q] } : undefined;
  }

  // OPTIMIZE TABLE [db.]t … (only the name is needed)
  if (cur.kws("OPTIMIZE", "TABLE")) {
    const q = cur.qualified();
    return q ? { verb: "OPTIMIZE", kind: "table", names: [q] } : undefined;
  }

  // RENAME TABLE|DICTIONARY|DATABASE a TO b [, c TO d …] — every name on both sides is pinned.
  if (cur.kw("RENAME")) {
    let kind: TargetKind = "table";
    if (cur.kw("DATABASE")) kind = "database";
    else if (cur.kw("DICTIONARY")) kind = "dictionary";
    else cur.kw("TABLE");
    cur.kws("IF", "EXISTS");
    const names: StatementTarget["names"] = [];
    for (;;) {
      const from = cur.qualified();
      if (!from || !cur.kw("TO")) return undefined;
      const to = cur.qualified();
      if (!to) return undefined;
      if (kind === "database" && (from.database !== undefined || to.database !== undefined)) return undefined;
      names.push(from, to);
      if (cur.peek()?.k === "comma") {
        cur.pos++;
        continue;
      }
      break;
    }
    return trailingClauses(cur) ? { verb: "RENAME", kind, names } : undefined;
  }

  // EXCHANGE TABLES|DICTIONARIES a AND b
  if (cur.kw("EXCHANGE")) {
    const kind: TargetKind | undefined = cur.kw("TABLES") ? "table" : cur.kw("DICTIONARIES") ? "dictionary" : undefined;
    if (!kind) return undefined;
    const a = cur.qualified();
    if (!a || !cur.kw("AND")) return undefined;
    const b = cur.qualified();
    return b && trailingClauses(cur) ? { verb: "EXCHANGE", kind, names: [a, b] } : undefined;
  }

  return undefined;
}

// --- ALTER classification ---------------------------------------------------

/** `OPTIMIZE … DEDUPLICATE [BY …]` and `OPTIMIZE … CLEANUP` delete rows. */
function optimizeRemovesRows(sql: string, cleaned: string): boolean {
  const toks = tokenize(sql);
  if (!toks) return /\b(DEDUPLICATE|CLEANUP)\b/i.test(cleaned);
  return toks.some((t) => t.k === "word" && /^(DEDUPLICATE|CLEANUP)$/i.test(t.v));
}

/** What may follow the column name in a `MODIFY COLUMN` that keeps the column's type (and kind) as it is. */
const MODIFY_COLUMN_KEEPS_TYPE = new Set(["DEFAULT", "COMMENT", "CODEC", "REMOVE", "AFTER", "FIRST", "MODIFY", "RESET"]);

/**
 * Can this `MODIFY COLUMN` change a column's type or kind, or expire its values? Only the clauses that leave the
 * stored values alone (DEFAULT, COMMENT, CODEC, REMOVE …, AFTER/FIRST, column SETTING changes) pass; anything
 * else after the column name — a type (even a restated one: the old type is not known here), MATERIALIZED /
 * ALIAS / EPHEMERAL, something unrecognised — counts, and so does a column TTL (expired values are reset).
 * `i` is the index of the MODIFY token.
 */
function modifyColumnMayLoseData(toks: Tok[], i: number): boolean {
  let j = i + 2; // after MODIFY COLUMN
  const isWord = (k: number, w: string) => toks[k]?.k === "word" && toks[k]!.v.toUpperCase() === w;
  if (isWord(j, "IF") && isWord(j + 1, "EXISTS")) j += 2;
  const name = toks[j];
  if (!name || (name.k !== "word" && name.k !== "id")) return true;
  j++;
  while (toks[j]?.k === "dot" && (toks[j + 1]?.k === "word" || toks[j + 1]?.k === "id")) j += 2; // Nested: n.a
  const next = toks[j];
  if (!next || next.k === "comma" || next.k === "semi") return false;
  if (next.k !== "word" || !MODIFY_COLUMN_KEEPS_TYPE.has(next.v.toUpperCase())) return true;
  let depth = 0;
  for (; j < toks.length && !(depth === 0 && toks[j]!.k === "comma"); j++) {
    if (toks[j]!.k === "lp") depth++;
    else if (toks[j]!.k === "rp") depth--;
    else if (depth === 0 && isWord(j, "TTL")) return true;
  }
  return false;
}

/** Words that start an `ALTER TABLE` command which deletes, detaches, clears, renames or swaps data. */
const ALTER_DATA_LOSING = new Set(["DELETE", "UPDATE", "DROP", "DETACH", "CLEAR", "RENAME", "REPLACE", "EXCHANGE", "FORGET", "UNFREEZE"]);

/**
 * Is this ALTER destructive? Mutations (DELETE / UPDATE anywhere, deliberately loose) and any command that
 * deletes data (DROP COLUMN|INDEX|PROJECTION|CONSTRAINT|PARTITION|PART|DETACHED PARTITION, CLEAR …, MODIFY TTL,
 * FORGET PARTITION, UNFREEZE) or hides/moves it (DETACH, RENAME [COLUMN | TO], REPLACE PARTITION, MOVE … TO
 * TABLE) are. Commands are split at top-level commas, so `ADD COLUMN c Int8, DROP COLUMN d` is destructive.
 * An ALTER whose commands cannot be read (tokenizer refuses it) is destructive, like any unknown statement.
 * `ALTER USER/ROLE/…` (anything but ALTER TABLE) is left a write.
 */
function alterIsDestructive(sql: string, cleaned: string): boolean {
  if (/\bALTER\b[\s\S]*\b(DELETE|UPDATE)\b/i.test(cleaned)) return true;
  const toks = tokenize(sql);
  if (!toks) return true;
  const cur = new Cursor(toks);
  if (!cur.kw("ALTER")) return true;
  if (!cur.kw("TABLE")) return false;
  cur.kws("IF", "EXISTS");
  if (!cur.qualified()) return true;
  if (cur.kws("ON", "CLUSTER") && cur.ident() === undefined) return true;

  let depth = 0;
  let atCommandStart = true;
  for (let i = cur.pos; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k === "lp") depth++;
    else if (t.k === "rp") depth--;
    if (atCommandStart && depth === 0 && t.k === "word") {
      const w = t.v.toUpperCase();
      if (ALTER_DATA_LOSING.has(w)) return true;
      const w2 = (toks[i + 1]?.k === "word" ? toks[i + 1]!.v : "").toUpperCase();
      if (w === "MODIFY" && w2 === "TTL") return true;
      if (w === "MODIFY" && w2 === "COLUMN" && modifyColumnMayLoseData(toks, i)) return true;
      if (w === "MOVE") {
        // MOVE PARTITION|PART … TO DISK|VOLUME stays on this table; … TO TABLE moves the data out of it.
        for (let j = i + 1; j < toks.length && toks[j]!.k !== "comma"; j++) {
          if (toks[j]!.k === "word" && toks[j]!.v.toUpperCase() === "TO" && toks[j + 1]?.k === "word" && toks[j + 1]!.v.toUpperCase() === "TABLE") return true;
        }
      }
    }
    atCommandStart = depth === 0 && t.k === "comma";
  }
  return false;
}

// --- Statement scope: which databases does a statement touch? ---------------

/** The databases a statement touches, read off its text, for enforcing `CLICKHOUSE_DATABASE_ALLOWLIST`. */
export interface StatementScope {
  /** Every database named by the statement; unqualified names resolve to the connection's default database. */
  databases: string[];
  /**
   * Set (with the reason) when the statement could not be fully analysed: tokenizer refused it, unknown
   * statement type, a table function / engine / dictionary function whose target is not a literal, … Callers
   * that enforce a database scope must fail closed on it.
   */
  unresolved?: string;
}

/** Table functions known not to read a ClickHouse database on this server (they read the outside world, or generate rows). */
const SAFE_TABLE_FUNCTIONS = new Set([
  "numbers", "numbers_mt", "zeros", "zeros_mt", "generaterandom", "generate_series", "null", "values", "input", "format",
  "url", "urlcluster", "file", "filecluster", "s3", "s3cluster", "gcs", "hdfs", "azureblobstorage", "deltalake", "iceberg",
  "hudi", "mysql", "postgresql", "mongodb", "redis", "sqlite", "jdbc", "odbc", "executable", "view",
]);
/** Functions whose first argument names a table / dictionary as a string: `dictGet('db.dict', …)`, `joinGet('db.t', …)`, `dictionary('db.d')`. */
const NAME_ARG_FUNCTIONS = /^(dictget\w*|dicthas|dictisin|dictgethierarchy|dictgetchildren|dictgetdescendants|joinget\w*|dictionary)$/;
/** Functions / engines that reach databases by name in ways we do not follow (strings, regexps, remote hosts). */
const UNSCOPED_FUNCTIONS = new Set([
  "remote", "remotesecure", "cluster", "clusterallreplicas", "merge", "mergetreeindex", "hascolumnintable",
  "distributed", "buffer", "clickhouse",
]);
/** `SYSTEM` statements that name no table. Any other SYSTEM statement is not scoped. */
const SYSTEM_NO_TARGET = new Set([
  "FLUSH LOGS", "RELOAD CONFIG", "RELOAD DICTIONARIES", "RELOAD FUNCTIONS", "DROP DNS CACHE", "DROP MARK CACHE",
  "DROP UNCOMPRESSED CACHE", "DROP COMPILED EXPRESSION CACHE", "DROP QUERY CACHE",
]);
/** `SHOW …` forms that name no database or table. */
const SHOW_NO_DATABASE = new Set([
  "DATABASES", "PROCESSLIST", "GRANTS", "USERS", "ROLES", "PRIVILEGES", "ACCESS", "SETTINGS", "SETTING", "ENGINES",
  "FUNCTIONS", "CLUSTERS", "CLUSTER", "QUOTA", "QUOTAS", "PROFILES", "CURRENT", "CHANGED",
]);
/** Keywords that end a FROM clause (a comma after them is not a comma join). */
const FROM_TERMINATORS = new Set([
  "WHERE", "PREWHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "SETTINGS", "FORMAT",
  "WINDOW", "QUALIFY", "UPDATE", "VALUES",
]);
/** Words that can follow FROM / JOIN / INTO / IN / TO / AS without being a table name. */
const NOT_A_TABLE = new Set([
  "INFILE", "OUTFILE", "SELECT", "WITH", "VALUES", "PARTITION", "FORMAT", "SETTINGS", "DISK", "VOLUME", "SHARD", "ALL",
]);
/** Words that cannot be an implicit alias after a table reference. */
const NOT_AN_ALIAS = new Set([
  "WHERE", "PREWHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "SETTINGS", "FORMAT", "WINDOW",
  "QUALIFY", "SELECT", "FROM", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "ANY", "ALL", "ASOF", "SEMI",
  "ANTI", "PASTE", "ARRAY", "GLOBAL", "ON", "USING", "AS", "FINAL", "SAMPLE", "INTO", "WITH", "TO", "VALUES", "PARTITION",
]);
/** `FROM` inside these functions is part of their syntax, not a table reference. */
const FROM_IS_SYNTAX_IN = new Set(["EXTRACT", "TRIM", "SUBSTRING", "SUBSTR", "OVERLAY"]);

interface Frame {
  /** Inside a FROM clause (a comma starts another table reference). */
  from: boolean;
  /** Inside an ARRAY JOIN list (its commas separate expressions, not tables). */
  arrayJoin: boolean;
  /** A SELECT has started at this nesting level (so DDL words after it are expression text, not DDL). */
  select: boolean;
  /** The function this parenthesis belongs to, upper-cased. */
  fn?: string;
}

class ScopeScanner {
  private readonly databases = new Set<string>();
  private unresolvedReason: string | undefined;
  /** CTE names, aliases and table names seen: `x.y` where `x` is one of these is a column path, not `database.table`. */
  private readonly known = new Set<string>();
  private readonly cte = new Set<string>();
  /** First component of every `a.b` outside a recognised table position; resolved against `known` at the end. */
  private readonly dotted: string[] = [];
  private ddl = false;

  constructor(
    private readonly t: Tok[],
    private readonly defaultDatabase: string,
  ) {}

  private unresolved(why: string): void {
    this.unresolvedReason ??= why;
  }
  private word(i: number): string | undefined {
    const x = this.t[i];
    return x?.k === "word" ? x.v.toUpperCase() : undefined;
  }
  private isIdent(i: number): boolean {
    const k = this.t[i]?.k;
    return k === "word" || k === "id";
  }
  private isKw(i: number, ...words: string[]): boolean {
    const w = this.word(i);
    return w !== undefined && words.includes(w);
  }
  private addDefault(): void {
    this.databases.add(this.defaultDatabase);
  }

  run(): StatementScope {
    const t = this.t;
    if (t.length === 0) {
      this.unresolved("empty statement");
      return this.result();
    }
    for (let i = 0; i < t.length; i++) {
      if (this.isIdent(i) && this.word(i + 1) === "AS" && t[i + 2]?.k === "lp") this.cte.add(t[i]!.v);
      if (this.word(i) === "AS" && this.isIdent(i + 1) && t[i + 2]?.k !== "dot") this.known.add(t[i + 1]!.v);
    }

    const first = this.word(0);
    let start = 0;
    if (first === undefined) {
      if (t[0]!.k !== "lp") this.unresolved("statement does not start with a keyword");
    } else {
      switch (first) {
        case "SELECT":
        case "WITH":
        case "EXPLAIN":
        case "INSERT":
        case "DELETE":
        case "SET":
        case "KILL":
          break;
        case "USE":
          if (this.isIdent(1) && t.length <= 2) this.databases.add(t[1]!.v);
          else this.unresolved("unparseable USE");
          start = t.length;
          break;
        case "SHOW":
          start = this.showHead();
          break;
        case "RENAME":
        case "EXCHANGE":
          this.renameHead(first);
          start = t.length;
          break;
        case "GRANT":
        case "REVOKE":
          this.grantHead(0);
          start = t.length;
          break;
        case "SYSTEM":
          this.systemHead();
          start = t.length;
          break;
        case "CHECK":
        case "DESCRIBE":
        case "DESC":
        case "EXISTS":
        case "TRUNCATE":
        case "OPTIMIZE":
        case "UNDROP":
          this.ddl = true;
          if (first === "CHECK" && this.word(1) === "GRANT") {
            this.grantHead(1);
            start = t.length;
          } else start = this.headRef(first);
          break;
        case "DROP":
        case "ALTER":
        case "CREATE":
        case "REPLACE":
        case "ATTACH":
        case "DETACH":
          this.ddl = true;
          break;
        default:
          this.unresolved(`unsupported statement type '${first}'`);
      }
    }
    this.scan(start);
    for (const d of this.dotted) if (!this.known.has(d) && !this.cte.has(d)) this.databases.add(d);
    return this.result();
  }

  private result(): StatementScope {
    return { databases: [...this.databases], ...(this.unresolvedReason ? { unresolved: this.unresolvedReason } : {}) };
  }

  /** `name` or `db.name` at i. */
  private qualAt(i: number): { database?: string; name: string; next: number } | undefined {
    if (!this.isIdent(i)) return undefined;
    if (this.t[i + 1]?.k === "dot" && this.isIdent(i + 2)) {
      return { database: this.t[i]!.v, name: this.t[i + 2]!.v, next: i + 3 };
    }
    return { name: this.t[i]!.v, next: i + 1 };
  }

  private addQualified(q: { database?: string; name: string }, kind: "table" | "database" = "table"): void {
    if (kind === "database") this.databases.add(q.name);
    else if (q.database !== undefined) this.databases.add(q.database);
    else if (!this.cte.has(q.name)) this.addDefault();
    this.known.add(q.name);
  }

  /**
   * Read a table reference at i (`t`, `db.t`, or — when `call` — a table function `f(…)`), record it and
   * return the index just past it. Returns i unchanged when there is no table reference there.
   */
  private readRef(i: number, call: boolean): number {
    const tok = this.t[i];
    if (!tok || (tok.k !== "word" && tok.k !== "id")) return i;
    if (tok.k === "word") {
      const w = tok.v.toUpperCase();
      if (w === "TABLE") return this.readRef(i + 1, call);
      if (w === "FUNCTION") return this.isIdent(i + 1) ? (this.checkFunction(this.t[i + 1]!.v, i + 1, true), i + 2) : i + 1;
      if (NOT_A_TABLE.has(w)) return i;
    }
    if (this.t[i + 1]?.k === "lp" && call) {
      this.checkFunction(tok.v, i, true);
      return i + 1;
    }
    const q = this.qualAt(i)!;
    this.addQualified(q);
    if (this.isIdent(q.next) && !(this.word(q.next) !== undefined && NOT_AN_ALIAS.has(this.word(q.next)!))) {
      this.known.add(this.t[q.next]!.v); // implicit alias: `FROM app.t x … x.col`
    }
    return q.next;
  }

  private checkFunction(name: string, i: number, tableContext: boolean): void {
    const l = name.toLowerCase();
    if (NAME_ARG_FUNCTIONS.test(l)) {
      const a = this.t[i + 2];
      const b = this.t[i + 3];
      if (a?.k === "str" && (b?.k === "comma" || b?.k === "rp")) {
        const parts = a.v.split(".");
        if (parts.length === 1) this.addDefault();
        else if (parts.length === 2) this.databases.add(parts[0]!);
        else this.unresolved(`${name}() names '${a.v}', which is not database.name`);
      } else this.unresolved(`${name}() is not called with a literal dictionary/table name`);
      return;
    }
    if (UNSCOPED_FUNCTIONS.has(l)) {
      this.unresolved(`${name}() can reach databases that cannot be determined from the statement text`);
      return;
    }
    if (tableContext && !SAFE_TABLE_FUNCTIONS.has(l)) this.unresolved(`table function ${name}() is not understood`);
  }

  /** TRUNCATE / DESCRIBE / EXISTS / CHECK / OPTIMIZE / UNDROP: the object follows an optional kind word. Returns where scanning resumes. */
  private headRef(first: string): number {
    let j = 1;
    if (this.isKw(j, "TEMPORARY")) j++;
    if (first === "TRUNCATE" && this.isKw(j, "ALL") && this.isKw(j + 1, "TABLES")) {
      j += 2;
      if (this.isKw(j, "IF") && this.isKw(j + 1, "EXISTS")) j += 2;
      if (this.isKw(j, "FROM")) {
        j++;
        if (this.isKw(j, "IF") && this.isKw(j + 1, "EXISTS")) j += 2;
        if (this.isIdent(j)) {
          this.databases.add(this.t[j]!.v);
          return j + 1;
        }
      }
      this.unresolved("TRUNCATE ALL TABLES without a database");
      return this.t.length;
    }
    if (this.isKw(j, "DATABASE")) {
      j++;
      if (this.isKw(j, "IF") && this.isKw(j + 1, "EXISTS")) j += 2;
      if (this.isIdent(j)) {
        this.databases.add(this.t[j]!.v);
        return j + 1;
      }
      this.unresolved(`unparseable ${first} DATABASE`);
      return this.t.length;
    }
    if (this.isKw(j, "TABLE", "VIEW", "DICTIONARY")) j++;
    if (this.isKw(j, "IF") && this.isKw(j + 1, "EXISTS")) j += 2;
    const x = this.t[j];
    if (!x || x.k === "lp" || this.isKw(j, "FUNCTION", "SELECT", "WITH")) return j;
    return this.readRef(j, false);
  }

  private showHead(): number {
    const t = this.t;
    let j = 1;
    while (this.isKw(j, "TEMPORARY", "FULL", "EXTENDED")) j++;
    const w = this.word(j);
    if (w === "CREATE") {
      j++;
      if (this.isKw(j, "TEMPORARY")) j++;
      if (this.isKw(j, "DATABASE")) {
        if (this.isIdent(j + 1)) {
          this.databases.add(t[j + 1]!.v);
          return j + 2;
        }
      } else if (this.isKw(j, "USER", "ROLE", "QUOTA", "SETTINGS", "PROFILE", "ACCESS", "FUNCTION", "NAMED")) {
        return t.length;
      } else if (this.isKw(j, "ROW", "POLICY")) {
        this.unresolved("SHOW CREATE POLICY is not scoped to a database");
        return t.length;
      } else {
        if (this.isKw(j, "MATERIALIZED", "LIVE", "WINDOW")) j++;
        if (this.isKw(j, "TABLE", "VIEW", "DICTIONARY")) j++;
        return this.readRef(j, false);
      }
      this.unresolved("unparseable SHOW CREATE");
      return t.length;
    }
    if (w === "TABLES" || w === "DICTIONARIES") {
      j++;
      if (this.isKw(j, "FROM", "IN") && this.isIdent(j + 1)) {
        this.databases.add(t[j + 1]!.v);
        return j + 2;
      }
      this.addDefault();
      return j;
    }
    if (w === "COLUMNS" || w === "INDEX" || w === "INDEXES" || w === "KEYS" || w === "FIELDS") {
      j++;
      const q = this.isKw(j, "FROM", "IN") ? this.qualAt(j + 1) : undefined;
      if (!q) {
        this.unresolved(`unparseable SHOW ${w}`);
        return t.length;
      }
      let next = q.next;
      let db2: string | undefined;
      if (this.isKw(next, "FROM", "IN") && this.isIdent(next + 1)) {
        db2 = t[next + 1]!.v;
        next += 2;
      }
      if (q.database !== undefined) this.databases.add(q.database);
      if (db2 !== undefined) this.databases.add(db2);
      if (q.database === undefined && db2 === undefined) this.addDefault();
      this.known.add(q.name);
      return next;
    }
    if (w !== undefined && SHOW_NO_DATABASE.has(w)) return j;
    this.unresolved(`unsupported SHOW ${w ?? ""}`.trim());
    return t.length;
  }

  private renameHead(first: "RENAME" | "EXCHANGE"): void {
    const t = this.t;
    let j = 1;
    const fail = () => {
      this.unresolved(`unparseable ${first}`);
    };
    if (first === "EXCHANGE") {
      if (!this.isKw(j, "TABLES", "DICTIONARIES")) return fail();
      const a = this.qualAt(j + 1);
      if (!a || !this.isKw(a.next, "AND")) return fail();
      const b = this.qualAt(a.next + 1);
      if (!b) return fail();
      this.addQualified(a);
      this.addQualified(b);
      j = b.next;
    } else {
      let kind: "table" | "database" = "table";
      if (this.isKw(j, "DATABASE")) {
        kind = "database";
        j++;
      } else if (this.isKw(j, "TABLE", "DICTIONARY")) j++;
      if (this.isKw(j, "IF") && this.isKw(j + 1, "EXISTS")) j += 2;
      for (;;) {
        const a = this.qualAt(j);
        if (!a || !this.isKw(a.next, "TO")) return fail();
        const b = this.qualAt(a.next + 1);
        if (!b) return fail();
        this.addQualified(a, kind);
        this.addQualified(b, kind);
        j = b.next;
        if (t[j]?.k === "comma") {
          j++;
          continue;
        }
        break;
      }
    }
    if (this.isKw(j, "ON") && this.isKw(j + 1, "CLUSTER") && this.isIdent(j + 2)) j += 3;
    if (t[j]?.k === "semi") j++;
    if (j < t.length) fail();
  }

  /** GRANT / REVOKE (and CHECK GRANT): the database named after `ON`, if any. */
  private grantHead(from: number): void {
    const t = this.t;
    let k = from;
    while (k < t.length && !(this.isKw(k, "ON") && !this.isKw(k + 1, "CLUSTER"))) k++;
    if (k >= t.length) return; // role grants name no database
    const x = t[k + 1];
    const star = (i: number) => t[i]?.k === "other" && t[i]!.v === "*";
    if (x && star(k + 1)) {
      if (t[k + 2]?.k === "dot") this.unresolved("grants on all databases are not scoped");
      else this.addDefault();
    } else if (this.isIdent(k + 1)) {
      if (t[k + 2]?.k === "dot" && (star(k + 3) || this.isIdent(k + 3))) this.databases.add(x!.v);
      else this.addDefault();
    } else this.unresolved("unparseable GRANT target");
  }

  private systemHead(): void {
    const rest = this.t.slice(1);
    if (rest.length > 0 && rest.every((x) => x.k === "word") && SYSTEM_NO_TARGET.has(rest.map((x) => x.v.toUpperCase()).join(" "))) return;
    this.unresolved("SYSTEM statements are not scoped to a database");
  }

  /** DROP/ALTER/CREATE … TABLE|VIEW|DICTIONARY|DATABASE [IF …] name[, name …]. Returns the index after the names. */
  private typeRef(i: number, kind: string): number {
    let j = i + 1;
    if (this.isKw(j, "IF")) {
      if (this.isKw(j + 1, "NOT") && this.isKw(j + 2, "EXISTS")) j += 3;
      else if (this.isKw(j + 1, "EXISTS", "EMPTY")) j += 2;
    }
    if (kind === "DATABASE") {
      if (this.isIdent(j)) {
        this.databases.add(this.t[j]!.v);
        return j + 1;
      }
      return i + 1;
    }
    j = this.readRef(j, false);
    while (this.t[j]?.k === "comma" && this.isIdent(j + 1)) j = this.readRef(j + 1, false);
    return j;
  }

  /** Walk the tokens from `start`, finding every table reference (including in subqueries). */
  private scan(start: number): void {
    const t = this.t;
    const frames: Frame[] = [{ from: false, arrayJoin: false, select: false }];
    let i = start;
    while (i < t.length) {
      const tok = t[i]!;
      const top = frames[frames.length - 1]!;
      if (tok.k === "lp") {
        frames.push({ from: false, arrayJoin: false, select: false, fn: t[i - 1]?.k === "word" ? t[i - 1]!.v.toUpperCase() : undefined });
        i++;
      } else if (tok.k === "rp") {
        if (frames.length > 1) frames.pop();
        i++;
      } else if (tok.k === "semi") {
        top.from = false;
        top.arrayJoin = false;
        top.select = false;
        this.ddl = true; // anything after a `;` is judged as if it could be DDL
        i++;
      } else if (tok.k === "comma") {
        i = top.from && !top.arrayJoin ? this.readRef(i + 1, true) : i + 1;
      } else if (tok.k !== "word" && tok.k !== "id") {
        i++;
      } else {
        if (t[i - 1]?.k !== "dot" && t[i + 1]?.k === "dot" && this.isIdent(i + 2)) this.dotted.push(tok.v);
        i = tok.k === "word" ? this.word_(i, top, frames.length) : i + 1;
      }
    }
  }

  private word_(i: number, top: Frame, depth: number): number {
    const t = this.t;
    const U = t[i]!.v.toUpperCase();
    if (t[i + 1]?.k === "lp") this.checkFunction(t[i]!.v, i, false);
    const inDdl = this.ddl && !top.select;
    switch (U) {
      case "SELECT":
        top.select = true;
        top.fn = undefined; // a SELECT inside `extract( … )` is a query, whatever the parenthesis belongs to
        top.from = false;
        top.arrayJoin = false;
        return i + 1;
      case "FROM":
        if (this.word(i - 1) === "DISTINCT" || (top.fn !== undefined && FROM_IS_SYNTAX_IN.has(top.fn))) return i + 1;
        top.from = true;
        top.arrayJoin = false;
        return this.readRef(i + 1, true);
      case "JOIN":
        if (this.word(i - 1) === "ARRAY") {
          top.arrayJoin = true;
          top.from = false;
          return i + 1;
        }
        top.from = true;
        top.arrayJoin = false;
        return this.readRef(i + 1, true);
      case "INTO":
        return this.readRef(i + 1, false);
      case "IN": {
        const nx = i + 1;
        const w = this.word(nx);
        if (this.isIdent(nx) && !(w !== undefined && NOT_A_TABLE.has(w)) && t[nx + 1]?.k !== "lp") return this.readRef(nx, false);
        return i + 1;
      }
      case "TO": {
        if (!inDdl) return i + 1;
        let j = i + 1;
        if (this.isKw(j, "TABLE")) j++;
        if (this.isKw(j, "DISK", "VOLUME", "SHARD")) return j;
        return this.readRef(j, false);
      }
      case "TABLE":
      case "VIEW":
      case "DICTIONARY":
      case "DATABASE":
        return inDdl ? this.typeRef(i, U) : i + 1;
      case "AS": {
        const nx = i + 1;
        if (this.isIdent(nx) && t[nx + 1]?.k === "dot" && this.isIdent(nx + 2)) return this.readRef(nx, false); // AS db.t
        const w = this.word(nx);
        if (inDdl && depth === 1 && this.isIdent(nx) && !(w !== undefined && NOT_A_TABLE.has(w))) {
          return this.readRef(nx, true); // CREATE TABLE x AS [db.]other / AS tablefunction(…)
        }
        return i + 1;
      }
      case "POLICY":
      case "POLICIES":
        if (inDdl) this.unresolved("row policies are not scoped to a database");
        return i + 1;
      default:
        if (FROM_TERMINATORS.has(U)) {
          top.from = false;
          top.arrayJoin = false;
        }
        return i + 1;
    }
  }
}

/**
 * Best-effort extraction of every database a statement touches: qualified names in FROM / JOIN / INTO /
 * IN / TO / AS / TABLE|VIEW|DICTIONARY|DATABASE positions, USE, SHOW … FROM, RENAME / EXCHANGE, GRANT … ON,
 * subqueries and CTEs, `dictGet('db.d', …)`-style functions, and (as a catch-all) any `a.b` that is not a
 * column path off a known alias / table / CTE. Unqualified table names resolve to `defaultDatabase`
 * (the database the connection actually runs against, whatever `database` argument a tool was given).
 * Tokenizing follows ClickHouse's lexical rules (strings, heredocs, comments) so quoted text is never read
 * as code and code is never hidden in what looks like a string.
 *
 * Anything it cannot analyse is reported in `unresolved` rather than guessed at.
 */
export function statementScope(sql: string, defaultDatabase: string): StatementScope {
  const toks = tokenize(sql);
  if (!toks) {
    return { databases: [], unresolved: "the statement could not be tokenized (unterminated quote/comment/heredoc, backslash in an identifier, or a '#' comment)" };
  }
  return new ScopeScanner(toks, defaultDatabase).run();
}
