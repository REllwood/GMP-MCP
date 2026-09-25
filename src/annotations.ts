import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// Tools with additive side effects that skip the dry-run pipeline: starting a report run, or writing a
// downloaded report to the local download directory.
export const unguardedSideEffectTools: ReadonlySet<string> = new Set([
  "cm360_run_report",
  "cm360_download_report_file",
  "bidmanager_download_report"
]);

// Every write tool takes a dryRun flag, so its presence is what marks a tool as a write. Clients use
// these hints to decide which calls need the user's approval.
export function toolAnnotations(name: string, inputSchema: unknown): ToolAnnotations {
  if (hasInputField(inputSchema, "dryRun")) {
    return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  }

  if (unguardedSideEffectTools.has(name)) {
    return { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  }

  return { readOnlyHint: true, openWorldHint: true };
}

export function withToolAnnotations(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        return Reflect.get(target, property, receiver);
      }

      return (
        name: string,
        config: { inputSchema?: unknown; annotations?: ToolAnnotations },
        callback: unknown
      ) =>
        (target.registerTool as (...args: unknown[]) => unknown)(
          name,
          { ...config, annotations: { ...toolAnnotations(name, config.inputSchema), ...config.annotations } },
          callback
        );
    }
  });
}

function hasInputField(schema: unknown, field: string): boolean {
  const shape = (schema as { shape?: unknown } | undefined)?.shape;
  return typeof shape === "object" && shape !== null && field in shape;
}
