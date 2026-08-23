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
- **Cap result size.** `CLICKHOUSE_MAX_ROWS` bounds rows returned to the model.
- **Preview with dry-run.** `CLICKHOUSE_DRY_RUN=true` validates and logs write
  intent without executing.

## Limitations

- Database allowlist/protection enforcement on *arbitrary* SQL is best-effort
  (statement text is scanned for protected database references). For hard
  guarantees, rely on ClickHouse RBAC for the connecting user.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue.
