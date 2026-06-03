/**
 * Concordia API client. dev/prod とも同 origin を想定 (vite proxy).
 */

const BASE = "";

/**
 * 起動可能な AI provider 一覧. backend `src/control/spawner.ts` の
 * SpawnProvider と 1:1 で合わせる. 新 provider を足すときは backend と
 * Lictor の `src/provider.ts` を同時更新する.
 */
export type SpawnProvider = "claude" | "codex" | "gemini";

export interface SessionRow {
  id: string;
  provider: string;
  repo_path: string;
  repo_origin: string | null;
  branch: string | null;
  host: string;
  started_at: number;
  ended_at: number | null;
  status: "active" | "ended" | "lost" | "abandoned";
  last_seen_at: number;
  current_task: string | null;
  metadata: Record<string, any> | null;
}

export interface SessionEvent {
  id: number;
  ts: number;
  kind: string;
  payload: any;
}

export interface ChatMessage {
  id: number;
  channel: "chitchat" | "consultation" | "system" | "報告";
  session_id: string | null;
  author_label: string;
  ts: number;
  text: string;
  in_reply_to: number | null;
  is_actionable: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface MonitorPayload {
  active: SessionRow[];
  lost: SessionRow[];
  recent_ended: SessionRow[];
  repos: Array<{ key: string; count: number }>;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return (await r.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return (await r.json()) as T;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return (await r.json()) as T;
}

type FieldSource = "db" | "env" | "none" | "default";

export interface SlackConfigStatus {
  enabled: boolean;
  channel_id: string | null;
  bot_token_set: boolean;
  app_token_set: boolean;
  source: {
    enabled: FieldSource;
    channel_id: FieldSource;
    bot_token: FieldSource;
    app_token: FieldSource;
  };
}

export interface SlackBotActionResult {
  ok: boolean;
  status: string;
  error?: string;
}

export interface SkillSnapshot {
  id: number;
  repo_origin: string | null;
  repo_path: string;
  skill_name: string;
  ts: number;
  content_hash: string;
  size_bytes: number;
  line_count: number;
  section_count: number;
  source: string;
  poison_score: number;
  poison_reasons: string[];
  growth_score: number;
  growth_notes: string[];
  content_preview: string;
}

export interface ReportSummary {
  session_id: string;
  generated_at: number;
  duration_sec: number;
  bullets: any;
  summary_preview: string;
}

export interface PrItem {
  id: number;
  repo_origin: string;
  number: number;
  title: string;
  url: string | null;
  state: "draft" | "open" | "merged" | "closed";
  ci_status: "unknown" | "pending" | "success" | "failure";
  review_state: "none" | "needs_review" | "reviewing" | "approved" | "changes_requested";
  author_session_id: string | null;
  persona_name: string | null;
  additions: number | null;
  deletions: number | null;
  updated_at: number;
}

export interface PrQueueResult {
  generated_at: number;
  counts: {
    ready: number;
    needs_review: number;
    in_progress: number;
    merged_recent: number;
    total_active: number;
  };
  grouped: {
    ready: PrItem[];
    needs_review: PrItem[];
    in_progress: PrItem[];
    merged_recent: PrItem[];
  };
  queue: PrItem[];
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  traits: string[];
  speech_style: string;
  skill_template: string;
  learned_notes: string[];
  created_at: number;
  updated_at: number;
  is_active?: boolean;
}

export interface PersonaActiveItem {
  assignment_id: number;
  session_id: string;
  assigned_at: number;
  persona: Persona;
}

export interface PersonaFeedback {
  id: number;
  persona_id: string;
  session_id: string | null;
  ts: number;
  kind: "session-end" | "chat-update" | "manual" | "system";
  delta: string;
  detail: any;
}

export const api = {
  health: () => get<{ ok: boolean; service: string; version: string }>("/health"),
  monitor: () => get<MonitorPayload>("/v1/monitor"),
  session: (id: string) =>
    get<{ session: SessionRow; events: SessionEvent[] }>(`/v1/sessions/${encodeURIComponent(id)}`),
  sessionInject: (id: string, text: string, source?: string) =>
    post<{ ok: boolean; ts: number }>(`/v1/sessions/${encodeURIComponent(id)}/inject`, {
      text,
      ...(source ? { source } : {}),
    }),
  sessionFork: (id: string, body: { claude_uuid: string; cwd?: string; mode?: "tab" | "window" }) =>
    post<{ ok: boolean; pid: number | null; command: string[] }>(
      `/v1/sessions/${encodeURIComponent(id)}/fork`,
      body,
    ),
  machinesList: () =>
    get<{
      machines: Array<{
        host: string;
        active: number;
        lost: number;
        ended: number;
        abandoned: number;
        last_seen_at: number;
      }>;
    }>("/v1/machines"),
  adminSpawn: (body: { provider: SpawnProvider; cwd?: string; title?: string; mode?: "tab" | "window" }) =>
    post<{ ok: boolean; pid: number | null; command: string[] }>("/v1/admin/spawn-session", body),
  adminSpawnDefaults: () =>
    get<{ default_cwd: string; platform_supported: boolean }>("/v1/admin/spawn-defaults"),
  adminStop: (id: string) =>
    post<{ ok: boolean; pid: number }>(`/v1/admin/stop-session/${encodeURIComponent(id)}`, {}),
  discordBotStart: () =>
    post<{ ok: boolean; status: string; error?: string }>("/v1/admin/discord/start", {}),
  discordBotStop: () =>
    post<{ ok: boolean; status: string; error?: string }>("/v1/admin/discord/stop", {}),
  discordBotRestart: () =>
    post<{ ok: boolean; status: string; error?: string }>("/v1/admin/discord/restart", {}),
  slackConfigGet: () => get<SlackConfigStatus>("/v1/admin/slack/config"),
  slackConfigSet: (body: {
    enabled?: boolean;
    channel_id?: string | null;
    bot_token?: string | null;
    app_token?: string | null;
  }) =>
    put<{ ok: boolean; status: SlackConfigStatus; restart: SlackBotActionResult }>(
      "/v1/admin/slack/config",
      body,
    ),
  slackBotStart: () => post<SlackBotActionResult>("/v1/admin/slack/start", {}),
  slackBotStop: () => post<SlackBotActionResult>("/v1/admin/slack/stop", {}),
  slackBotRestart: () => post<SlackBotActionResult>("/v1/admin/slack/restart", {}),
  sessionRequestStat: (id: string) =>
    post<{ ok: boolean; enqueued: boolean; reason?: string }>(
      `/v1/sessions/${encodeURIComponent(id)}/request-stat`,
      {},
    ),
  sessionRequestTitle: (id: string) =>
    post<{ ok: boolean; enqueued: boolean; reason?: string }>(
      `/v1/sessions/${encodeURIComponent(id)}/request-title`,
      {},
    ),
  permissionRespond: (id: string, body: { request_id: string; decision: "allow" | "deny" | "ask"; reason?: string }) =>
    post<{ ok: boolean }>(`/v1/sessions/${encodeURIComponent(id)}/permission-response`, body),
  fsList: (id: string, path: string) => {
    const qs = new URLSearchParams({ path }).toString();
    return get<{ path: string; entries: Array<{ name: string; is_dir: boolean; size: number | null }>; truncated: boolean }>(
      `/v1/sessions/${encodeURIComponent(id)}/fs/list?${qs}`,
    );
  },
  fsRead: (id: string, path: string) => {
    const qs = new URLSearchParams({ path }).toString();
    return get<{ path: string; bytes: number; truncated: boolean; content: string }>(
      `/v1/sessions/${encodeURIComponent(id)}/fs/read?${qs}`,
    );
  },
  sessionTranscript: (id: string, opts: { since_id?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.since_id !== undefined) qs.set("since_id", String(opts.since_id));
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const tail = qs.toString();
    return get<{
      session_id: string;
      total: number;
      entries: Array<{ id: number; seq: number; ts: number; kind: string; payload: unknown }>;
      next_since_id: number;
    }>(`/v1/sessions/${encodeURIComponent(id)}/transcript${tail ? `?${tail}` : ""}`);
  },
  workConversations: (opts: {
    repo_path?: string;
    repo_origin?: string;
    status?: "active" | "ended" | "lost" | "abandoned";
    limit_per_session?: number;
    max_sessions?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    if (opts.repo_path) qs.set("repo_path", opts.repo_path);
    if (opts.repo_origin) qs.set("repo_origin", opts.repo_origin);
    if (opts.status) qs.set("status", opts.status);
    if (opts.limit_per_session !== undefined) qs.set("limit_per_session", String(opts.limit_per_session));
    if (opts.max_sessions !== undefined) qs.set("max_sessions", String(opts.max_sessions));
    const tail = qs.toString();
    return get<{
      filter: { repo_path: string | null; repo_origin: string | null; status: string | null };
      available_repos: Array<{ repo_path: string; repo_origin: string | null; session_count: number }>;
      sessions: Array<{
        session: SessionRow;
        conversation: Array<{ id: number; seq: number; ts: number; kind: string; payload: unknown }>;
      }>;
    }>(`/v1/work/conversations${tail ? `?${tail}` : ""}`);
  },
  chatList: (channel?: string, limit = 50) =>
    get<{ messages: ChatMessage[] }>(
      `/v1/chat${channel ? `?channel=${channel}&limit=${limit}` : `?limit=${limit}`}`,
    ),
  chatPost: (body: {
    channel: string;
    text: string;
    author_label: string;
    in_reply_to?: number | null;
    session_id?: string | null;
    scope?: "world" | "local";
  }) =>
    post<{ message: ChatMessage }>("/v1/chat", { session_id: null, ...body }),
  prsQueue: (repo?: string, author?: string) => {
    const q = new URLSearchParams();
    if (repo) q.set("repo", repo);
    if (author) q.set("author", author);
    const tail = q.toString();
    return get<PrQueueResult>(`/v1/prs${tail ? `?${tail}` : ""}`);
  },
  reportsList: (limit = 30) => get<{ reports: ReportSummary[] }>(`/v1/reports?limit=${limit}`),
  skillsList: () => get<{ skills: SkillSnapshot[] }>("/v1/skills"),
  skillsHistory: (repo_path: string, skill_name = "concordia") =>
    get<{ history: SkillSnapshot[] }>(
      `/v1/skills/history?repo_path=${encodeURIComponent(repo_path)}&skill_name=${encodeURIComponent(skill_name)}`,
    ),
  report: (id: string) =>
    get<{ session_id: string; summary_md: string; bullets: any; duration_sec: number }>(
      `/v1/reports/${encodeURIComponent(id)}`,
    ),
  personasList: () => get<{ personas: Persona[] }>("/v1/personas"),
  personasActive: () => get<{ active: PersonaActiveItem[] }>("/v1/personas/active"),
  personaDetail: (id: string) =>
    get<{ persona: Persona; feedback: PersonaFeedback[]; assignments: Array<{ id: number; session_id: string; assigned_at: number; released_at: number | null }> }>(
      `/v1/personas/${encodeURIComponent(id)}`,
    ),
  personasFeedbackRecent: (limit = 50) =>
    get<{ feedback: PersonaFeedback[] }>(`/v1/personas/feedback/recent?limit=${limit}`),
  statList: () =>
    get<{
      items: Array<{
        session_id: string;
        latest_ts: number;
        payload: Record<string, unknown>;
        session: SessionRow | null;
      }>;
    }>("/v1/stat"),
  statBySession: (id: string) =>
    get<{
      session: SessionRow;
      latest: { id: number; ts: number; payload: Record<string, unknown> } | null;
      history: Array<{ id: number; ts: number; payload: Record<string, unknown> }>;
    }>(`/v1/stat/${encodeURIComponent(id)}`),
  conflicts: (params: { repo: string; branch?: string; exclude_session?: string }) => {
    const q = new URLSearchParams({ repo: params.repo });
    if (params.branch) q.set("branch", params.branch);
    if (params.exclude_session) q.set("exclude_session", params.exclude_session);
    return get<{
      repo: string;
      branch: string | null;
      conflicts: SessionRow[];
      branches: Array<{ branch: string; count: number }>;
    }>(`/v1/monitor/conflicts?${q.toString()}`);
  },
};

export function fmtTs(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString("ja-JP", { hour12: false });
}

export function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h ? `${h}h` : ""}${m}m${s}s`;
}

export function statusBadge(status: SessionRow["status"]): string {
  switch (status) {
    case "active":    return "bg-ok/20 text-ok";
    case "lost":      return "bg-warn/20 text-warn";
    case "abandoned": return "bg-danger/20 text-danger";
    case "ended":     return "bg-subtle/20 text-subtle";
  }
}
