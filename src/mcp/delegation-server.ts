/**
 * Delegation MCP server (stdio).
 *
 * 起動: `node dist/mcp/delegation-server.js`
 * .claude/mcp_servers.json (Claude) or codex の equivalent から:
 *   {
 *     "mcpServers": {
 *       "concordia-delegation": {
 *         "command": "node",
 *         "args": ["E:/Document/Ars/Concordia/dist/mcp/delegation-server.js"],
 *         "env": {
 *           "CONCORDIA_BASE_URL": "http://127.0.0.1:11111"
 *         }
 *       }
 *     }
 *   }
 *
 * 3 tools:
 *   - delegation_list_templates
 *   - delegation_invoke
 *   - bounty_triage_result (バグ報告の仕分けの結果を返す、 spec/feature/bug-bounty.md §5)
 *
 * Concordia HTTP loopback を直接叩く構造。 DB に直触りしない (Concordia が
 * running していなければ動かない、 でも spawn の責任分界が明確になる).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDelegationParentSessionId } from "./delegation-parent-session.js";
import { concordiaBaseUrl } from "../config/service-urls.js";
import { registerCloudWorkTools } from "./cloud-work-tools.js";

async function callConcordia(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `${concordiaBaseUrl()}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as text */ }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: `fetch failed: ${(err as Error).message}` },
    };
  }
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "concordia-delegation", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "delegation_list_templates",
    {
      description:
        "List active delegation templates registered in Concordia. Each template has a call_name (used to invoke), target_provider (codex-sdk / claude / gemini / gemma4-12), title, description, and input_schema.",
      inputSchema: {
        include_inactive: z.boolean().optional().describe("Also return inactive templates"),
      },
    },
    async ({ include_inactive }) => {
      const path = include_inactive ? "/v1/delegation/templates/all" : "/v1/delegation/templates";
      const r = await callConcordia("GET", path);
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `concordia call failed (${r.status}): ${JSON.stringify(r.body)}` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }] };
    },
  );

  server.registerTool(
    "delegation_invoke",
    {
      description:
        "Invoke a registered delegation template. Concordia renders the prompt, writes it to a markdown file, and spawns the target agent (Codex / Claude / Gemini) in a new Windows Terminal window. Returns the spawn pid and the rendered prompt file path.",
      inputSchema: {
        call_name: z.string().describe("Template call_name, e.g. 'fix-bug'"),
        args: z.record(z.unknown()).optional().describe("Variable bindings for the template (object)"),
        cwd: z.string().optional().describe("Working directory for the spawned session"),
        branch: z.string().optional().describe("Git branch for the spawned session"),
        worktree: z.boolean().optional().describe("When branch is set, defaults to true: use a linked worktree"),
        triggered_by: z.string().optional().describe("Who is initiating (free-form identifier)"),
        memory_links: z.array(z.string().max(500)).max(20).optional().describe("Reference paths/URLs to list in the prompt without inlining"),
        parent_session_id: z.string().optional().describe("Parent Concordia session id, when the caller is a session"),
        options: z.record(z.unknown()).optional().describe("Provider-specific one-shot options, e.g. {\"model_reasoning_effort\":\"high\"} for Codex"),
        overrides: z.object({
          model: z.string().nullable().optional(),
          // 正本は src/db/delegation-repo.ts の DELEGATION_PROVIDERS。 この server は
          // DB モジュールを読み込まない独立プロセスなのでリテラルで同期する。
          provider: z.enum(["claude", "codex", "codex-sdk", "gemini", "gemma4-12"]).optional(),
          reasoning_effort: z.string().optional(),
        }).optional().describe("One-shot model/provider/reasoning overrides"),
        spawn: z.boolean().optional().describe("false で render + 記録のみ (no spawn)"),
        actio_team_id: z.string().trim().min(1).max(120).optional()
          .describe("Actio team for the implementation task; must be one of the project's registered teams. Omit for a team-less task"),
        taskflow_reference: z.string().regex(/^actio:[A-Za-z0-9-]+$/).optional()
          .describe("Actio task to continue (actio:<id>). Required when handing work over to a successor; the run is linked to this task instead of creating a new one"),
      },
    },
    async ({ call_name, args, cwd, branch, worktree, triggered_by, memory_links, parent_session_id, spawn, options, overrides, actio_team_id, taskflow_reference }) => {
      const r = await callConcordia(
        "POST",
        "/v1/delegation/invoke",
        {
          call_name,
          args: args ?? {},
          cwd,
          branch,
          worktree,
          triggered_by,
          memory_links,
          parent_session_id: resolveDelegationParentSessionId(
            parent_session_id,
            process.env.CONCORDIA_SESSION_ID,
          ),
          spawn,
          options,
          overrides,
          actio_team_id,
          taskflow_reference,
        },
      );
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `concordia call failed (${r.status}): ${JSON.stringify(r.body)}` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }] };
    },
  );

  // バグ報告の仕分け (spec/feature/bug-bounty.md §5)。 仕分けの委託はシェルを持たないので、結果はこのツールで返す。
  // 受け付けるのは、その報告の仕分けとして Cc が起動したセッションだけ (Cc 側で run と session id を照合する)。
  server.registerTool(
    "bounty_triage_result",
    {
      description:
        "Return the triage result of one bug-bounty report to Concordia. Only the session Concordia launched to triage that report is accepted. Call it once.",
      inputSchema: {
        report_id: z.string().min(1).max(200).describe("Report id (br_...)"),
        verdict: z.enum(["accepted", "duplicate", "rejected", "needs_info"]),
        severity: z.enum(["s1", "s2", "s3", "s4"]).nullable().optional(),
        duplicate_of: z.string().max(200).nullable().optional().describe("Root report id, required for duplicate"),
        sensitive: z.boolean().optional(),
        self_inflicted: z.boolean().optional(),
        hotfix_eligible: z.boolean().optional(),
        project: z.string().max(64).nullable().optional().describe("Estimated project code when the report had none"),
        public_title: z.string().max(120).nullable().optional(),
        public_summary: z.string().max(1000).nullable().optional(),
        reason: z.string().min(1).max(1000),
      },
    },
    async ({ report_id, ...result }) => {
      const sessionId = process.env.CONCORDIA_SESSION_ID?.trim();
      if (!sessionId) {
        return { isError: true, content: [{ type: "text", text: "CONCORDIA_SESSION_ID is not set; this tool only works inside a Concordia session" }] };
      }
      const r = await callConcordia("POST", `/v1/bounty/reports/${encodeURIComponent(report_id)}/triage-result`, {
        session_id: sessionId,
        result,
      });
      if (!r.ok) {
        return { isError: true, content: [{ type: "text", text: `concordia rejected the triage result (${r.status}): ${JSON.stringify(r.body)}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(r.body) }] };
    },
  );

  registerCloudWorkTools(server, callConcordia, () => process.env.CONCORDIA_SESSION_ID);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[concordia-delegation-mcp] connected via stdio\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`[concordia-delegation-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
