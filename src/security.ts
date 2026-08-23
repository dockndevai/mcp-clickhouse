/**
 * Security policy engine.
 *
 * Flags decide which tools are registered (capability vs. access mode) and
 * whether each individual call is allowed at runtime (statement class vs. mode,
 * database scoping, protected databases, destructive gating, dry-run). Pure
 * logic — fully unit-testable.
 */
import type { StatementClass } from "./sql.js";

export type Capability = "read" | "write" | "admin";
export type AccessMode = "read-only" | "read-write" | "admin";

const MODE_RANK: Record<AccessMode, number> = {
  "read-only": 0,
  "read-write": 1,
  admin: 2,
};

const CAPABILITY_RANK: Record<Capability, number> = {
  read: 0,
  write: 1,
  admin: 2,
};

/** Map a SQL statement class to the capability it requires. */
export function statementCapability(cls: StatementClass): Capability {
  if (cls === "read") return "read";
  if (cls === "write") return "write";
  return "admin"; // destructive
}

export interface SecurityConfig {
  mode: AccessMode;
  /** If set, only these databases may be touched. Empty = all. */
  databaseAllowlist: string[];
  /** Databases that can be read but never mutated. */
  protectedDatabases: string[];
  /** Destructive statements (DROP/TRUNCATE/DELETE/…) require this to be true. */
  allowDelete: boolean;
  /** Validate + log writes without executing them. */
  dryRun: boolean;
  /** Cap on rows returned by read queries (defence against huge result sets). */
  maxRows: number;
  auditLog: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface GuardContext {
  tool: string;
  capability: Capability;
  database?: string;
  destructive?: boolean;
}

export class SecurityPolicy {
  constructor(private readonly config: SecurityConfig) {}

  get mode(): AccessMode {
    return this.config.mode;
  }
  get maxRows(): number {
    return this.config.maxRows;
  }

  isCapabilityEnabled(capability: Capability): boolean {
    return CAPABILITY_RANK[capability] <= MODE_RANK[this.config.mode];
  }

  isDatabaseAllowed(db: string): boolean {
    if (this.config.databaseAllowlist.length === 0) return true;
    return this.config.databaseAllowlist.includes(db);
  }

  isDatabaseProtected(db: string): boolean {
    return this.config.protectedDatabases.includes(db);
  }

  get protectedDatabases(): string[] {
    return this.config.protectedDatabases;
  }

  guard(ctx: GuardContext): { dryRun: boolean } {
    if (!this.isCapabilityEnabled(ctx.capability)) {
      this.audit(ctx, "DENY", `capability '${ctx.capability}' exceeds mode '${this.config.mode}'`);
      throw new PolicyError(
        `Operation '${ctx.tool}' requires '${ctx.capability}' access but the server runs in '${this.config.mode}' mode.`,
      );
    }

    if (ctx.database !== undefined) {
      if (!this.isDatabaseAllowed(ctx.database)) {
        this.audit(ctx, "DENY", `database '${ctx.database}' not in allowlist`);
        throw new PolicyError(
          `Database '${ctx.database}' is not in the configured allowlist (CLICKHOUSE_DATABASE_ALLOWLIST).`,
        );
      }
      if (ctx.capability !== "read" && this.isDatabaseProtected(ctx.database)) {
        this.audit(ctx, "DENY", `database '${ctx.database}' is protected`);
        throw new PolicyError(
          `Database '${ctx.database}' is protected (CLICKHOUSE_PROTECTED_DATABASES); mutations are refused.`,
        );
      }
    }

    if (ctx.destructive && !this.config.allowDelete) {
      this.audit(ctx, "DENY", "delete not enabled");
      throw new PolicyError(
        `Destructive operation '${ctx.tool}' is disabled. Set CLICKHOUSE_ALLOW_DELETE=true to enable it.`,
      );
    }

    const dryRun = ctx.capability !== "read" && this.config.dryRun;
    this.audit(ctx, dryRun ? "DRY_RUN" : "ALLOW");
    return { dryRun };
  }

  private audit(ctx: GuardContext, decision: string, reason?: string): void {
    if (!this.config.auditLog) return;
    const line = {
      ts: new Date().toISOString(),
      audit: "clickhouse-mcp",
      decision,
      tool: ctx.tool,
      capability: ctx.capability,
      database: ctx.database ?? null,
      destructive: ctx.destructive ?? false,
      ...(reason ? { reason } : {}),
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  }
}
