import { describe, expect, it } from "vitest";
import { PolicyError, SecurityPolicy, type SecurityConfig } from "../src/security.js";

function makePolicy(overrides: Partial<SecurityConfig> = {}): SecurityPolicy {
  return new SecurityPolicy({
    mode: "read-only",
    databaseAllowlist: [],
    protectedDatabases: ["system"],
    allowDelete: false,
    dryRun: false,
    maxRows: 1000,
    auditLog: false,
    requireHumanApproval: false,
    ...overrides,
  });
}

describe("capability gating", () => {
  it("read-only enables read only", () => {
    const p = makePolicy();
    expect(p.isCapabilityEnabled("read")).toBe(true);
    expect(p.isCapabilityEnabled("write")).toBe(false);
    expect(p.isCapabilityEnabled("admin")).toBe(false);
  });
});

describe("statement-class vs mode", () => {
  it("rejects a write in read-only mode", () => {
    const p = makePolicy();
    expect(() => p.guard({ tool: "execute", capability: "write", database: "app" })).toThrow(PolicyError);
  });
  it("rejects a destructive statement in read-write mode", () => {
    const p = makePolicy({ mode: "read-write" });
    expect(() =>
      p.guard({ tool: "execute", capability: "admin", database: "app", destructive: true }),
    ).toThrow(/admin/);
  });
});

describe("database allowlist + protection", () => {
  it("blocks databases outside a non-empty allowlist", () => {
    const p = makePolicy({ mode: "read-write", databaseAllowlist: ["app"] });
    expect(() => p.guard({ tool: "list_tables", capability: "read", database: "secret" })).toThrow(
      /allowlist/,
    );
  });
  it("allows reading a protected database but not mutating it", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(() => p.guard({ tool: "query", capability: "read", database: "system" })).not.toThrow();
    expect(() =>
      p.guard({ tool: "execute", capability: "admin", database: "system", destructive: true }),
    ).toThrow(/protected/);
  });
});

describe("statement scope (databases named by the SQL)", () => {
  it("applies the allowlist to every database the statement names, not just `database`", () => {
    const p = makePolicy({ mode: "admin", databaseAllowlist: ["app"] });
    expect(() => p.guard({ tool: "execute", capability: "read", databases: ["app"] })).not.toThrow();
    expect(() => p.guard({ tool: "execute", capability: "read", database: "app", databases: ["app", "other"] })).toThrow(/other.*allowlist/);
  });
  it("fails closed on an unresolved scope only when an allowlist is configured", () => {
    const strict = makePolicy({ mode: "admin", databaseAllowlist: ["app"] });
    expect(() => strict.guard({ tool: "query", capability: "read", databases: [], scopeUnresolved: "remote()" })).toThrow(/cannot determine/);
    const open = makePolicy({ mode: "admin" });
    expect(() => open.guard({ tool: "query", capability: "read", databases: [], scopeUnresolved: "remote()" })).not.toThrow();
  });
  it("refuses mutations that touch a protected database (case-insensitively) but allows reads of it", () => {
    const p = makePolicy({ mode: "admin", protectedDatabases: ["INFORMATION_SCHEMA"] });
    expect(() => p.guard({ tool: "execute", capability: "write", databases: ["information_schema"] })).toThrow(/protected/);
    expect(() => p.guard({ tool: "query", capability: "read", databases: ["information_schema"] })).not.toThrow();
  });
  it("explains a refusal caused by the default database", () => {
    const p = makePolicy({ mode: "admin", databaseAllowlist: ["app"] });
    expect(() => p.guard({ tool: "query", capability: "read", databases: ["default"], defaultDatabase: "default" })).toThrow(/CLICKHOUSE_DATABASE/);
  });
});

describe("destructive gating", () => {
  it("blocks destructive without allowDelete", () => {
    const p = makePolicy({ mode: "admin" });
    expect(() =>
      p.guard({ tool: "execute", capability: "admin", database: "app", destructive: true }),
    ).toThrow(/ALLOW_DELETE/);
  });
  it("permits destructive with allowDelete", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(() =>
      p.guard({ tool: "execute", capability: "admin", database: "app", destructive: true }),
    ).not.toThrow();
  });
});

describe("dry run", () => {
  it("flags writes but not reads", () => {
    const p = makePolicy({ mode: "read-write", dryRun: true });
    expect(p.guard({ tool: "query", capability: "read" }).dryRun).toBe(false);
    expect(p.guard({ tool: "execute", capability: "write", database: "app" }).dryRun).toBe(true);
  });
});
