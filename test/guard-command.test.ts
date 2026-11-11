import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalArgs } from "../src/elicit.js";

describe("laya-guard command never carries raw secrets", () => {
  it("is built from the redacted canonical arguments, not JSON.stringify(args)", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(server).toContain("canonicalArgs(args ?? {})");
    expect(server).not.toMatch(/command:[^\n]*JSON\.stringify\(args/);
  });

  it("redacts secret-named arguments", () => {
    const cmd = canonicalArgs({ name: "c", config: { "database.password": "hunter2" }, password: "p", apiKey: "k" });
    expect(cmd).not.toMatch(/hunter2|"p"|"k"/);
  });
});
