/**
 * Concordia core coordination MCP server (stdio).
 *
 * 起動: `node dist/mcp/core-server.js`
 * 設定 (Claude Code .claude/mcp_servers.json / Codex equivalent):
 *   {
 *     "mcpServers": {
 *       "concordia-core": {
 *         "command": "node",
 *         "args": ["E:/Document/Ars/Concordia/dist/mcp/core-server.js"],
 *         "env": { "CONCORDIA_BASE_URL": "http://127.0.0.1:17330" }
 *       }
 *     }
 *   }
 *
 * 11 tools — Concordia の横断状態 (sessions / stat / prs / chat / conflicts /
 * pending-tasks / session-logs) を読み書きできる:
 *   - concordia_list_sessions
 *   - concordia_get_session
 *   - concordia_get_session_stat
 *   - concordia_list_all_stats
 *   - concordia_pr_queue
 *   - concordia_get_pending_tasks
 *   - concordia_get_conflicts
 *   - concordia_post_chat
 *   - concordia_recent_chat
 *   - concordia_list_session_logs
 *   - concordia_get_session_log
 *
 * Concordia HTTP loopback (default 127.0.0.1:17330) を直接叩く。 DB は触らない
 * (= Concordia が running していない場合は全 tool が失敗するが、 spawn の責任
 * 分界が delegation-server.ts と同じ形で明確になる)。
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DEFAULT_BASE = "http://127.0.0.1:17330";

interface CallResult {
  ok: boolean;
  status: number;
  body: unknown;
}

// Concordia backend が hang したとき MCP tool call も無限 block しないよう
// 10s で打ち切る. env CONCORDIA_MCP_FETCH_TIMEOUT_MS で上書き可.
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

function fetchTimeoutMs(): number {
  const raw = process.env.CONCORDIA_MCP_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_FETCH_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FETCH_TIMEOUT_MS;
}

export async function callConcordia(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<CallResult> {
  const base = process.env.CONCORDIA_BASE_URL ?? DEFAULT_BASE;
  const url = `${base.replace(/\/$/, "")}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(fetchTimeoutMs()),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as text */ }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    const e = err as Error;
    const reason = e.name === "TimeoutError" || e.name === "AbortError"
      ? `fetch timeout after ${fetchTimeoutMs()}ms`
      : `fetch failed: ${e.message}`;
    return {
      ok: false,
      status: 0,
      body: { error: reason },
    };
  }
}

function toToolResult(r: CallResult) {
  if (!r.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `concordia call failed (${r.status}): ${JSON.stringify(r.body)}` }],
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(r.body, null, 2) }] };
}

/**
 * Build the MCP server with all 8 tools registered. Exported so tests can
 * instantiate it without going through stdio (the main() entry below is what
 * the CLI command launches).
 */
export function buildCoreServer(): McpServer {
  const server = new McpServer(
    { name: "concordia-core", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "concordia_list_sessions",
    {
      description:
        "List Concordia sessions, optionally filtered by status / provider / repo_origin / host. Returns serialized session rows including session_id, status, repo_path, branch, current_task, persona, started_at, last_seen_at.",
      inputSchema: {
        status: z.enum(["active", "lost", "ended"]).optional().describe("Filter by lifecycle status"),
        provider: z.enum(["claude-code", "gemini-cli", "codex-cli", "local-llm", "unknown"]).optional(),
        repo_origin: z.string().optional().describe("Match against sessions.repo_origin (canonical remote URL)"),
        host: z.string().optional().describe("Hostname filter"),
      },
    },
    async ({ status, provider, repo_origin, host }) => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (provider) params.set("provider", provider);
      if (repo_origin) params.set("repo_origin", repo_origin);
      if (host) params.set("host", host);
      const qs = params.toString();
      return toToolResult(await callConcordia("GET", `/v1/sessions${qs ? `?${qs}` : ""}`));
    },
  );

  server.registerTool(
    "concordia_get_session",
    {
      description:
        "Return a single session's detail: session row, current persona, and up to 200 most recent session_events. Use this when you need to read another session's recent activity (tool uses, file edits, prompts).",
      inputSchema: {
        session_id: z.string().describe("The session id, e.g. 'lictor-<uuid>' or a claude session id"),
      },
    },
    async ({ session_id }) => {
      return toToolResult(await callConcordia("GET", `/v1/sessions/${encodeURIComponent(session_id)}`));
    },
  );

  server.registerTool(
    "concordia_get_session_stat",
    {
      description:
        "Return a session's latest stat snapshot plus up to 50 historical stats. Stat payload contains the session's self-reported active_repos / open_prs / unmerged_branches / todos_summary / recent_work / note (whatever the AI chose to emit).",
      inputSchema: {
        session_id: z.string(),
      },
    },
    async ({ session_id }) => {
      return toToolResult(await callConcordia("GET", `/v1/stat/${encodeURIComponent(session_id)}`));
    },
  );

  server.registerTool(
    "concordia_list_all_stats",
    {
      description:
        "Cross-team flat view: latest stat per active session. Use this as the entry point when you want to know what every running session is currently doing (without specifying session ids).",
      inputSchema: {},
    },
    async () => {
      return toToolResult(await callConcordia("GET", "/v1/stat"));
    },
  );

  server.registerTool(
    "concordia_pr_queue",
    {
      description:
        "Cross-team PR queue: the PRs each session created, ordered by what needs attention (✅ ready-to-merge → 🛠 in-progress → 🔍 needs-review), plus recently merged. Use this to see 'what PRs are waiting' across all sessions. Filter by repo (repo_origin like 'LUDIARS/Concordia') or author (session_id). Returns { generated_at, counts, grouped, queue }.",
      inputSchema: {
        repo: z.string().optional().describe("repo_origin filter, e.g. 'LUDIARS/Concordia'"),
        author: z.string().optional().describe("author session_id filter"),
      },
    },
    async ({ repo, author }) => {
      const params = new URLSearchParams();
      if (repo) params.set("repo", repo);
      if (author) params.set("author", author);
      const qs = params.toString();
      return toToolResult(await callConcordia("GET", `/v1/prs${qs ? `?${qs}` : ""}`));
    },
  );

  server.registerTool(
    "concordia_get_pending_tasks",
    {
      description:
        "Return Concordia tasks that have been queued for this session but not yet delivered. These are the items the dispatcher would otherwise inject through hooks (peer-log reactions, chitchat suggestions, etc.).",
      inputSchema: {
        session_id: z.string(),
      },
    },
    async ({ session_id }) => {
      return toToolResult(await callConcordia("GET", `/v1/sessions/${encodeURIComponent(session_id)}/pending-tasks`));
    },
  );

  server.registerTool(
    "concordia_get_conflicts",
    {
      description:
        "Check whether other active sessions are touching the given (repo, branch). Call this before `git checkout -b` for substantive work. Returns conflicts[] (strict repo+branch match) and branches[] (any active session in the repo, grouped by branch).",
      inputSchema: {
        repo: z.string().describe("repo_path or repo_origin"),
        branch: z.string().optional().describe("Branch name; omit to treat as null (= match sessions with null branch)"),
        exclude_session: z.string().optional().describe("session_id to exclude (typically the caller's own session id)"),
      },
    },
    async ({ repo, branch, exclude_session }) => {
      const params = new URLSearchParams();
      params.set("repo", repo);
      if (branch) params.set("branch", branch);
      if (exclude_session) params.set("exclude_session", exclude_session);
      return toToolResult(await callConcordia("GET", `/v1/monitor/conflicts?${params.toString()}`));
    },
  );

  server.registerTool(
    "concordia_post_chat",
    {
      description:
        "Post a chat message to a Concordia channel. Channels: 'chitchat' (peer-to-peer banter), 'consultation' (asking for help / waiting on user), '報告' (status reports), 'system' (automation). Provide a meaningful author_label (e.g. '<役割> / <人物名>').",
      inputSchema: {
        channel: z.enum(["chitchat", "consultation", "報告", "system"]),
        text: z.string().min(1).max(2000),
        author_label: z.string().min(1).max(64),
        session_id: z.string().optional().describe("Caller's session id (so the message is attributed). Optional."),
        in_reply_to: z.number().int().positive().optional().describe("Reply to an existing chat message id"),
        scope: z.enum(["world", "local"]).optional().describe("'world' (default) = visible to all; 'local' = nearby only"),
      },
    },
    async (args) => {
      const body: Record<string, unknown> = {
        channel: args.channel,
        text: args.text,
        author_label: args.author_label,
      };
      if (args.session_id) body.session_id = args.session_id;
      if (args.in_reply_to) body.in_reply_to = args.in_reply_to;
      if (args.scope) body.scope = args.scope;
      return toToolResult(await callConcordia("POST", "/v1/chat", body));
    },
  );

  server.registerTool(
    "concordia_recent_chat",
    {
      description:
        "Read recent chat messages, optionally filtered by channel and time. Default limit 50, max 200. Use this to catch up on what peer sessions are saying before posting your own message.",
      inputSchema: {
        channel: z.enum(["chitchat", "consultation", "報告", "system"]).optional(),
        since_ts: z.number().int().optional().describe("Epoch seconds — only return messages newer than this"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ channel, since_ts, limit }) => {
      const params = new URLSearchParams();
      if (channel) params.set("channel", channel);
      if (typeof since_ts === "number") params.set("since", String(since_ts));
      if (typeof limit === "number") params.set("limit", String(limit));
      const qs = params.toString();
      return toToolResult(await callConcordia("GET", `/v1/chat${qs ? `?${qs}` : ""}`));
    },
  );

  server.registerTool(
    "concordia_list_session_logs",
    {
      description:
        "List past work session-logs (the hand-written `session-logs/<date>.md` records produced at /session-end and handoff). Each entry is one session document with extracted project tags, an outline (## headings) and an excerpt. Use this FIRST when picking up work — filter by project to find prior context, then call concordia_get_session_log to read the full doc. Returns { root, total, total_matched, projects:[{name,count}], entries:[{id,date,title,projects,sections,excerpt,...}] }.",
      inputSchema: {
        project: z.string().optional().describe("Filter to logs touching this project (canonical name, e.g. 'Anatomia', 'KuzuSurvivors', 'Concordia')"),
        q: z.string().optional().describe("Case-insensitive substring filter over title / outline / excerpt"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max entries (default 200, newest first)"),
      },
    },
    async ({ project, q, limit }) => {
      const params = new URLSearchParams();
      if (project) params.set("project", project);
      if (q) params.set("q", q);
      if (typeof limit === "number") params.set("limit", String(limit));
      const qs = params.toString();
      return toToolResult(await callConcordia("GET", `/v1/session-logs${qs ? `?${qs}` : ""}`));
    },
  );

  server.registerTool(
    "concordia_get_session_log",
    {
      description:
        "Return the full markdown body of one session-log by id (the filename without .md, e.g. '2026-06-22' or '2026-06-26-2'). Use this after concordia_list_session_logs to load prior work context when handing off / resuming a task. Returns { id, date, title, projects, sections, content_md, ... }.",
      inputSchema: {
        id: z.string().describe("session-log id = filename without .md (e.g. '2026-06-22')"),
      },
    },
    async ({ id }) => {
      return toToolResult(await callConcordia("GET", `/v1/session-logs/${encodeURIComponent(id)}`));
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildCoreServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[concordia-core-mcp] connected via stdio\n");
}

const isEntrypoint = (() => {
  const argv1 = process.argv[1] ?? "";
  if (!argv1) return false;
  const norm = argv1.replace(/\\/g, "/");
  return import.meta.url.endsWith(norm) || import.meta.url === `file:///${norm}`;
})();

if (isEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(`[concordia-core-mcp] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
