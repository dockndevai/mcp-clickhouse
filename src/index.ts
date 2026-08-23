#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`[clickhouse-mcp] Configuration error: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const { server, enabled, client } = buildServer(config);

  process.stderr.write(
    `[clickhouse-mcp] Starting in '${config.security.mode}' mode` +
      `${config.security.dryRun ? " (DRY RUN)" : ""}. ` +
      `${enabled.length} tools enabled: ${enabled.join(", ")}\n`,
  );

  const shutdown = async () => {
    await client.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[clickhouse-mcp] Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
