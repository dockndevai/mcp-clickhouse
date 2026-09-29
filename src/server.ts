import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CHClient } from "./clickhouse/client.js";
import type { AppConfig } from "./config.js";
import { makeConfirmer } from "./elicit.js";
import { GuardClient, loadGuardConfig } from "./guard.js";
import { PolicyError, SecurityPolicy } from "./security.js";
import { annotationsFor } from "./tools/annotations.js";
import { readTools } from "./tools/read.js";
import type { ToolContext, ToolDef } from "./tools/types.js";
import { writeTools } from "./tools/execute.js";

export const ALL_TOOLS: ToolDef[] = [...readTools, ...writeTools];

export function buildServer(config: AppConfig): {
  server: McpServer;
  enabled: string[];
  client: CHClient;
} {
  const policy = new SecurityPolicy(config.security);
  const client = new CHClient(config.connection);
  const server = new McpServer({ name: "mcp-clickhouse", version: "0.3.0" });
  const guard = new GuardClient(loadGuardConfig());
  const ctx: ToolContext = { client, policy, confirm: makeConfirmer(server), guard };

  const enabled: string[] = [];
  for (const tool of ALL_TOOLS) {
    if (!policy.isCapabilityEnabled(tool.capability)) continue;
    enabled.push(tool.name);
    server.registerTool(tool.name, { ...tool.config, annotations: annotationsFor(tool) }, async (args: Record<string, unknown>) => {
      try {
        // laya-guard: assess every mutating op before it runs (no-op unless *_GUARD_MODE is set).
        if (tool.capability !== "read") {
          await guard.enforce({ tool: tool.name, command: `${tool.name} ${JSON.stringify(args ?? {})}`, context: tool.name }, ctx.confirm);
        }
        return await tool.handler(args ?? {}, ctx);
      } catch (err) {
        return toErrorResult(err);
      }
    });
  }

  return { server, enabled, client };
}

function toErrorResult(err: unknown) {
  let message: string;
  if (err instanceof PolicyError) {
    message = `Policy denied: ${err.message}`;
  } else if (err instanceof Error) {
    message = `${err.name}: ${err.message}`;
  } else {
    message = String(err);
  }
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
