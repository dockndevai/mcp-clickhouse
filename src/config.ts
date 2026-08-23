/**
 * Configuration from environment variables.
 */
import type { AccessMode, SecurityConfig } from "./security.js";

export interface ClickHouseConnection {
  url: string;
  username: string;
  password: string;
  database: string;
  requestTimeout: number;
}

export interface AppConfig {
  connection: ClickHouseConnection;
  security: SecurityConfig;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function list(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseMode(): AccessMode {
  const raw = (process.env.CLICKHOUSE_MODE ?? "read-only").toLowerCase();
  if (raw === "read-only" || raw === "read-write" || raw === "admin") return raw;
  throw new Error(`Invalid CLICKHOUSE_MODE '${raw}'. Expected one of: read-only, read-write, admin.`);
}

export function loadConfig(): AppConfig {
  const url = process.env.CLICKHOUSE_URL || "http://localhost:8123";
  const protectedDbs = list("CLICKHOUSE_PROTECTED_DATABASES");
  return {
    connection: {
      url,
      username: process.env.CLICKHOUSE_USER || "default",
      password: process.env.CLICKHOUSE_PASSWORD || "",
      database: process.env.CLICKHOUSE_DATABASE || "default",
      requestTimeout: Number(process.env.CLICKHOUSE_TIMEOUT_MS ?? 30000),
    },
    security: {
      mode: parseMode(),
      databaseAllowlist: list("CLICKHOUSE_DATABASE_ALLOWLIST"),
      protectedDatabases: protectedDbs.length ? protectedDbs : ["system", "information_schema", "INFORMATION_SCHEMA"],
      allowDelete: bool("CLICKHOUSE_ALLOW_DELETE", false),
      dryRun: bool("CLICKHOUSE_DRY_RUN", false),
      maxRows: Number(process.env.CLICKHOUSE_MAX_ROWS ?? 1000),
      auditLog: bool("CLICKHOUSE_AUDIT_LOG", true),
    },
  };
}
