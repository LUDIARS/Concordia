/** Capability declaration, not a claim that a caller has connected its MCP server. */
export const DEVELOPER_TOOLS = [
  { operation: "readiness", owner: "Cc", effect: "read", transport: "HTTP", preparation: "active session / registered checkout" },
  { operation: "tasks_list", owner: "Actio", effect: "read", transport: "HTTP", preparation: "Actio project binding and authenticated owner" },
  { operation: "task_create", owner: "Actio", effect: "write", transport: "HTTP", preparation: "task creation instruction / stable request UUID" },
  { operation: "task_get", owner: "Actio", effect: "read", transport: "HTTP", preparation: "scoped Actio reference" },
  { operation: "task_update", owner: "Actio", effect: "write", transport: "HTTP", preparation: "scoped Actio reference / update instruction" },
  { operation: "critical_path", owner: "Actio", effect: "read", transport: "HTTP", preparation: "task/team binding or an owner-and-Git-repository-matched PM project" },
  { operation: "specifications", owner: "Pf", effect: "read", transport: "HTTP", preparation: "Praeforma project with matching anatomiaRepo" },
  { operation: "implementation_context", owner: "Anatomia", effect: "read", transport: "HTTP", preparation: "registered repository / prepared analysis" },
  { operation: "impact_analysis", owner: "Anatomia", effect: "analysis", transport: "HTTP", preparation: "registered repository; deterministic plan, no LLM" },
  { operation: "tests_list", owner: "Augur", effect: "read", transport: "CLI", preparation: "Augur CLI / test registry" },
  { operation: "tests_run", owner: "Augur", effect: "execute", transport: "CLI", preparation: "registered bundle / approval reference / request UUID" },
  { operation: "test_result", owner: "Cc / Augur", effect: "read", transport: "HTTP", preparation: "same caller and request UUID" },
  { operation: "vulnerability_check", owner: "OSV", effect: "external-read", transport: "HTTPS", preparation: "npm package-lock v2/v3; package names and versions sent to OSV" },
] as const;

export function toolCatalog() {
  return { version: 1, location: "concordia-core MCP / Cc loopback HTTP",
    mcp_connection: "caller-specific; listed capability does not prove client installation",
    tools: DEVELOPER_TOOLS.map(tool => ({ ...tool, mcp: `concordia_${tool.operation}`,
      http: "POST /v1/developer-tools/execute", mcp_required: false })),
    existing: [
      { mcp: "concordia_tool_catalog", http: "GET /v1/developer-tools/catalog" },
      { mcp: "concordia_create_worktree", http: "POST /v1/implementation-tools/worktree" },
      { mcp: "concordia_switch_branch", http: "POST /v1/implementation-tools/switch" },
      { mcp: "concordia_bind_work", http: "POST /v1/implementation-tools/bind" },
      { mcp: "concordia_check_bash", http: "POST /v1/harness/gate", effect: "check only; never executes command" },
      { mcp: "concordia_commit_work", http: "POST /v1/implementation-tools/commit" },
      { mcp: "concordia_submit_work", http: "POST /v1/implementation-tools/submit" },
      { mcp: "concordia_control_service", http: "POST /v1/implementation-tools/service" },
      ...CORE_TOOLS.map(([mcp, http]) => ({ mcp, http })),
    ] };
}

const CORE_TOOLS = [
  ["concordia_list_sessions", "GET /v1/sessions"],
  ["concordia_get_session", "GET /v1/sessions/:id"],
  ["concordia_get_session_stat", "GET /v1/stat/:id"],
  ["concordia_list_all_stats", "GET /v1/stat"],
  ["concordia_pr_queue", "GET /v1/prs"],
  ["concordia_get_pending_tasks", "GET /v1/sessions/:id/pending-tasks"],
  ["concordia_get_conflicts", "GET /v1/monitor/conflicts"],
  ["concordia_post_chat", "POST /v1/chat (normally use own Lictor sidecar)"],
  ["concordia_recent_chat", "GET /v1/chat"],
  ["concordia_list_session_logs", "GET /v1/session-logs"],
  ["concordia_get_session_log", "GET /v1/session-logs/:id"],
  ["concordia_context_packet", "GET /v1/sessions/:id/context"],
  ["concordia_harness_context", "POST /v1/harness/context"],
  ["concordia_harness_gate", "POST /v1/harness/gate"],
  ["concordia_harness_intent", "POST /v1/harness/intent"],
  ["concordia_harness_audit", "GET /v1/harness/audit"],
  ["concordia_get_settings", "GET /v1/admin/settings"],
  ["concordia_update_settings", "PUT /v1/admin/settings"],
  ["concordia_list_teams", "GET /v1/teams"],
  ["concordia_update_team", "PATCH /v1/teams/:id"],
] as const;
