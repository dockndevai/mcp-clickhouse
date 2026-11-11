# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-11

### Security
- **`CREATE OR REPLACE` / `REPLACE`, `OPTIMIZE … DEDUPLICATE|CLEANUP` and type-changing `MODIFY COLUMN` are destructive.** All
  three lose data but classified as plain writes (no `CLICKHOUSE_ALLOW_DELETE`, no confirmation). They now need admin mode +
  `CLICKHOUSE_ALLOW_DELETE` and a human confirmation, and the table / view / dictionary being replaced or optimized has its
  version pinned across the prompt (a missing object reads as "absent"). Plain `CREATE`, `OPTIMIZE [FINAL]` and
  `CREATE OR REPLACE FUNCTION` stay writes. `ALTER … MODIFY COLUMN` is destructive unless the only thing after the column name
  is `DEFAULT`, `COMMENT`, `CODEC`, `REMOVE …`, `AFTER` / `FIRST` or a column `MODIFY|RESET SETTING`: a type (even a restated
  one, since the existing type is not known), `MATERIALIZED` / `ALIAS` / `EPHEMERAL` or any unrecognised clause counts, and so does
  a column `TTL`, which resets expired values to their default. `ALTER TABLE … REPLACE PARTITION` was already covered.
- Strict mode (`*_REQUIRE_HUMAN_APPROVAL`) now refuses an action whose target's version cannot be read (it used to proceed unpinned), and the approval prompt no longer calls reversible changes (moves, config changes) irreversible.
- **Approval prompts are fully reviewable.** Arguments are shown in full up to 16 000 characters (previously cut at 1500, so a padded prefix could hide the tail of a long statement); a longer action is refused instead of approved blind. Secret redaction in prompts matches whole words (`bypass`/`tokenizer` are no longer shown as `[redacted]`).
- laya-guard now receives the secret-redacted arguments (`canonicalArgs`) instead of `JSON.stringify(args)`, so credentials in tool arguments no longer reach the guard prompt, the guard daemon, or its log.
- **Approval no longer fails open on timeout.** The human-approval prompt used the MCP SDK's default
  60 s request timeout, and a timeout fell through to "approved" (the `CLICKHOUSE_ALLOW_DELETE` gate had
  already passed). A prompt nobody answered therefore auto-approved a destructive statement. A timeout is now a
  refusal, and the wait defaults to 5 minutes.
- **`CLICKHOUSE_DATABASE_ALLOWLIST` now covers the databases the SQL names, not just the optional `database`
  argument.** Previously a statement that left `database` out (`DROP TABLE other.t`, `SELECT * FROM other.t`, an
  `INSERT … SELECT` from another database) skipped the allowlist, and the `query` tool never checked it at all.
  `execute` and `query` now extract every database a statement touches (qualified names, `USE`, `JOIN`s,
  subqueries and CTEs, `INSERT … SELECT`, `RENAME` / `EXCHANGE` / `MOVE PARTITION … TO TABLE` / `REPLACE PARTITION
  … FROM`, `SHOW … FROM`, `GRANT … ON`, `dictGet('db.d', …)`) and check each against the allowlist. Unqualified
  names resolve to the connection's default database (`CLICKHOUSE_DATABASE`), which the `database` argument never
  changed, so that database must be allowlisted too. When an allowlist is set and the statement cannot be analysed
  (`remote()` / `cluster()` / `merge()` and unknown table functions, `Distributed` / `Merge` / `Buffer` engines,
  dictionaries sourced from ClickHouse, `SYSTEM` statements other than a few that name no table, unknown statement
  types, text the tokenizer refuses) it is refused rather than guessed at. Protected databases are now also matched on
  the extracted names (case-insensitively), so e.g. `RENAME TABLE app.t TO system.t` is refused.
- **Data-losing `ALTER` commands and `RENAME` / `EXCHANGE` are destructive.** `ALTER TABLE … DROP PARTITION|PART|COLUMN|INDEX|
  PROJECTION|CONSTRAINT`, `DETACH PARTITION|PART`, `CLEAR COLUMN|INDEX|PROJECTION`, `RENAME COLUMN`, `REPLACE PARTITION`,
  `MOVE PARTITION|PART … TO TABLE`, `FORGET PARTITION`, `UNFREEZE` and `MODIFY TTL`, and top-level `RENAME TABLE|DATABASE|
  DICTIONARY` and `EXCHANGE TABLES|DICTIONARIES`, were classified as plain writes: no `CLICKHOUSE_ALLOW_DELETE`, no
  confirmation. They now need admin mode + `CLICKHOUSE_ALLOW_DELETE` and a human confirmation like `DROP TABLE`, and
  a table version is pinned across the prompt (for `RENAME` / `EXCHANGE`, every table on both sides). Commands are read
  per comma-separated command, so `ADD COLUMN c Int8, DROP COLUMN d` is destructive; an `ALTER` the tokenizer cannot
  read is destructive. Plain schema changes (`ADD`/`MODIFY COLUMN`, `ADD INDEX`, `ATTACH PARTITION`, `MOVE … TO DISK`)
  stay writes.
- **The statement scanner follows ClickHouse's lexical rules.** `stripNoise` removed line comments before strings, so a
  `'--'` literal hid the rest of the line from the classifier (including a following `; DROP TABLE …`) and from the
  protected-database scan. It is now a single pass that understands strings, comments (including `#`), heredocs
  (`$$ … $$`) and backtick identifiers.

### Added
- **Approvals are bound to the exact action.** The prompt shows the tool, the full (secret-redacted)
  arguments (the whole SQL statement, including when it is long) and a fingerprint; every approval and
  refusal is written to the audit log as `"audit":"approval"` with the fingerprint, resource version and
  `approvedBy` (`human` / `flag-only`).
- **Approvals are bound to the target's version.** For `DROP` (table / view / dictionary / database),
  `TRUNCATE TABLE`, `DELETE FROM` and `ALTER TABLE … DELETE|UPDATE`, `execute` reads a version token from
  `system.tables` / `system.databases` before the prompt and again after the human answers, and refuses if
  it changed. Statements whose target cannot be read off the SQL are bound by the fingerprint alone.
- `CLICKHOUSE_REQUIRE_HUMAN_APPROVAL=true` — refuse destructive statements when the client cannot elicit.
- `DROP TABLE` / `DROP DATABASE` ask the human to type the (database-qualified) name.
- `statementScope()` in `src/sql.ts`, the database extractor behind the allowlist change above.

Tracking issue: https://github.com/dockndevai/mcp-core/issues/1

## [0.3.5] - 2026-11-09

### Changed
- Routine dependency/security maintenance. `npm audit --audit-level=high` reported 0
  vulnerabilities both before and after this pass (no high/critical advisories to fix).
- Took safe in-range minor bumps: `@clickhouse/client` 1.24.1 → 1.25.0, `vitest` 5.0.5 → 5.1.0
  (dev dependency). No direct dependency crossed a major version boundary; `npm run typecheck`,
  `npm run build`, and `npm test` all pass; final `npm audit` is clean.

### Note
- Found that v0.3.1–v0.3.4 were committed to `main` in prior maintenance passes but never
  tagged/released — the npm registry's `latest` dist-tag is still 0.3.0. Tagging/publishing is
  blocked for this automated session (release requires pushing a `v*` tag, which this session's
  permission policy denies as "create public surface"); a human needs to push tags
  `v0.3.1`..`v0.3.5` (or squash straight to `v0.3.5`) to actually publish.

## [0.3.4] - 2026-11-02

### Changed
- Routine dependency/security maintenance. `npm audit --audit-level=high` reported 0
  vulnerabilities both before and after this pass (no high/critical advisories to fix).
- Took a safe in-range patch bump: `@types/node` ^26.5.0 26.6.5 → 26.6.6.
- No direct dependency crossed a major version boundary; `npm run typecheck`, `npm run build`,
  and `npm test` all pass; final `npm audit` is clean.

## [0.3.3] - 2026-10-26

### Changed
- Routine weekly dependency maintenance: `npm audit --audit-level=high` flagged a high-severity `body-parser` DoS advisory (GHSA-27r3-jxmh-p828) and a moderate `fast-uri` advisory chain; resolved both via `npm audit fix` (transitive bumps `body-parser` 2.3.0 → 2.4.0, `fast-uri` 3.1.8 → 3.1.9, `qs` 6.16.0 → 6.16.1), no direct dependency crossed a major version. Took the in-range patch bump for `@modelcontextprotocol/sdk` (1.32.1 → 1.32.2). `npm audit` reports 0 vulnerabilities after the bumps.

## [0.3.2] - 2026-10-19

### Changed
- Routine weekly dependency maintenance: `npm audit --audit-level=high` reported 0 advisories (no high/critical findings). Took safe in-range patch bumps for `vitest` (5.0.3 → 5.0.5) and `zod` (4.6.6 → 4.6.7); no direct dependency crossed a major version boundary. `npm audit` reports 0 vulnerabilities after the bumps.

## [0.3.1] - 2026-10-12

### Changed
- Dependency/security maintenance: resolved `npm audit` findings (critical `proxy-addr` IP-spoofing advisory, high `@modelcontextprotocol/sdk` OAuth-redirect advisory, high `source-map-js` DoS advisory) via `npm audit fix` — all resolved within existing semver ranges, no major bumps. Took in-range patch/minor bumps for `@clickhouse/client`, `@types/node`, `tsx`, `vitest`, and `zod`. `npm audit` now reports 0 vulnerabilities.

## [0.3.0] - 2026-09-29

### Added
- **Optional AI risk guard (laya-guard).** Mutating tools can consult a local [laya-guard](https://github.com/dockndevai/laya-guard) daemon that classifies each operation allow / confirm / block before it runs. Runs after the deterministic policy gates and can only *tighten*, never grant; fails closed. Off by default (`CLICKHOUSE_GUARD_MODE=monitor|enforce`).

## [0.2.2] - 2026-09-12

### Changed
- Bring dependencies and CI to current majors: `zod` ^4, TypeScript ^7, `@types/node` ^26, `tsx` ^4.23, and GitHub Actions (checkout v7, setup-node v7, action-gh-release v3, gitleaks v3, codeql-action v4). Clears the open Dependabot updates; `npm audit` reports 0 vulnerabilities.

## [0.2.1] - 2026-09-10

### Documentation
- Document the interactive-confirmation (MCP elicitation) behaviour in the safe-by-default section.

## [0.2.0] - 2026-09-10

### Added
- **Human-in-the-loop confirmation for destructive actions**, via MCP [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation). When the connected client supports elicitation, destructive `execute` statements (DROP/TRUNCATE/DELETE) now pause and ask the **human** to approve the exact action before it runs — a model can echo a confirmation string, but it cannot approve a prompt shown to the user. Clients that don't advertise elicitation fall back to the existing `*_ALLOW_*` flag gate, so enabling this is never *more* permissive than before.

## [0.1.3] - 2026-09-09

### Changed
- Require **Node 22** (previously Node 20); the updated dependency tree needs Node ≥ 22.19. CI and release workflows, the Dockerfile base image, and `engines` were updated.
- Bump the test runner `vitest` to ^5.0.0.

### Security
- Refresh the dependency tree to clear the moderate `hono` and `qs` advisories (transitive via the MCP SDK's HTTP transport, unused by this stdio server) and the `vitest` advisory; `npm audit` now reports **0 vulnerabilities**.

## [0.1.2] - 2026-08-30

### Changed
- Bump `@modelcontextprotocol/sdk` to ^1.30.0 to clear known dependency advisories flagged by supply-chain scanners.

## [0.1.1] - 2026-08-28

### Added
- MCP **tool annotations** on every tool (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`), derived from each tool's access
  capability. Hosts can now reason about a tool's safety from structured
  metadata instead of parsing the description — read tools are advertised as
  read-only and non-destructive, admin/destructive tools as mutating.
- A test that keeps the annotations consistent with each tool's capability.

## [0.1.0]

### Added
- Initial release.
