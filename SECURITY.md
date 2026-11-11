# Security

`mcp-clickhouse` exposes SQL access to an AI agent. Treat it like any other
privileged database automation and grant it the least access it needs.

## Principles

- **Start read-only.** Leave `CLICKHOUSE_MODE=read-only` until you need writes.
  In read-only mode only the read tools are registered, the `query` tool refuses
  any non-`SELECT` statement, and queries run with ClickHouse's own `readonly=1`
  setting as defence in depth.
- **Statements are classified.** Every statement is parsed into read / write /
  destructive (see `src/sql.ts`). ALTER is context-sensitive — an `ALTER … DELETE`
  or `ALTER … UPDATE` mutation is treated as destructive. Unknown or unparseable
  statements are treated as destructive (fail safe).
- **Scope with RBAC, not just flags.** The flags are defence in depth; the primary
  control is the ClickHouse user/role the server authenticates as. Prefer a
  read-only user with `readonly` profile and grants on only the databases you intend.
- **Protect system databases.** `system` and `information_schema` are protected by
  default (readable, never mutable). Add more via `CLICKHOUSE_PROTECTED_DATABASES`.
- **Gate destructive statements.** DROP/TRUNCATE/DELETE/… require both `admin` mode
  and `CLICKHOUSE_ALLOW_DELETE=true`.
- **Require a human for destructive statements.** Set `CLICKHOUSE_REQUIRE_HUMAN_APPROVAL=true` so a
  destructive `execute` is refused when the client cannot show an approval prompt. Each approval is
  bound to the exact tool and arguments (fingerprint of the full SQL, which the prompt shows in full)
  and, when the statement names its target, to that object's version: for tables, views and
  dictionaries a hash of its `system.tables` uuid, engine, metadata modification time and
  `create_table_query`; for a database, its `system.databases` uuid and engine plus a hash of every
  table in it (name, uuid, metadata mtime). If the target changed while the human was deciding, the
  statement is refused. `DROP TABLE` and `DROP DATABASE` also ask the human to type the name. Approval
  receipts are written to the audit log (`"audit":"approval"`, with `approvedBy` = `human` or `flag-only`).
  A prompt nobody answers is a refusal, not an approval.
- **Cap result size.** `CLICKHOUSE_MAX_ROWS` bounds rows returned to the model.
- **Preview with dry-run.** `CLICKHOUSE_DRY_RUN=true` validates and logs write
  intent without executing.

## Limitations

- Database allowlist/protection enforcement on *arbitrary* SQL is best-effort
  (statement text is scanned for protected database references). For hard
  guarantees, rely on ClickHouse RBAC for the connecting user.

- Version pinning covers metadata, not data: row inserts or deletes during the prompt do not change a
  table's token. It only applies to `DROP` (database / table / view / dictionary, not `TEMPORARY` tables),
  `TRUNCATE TABLE`, `DELETE FROM` and `ALTER TABLE … DELETE|UPDATE` whose target can be read off the
  statement; other destructive statements (e.g. `KILL`, `DETACH`, `ALTER` with an unusual shape) are bound
  by the statement fingerprint alone, and the prompt shows no resource version. The probe runs on the
  connected node (not every replica of an `ON CLUSTER` statement) and only sees objects the connecting user
  may see in `system.tables` / `system.databases`.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue.
