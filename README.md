# mcp-clickhouse

[![CI](https://github.com/dockndevai/mcp-clickhouse/actions/workflows/ci.yml/badge.svg)](https://github.com/dockndevai/mcp-clickhouse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@dockndevai/mcp-clickhouse)](https://www.npmjs.com/package/@dockndevai/mcp-clickhouse)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **ClickHouse**. It lets an MCP-capable client (Claude Desktop, Claude Code, etc.) explore schemas, run analytical queries, and manage the database — with behaviour controlled entirely by flags.

The security model is **statement-aware**: every SQL statement is classified as read, write, or destructive, and gated against the current access mode. Read-only mode additionally runs queries under ClickHouse's own `readonly=1` setting.

## Features

- **Exploration & monitoring** — databases, tables, columns, `SHOW CREATE`, table stats (parts/rows/bytes), running queries, server metrics, cluster topology.
- **Read queries** — a `query` tool that only accepts read statements, capped at `CLICKHOUSE_MAX_ROWS`.
- **Management** — an `execute` tool for INSERT/CREATE/ALTER (read-write) and DROP/TRUNCATE/DELETE (admin), each gated by classification.
- **Access modes** — `read-only` → `read-write` → `admin`, layered so a mode never exposes statements above its level.
- **Security flags** — database allowlist, protected databases, destructive gating, row cap, dry-run, and JSON audit logging (see below).

## Security model

| Concern | Flag | Default | Effect |
| --- | --- | --- | --- |
| What can the server do? | `CLICKHOUSE_MODE` | `read-only` | `read-only` exposes read tools only (and refuses non-SELECT in `query`); `read-write` adds `execute` for writes; `admin` allows destructive statements. |
| Which databases are in scope? | `CLICKHOUSE_DATABASE_ALLOWLIST` | *(all)* | When set, operations on other databases are refused. |
| Which databases are read-only forever? | `CLICKHOUSE_PROTECTED_DATABASES` | `system,information_schema` | Readable, never mutable. |
| Can it run destructive SQL? | `CLICKHOUSE_ALLOW_DELETE` | `false` | DROP/TRUNCATE/DELETE/… need this **and** admin mode. |
| Result size cap | `CLICKHOUSE_MAX_ROWS` | `1000` | Hard cap on rows returned to the model. |
| Preview without executing | `CLICKHOUSE_DRY_RUN` | `false` | Write/destructive statements validate + log intent, then return. |
| Audit trail | `CLICKHOUSE_AUDIT_LOG` | `true` | Emits a JSON line to stderr per guarded operation. |

Statement classification lives in `src/sql.ts` and is fail-safe: `ALTER … DELETE/UPDATE` counts as destructive, and anything unparseable is treated as destructive.

## Tools

**Read** (`read-only`+): `list_databases`, `list_tables`, `describe_table`, `show_create_table`, `table_stats`, `running_queries`, `server_metrics`, `cluster_info`, `query`

**Write/Admin** (`read-write`+): `execute` — runs a single statement after classifying it; writes need read-write mode, destructive statements need admin mode + `CLICKHOUSE_ALLOW_DELETE`.

## Quickstart — add to your agent

Published on npm as [`@dockndevai/mcp-clickhouse`](https://www.npmjs.com/package/@dockndevai/mcp-clickhouse). No clone or build needed — your MCP client runs it on demand with `npx`. **Start in `read-only` mode**; see [`.env.example`](.env.example) for every variable and [docs/CLIENTS.md](docs/CLIENTS.md) for the full per-client guide.

**Claude Code** (CLI)

```bash
claude mcp add clickhouse -e CLICKHOUSE_URL="http://localhost:8123" -e CLICKHOUSE_USER="default" -e CLICKHOUSE_MODE="read-only" -- npx -y @dockndevai/mcp-clickhouse
```

**Claude Desktop · Cursor · Windsurf** — same block in `claude_desktop_config.json`, `.cursor/mcp.json`, or `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "clickhouse": {
      "command": "npx",
      "args": [
        "-y",
        "@dockndevai/mcp-clickhouse"
      ],
      "env": {
        "CLICKHOUSE_URL": "http://localhost:8123",
        "CLICKHOUSE_USER": "default",
        "CLICKHOUSE_MODE": "read-only"
      }
    }
  }
}
```

**OpenAI Codex CLI** — in `~/.codex/config.toml`:

```toml
[mcp_servers.clickhouse]
command = "npx"
args = ["-y", "@dockndevai/mcp-clickhouse"]
env = { CLICKHOUSE_URL = "http://localhost:8123", CLICKHOUSE_USER = "default", CLICKHOUSE_MODE = "read-only" }
```

**VS Code (GitHub Copilot, Agent mode)** — in `.vscode/mcp.json`:

```json
{
  "servers": {
    "clickhouse": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@dockndevai/mcp-clickhouse"
      ],
      "env": {
        "CLICKHOUSE_URL": "http://localhost:8123",
        "CLICKHOUSE_USER": "default",
        "CLICKHOUSE_MODE": "read-only"
      }
    }
  }
}
```

## Example prompts

- *"What are the biggest tables in the `analytics` database?"*
- *"Show me the schema for `events` and run a query for daily counts this week."*
- *"Which queries are currently running and using the most memory?"*

## Run from source (development)

Prefer the published package above. To run from a clone:

```bash
npm install
npm run build
node dist/index.js   # with the environment variables set
```

## Develop

```bash
npm run dev
npm test          # SQL classification + security policy (30 tests)
npm run typecheck
```

## Publishing

This server ships a [`server.json`](server.json) for the official MCP registry and an [`mcpName`](package.json) for npm ownership validation. See **[PUBLISHING.md](PUBLISHING.md)** for publishing to npm and listing on the MCP registry, Smithery, Glama, Cursor, and PulseMCP.

## License

MIT
