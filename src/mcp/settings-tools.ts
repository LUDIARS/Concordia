import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface SettingsCallResult {
  ok: boolean;
  status: number;
  body: unknown;
}

type SettingsCall = (
  method: "GET" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
) => Promise<SettingsCallResult>;

/** HTTP owns validation, persistence and secret redaction; MCP only adapts the request. */
export function registerSettingsTools(server: McpServer, call: SettingsCall): void {
  const readAnnotations = { readOnlyHint: true, openWorldHint: false };
  const writeAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  const result = (response: SettingsCallResult) => ({
    ...(response.ok ? {} : { isError: true }),
    content: [{ type: "text" as const, text: JSON.stringify({
      status: response.status,
      body: response.body,
      ...(!response.ok && response.status === 0
        ? { guidance: "Request outcome is unknown for writes. Read the current state before retrying." }
        : {}),
    }, null, 2) }],
  });

  server.registerTool("concordia_get_settings", {
    description: "Read Cc settings, definitions and value sources. Secret values are redacted by the settings API. Read before updating; respect each setting's editability and activation requirements.",
    inputSchema: {},
    annotations: readAnnotations,
  }, async () => result(await call("GET", "/v1/admin/settings")));

  server.registerTool("concordia_update_settings", {
    description: "Update only the requested Cc setting keys through the existing settings API. Use keys and value types from concordia_get_settings. Null clears an override where supported. Requires a user request for these changes; does not restart services. On timeout read back before retrying.",
    inputSchema: {
      updates: z.record(z.unknown()).refine(value => Object.keys(value).length > 0,
        "updates must not be empty").describe("Setting key to value map; API validates all entries before writing."),
    },
    annotations: writeAnnotations,
  }, async ({ updates }) => result(await call("PUT", "/v1/admin/settings", { updates })));

  server.registerTool("concordia_list_teams", {
    description: "Read Cc teams and their repository lists/settings. Omit subsidiary_id for headquarters, or explicitly select a subsidiary. Use the returned team ID for updates.",
    inputSchema: { subsidiary_id: z.string().trim().min(1).max(120).optional() },
    annotations: readAnnotations,
  }, async ({ subsidiary_id }) => result(await call("GET",
    `/v1/teams${subsidiary_id ? `?subsidiary_id=${encodeURIComponent(subsidiary_id)}` : ""}`)));

  server.registerTool("concordia_update_team", {
    description: "Change explicitly requested team repositories/settings/rules via Cc. Read concordia_list_teams immediately before updating. repos replaces the entire list: preserve existing repositories when adding one. Pass canonical Git origin URLs, not project abbreviations. Omitted fields stay unchanged. Read back after writes; do not blindly retry a timeout.",
    inputSchema: {
      team_id: z.string().trim().min(1).max(120),
      repos: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
      settings: z.record(z.unknown()).optional().describe("Replaces the entire team settings object. Read the latest team and preserve unchanged keys. The teams API validates allowed keys and values."),
      rules_text: z.string().max(50_000).optional(),
    },
    annotations: writeAnnotations,
  }, async ({ team_id, repos, settings, rules_text }) => {
    if (repos === undefined && settings === undefined && rules_text === undefined) {
      return result({ ok: false, status: 400, body: { error: "empty_team_update" } });
    }
    return result(await call("PATCH", `/v1/teams/${encodeURIComponent(team_id)}`, {
      ...(repos !== undefined ? { repos } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(rules_text !== undefined ? { rules_text } : {}),
    }));
  });
}
