/**
 * 依頼窓口 (/desk) と管制 (/control) が読む API の型と呼び出し (Cc v5)。
 * 画面は表示だけを持ち、ここで fetch する。
 */

export interface DeskRequestView {
  id: string;
  request_key: string;
  origin: "web" | "discord";
  requester: string;
  provider: "claude" | "codex";
  body: string;
  state: "accepted" | "launching" | "launch_unknown" | "running" | "finished" | "launch_failed";
  session_id: string | null;
  project_code?: string | null;
  task_reference?: string | null;
  delegation_run_id?: string | null;
  child_session_id?: string | null;
  delivery?: "waiting" | "sending" | "sent" | "claimed" | null;
  routing_issue?: "project" | "launch" | "delivery" | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  open_cards: number;
  links: { discord: string | null; web: string } | null;
}

export interface ControlCardView {
  id: string;
  source_kind: string;
  card_kind: "human_action" | "human_judgment";
  summary: string;
  human_action: string | null;
  session_id: string | null;
  project: string | null;
  link: string | null;
  state: "open" | "closed" | "discarded";
  raised_at: number;
  closed_at: number | null;
  discarded_at?: number | null;
  discard_reason?: "session_inactive" | "session_unresolved" | null;
  priority: "high" | "normal" | "low";
  assignee: string | null;
  remind_at: number | null;
  reminder_text: string | null;
  card_group: string | null;
  triaged_by: string | null;
}

export interface PlanStep { text: string; status: "pending" | "in_progress" | "completed" }

export interface ControlCardList {
  cards: ControlCardView[];
  discarded_count?: number;
}

export interface AiWeeklyQuota {
  key: "chatgpt" | "claude" | "gemini" | "grok";
  provider: string;
  label: string;
  plan: string | null;
  usedWeeklyPct: number | null;
  remainWeeklyPct: number | null;
  resetWeeklyAt: number | null;
  sampledAt: number | null;
}

export interface SessionProgressRow {
  desk_request_id?: string | null;
  desk_task_reference?: string | null;
  gen5_stage?: string | null;
  session_id: string;
  project: string;
  branch: string | null;
  current_task: string | null;
  status: string | null;
  status_reason: string | null;
  last_activity_at: number | null;
  link?: string | null;
  plan: {
    steps: PlanStep[];
    desktop_plan_status: string | null;
    work_phase: { phase: string; label: string; design_summary: string };
  };
  progress: {
    steps_completed: number;
    steps_total: number;
    followup_rate: number | null;
    tasks: { state: "ok"; items: Array<{ reference: string; status: string; state: string }> } | { state: "unavailable" };
  };
}

export interface SprintView {
  dialogue_key: string;
  sprint_name: string;
  phase: string;
  held: boolean;
  closed: boolean;
  task_count: number;
  summary: string;
  actio_path: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    ...(init?.signal ? { signal: init.signal } : {}),
    ...(init?.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`, response.status);
  }
  return await response.json() as T;
}

/** 過去の雑務 (受付済みの run の読み取りと OK / Continue だけ。新規受付は依頼窓口へまとめた)。 */
export interface ChoreView {
  id: string; prompt: string; provider: "claude" | "codex"; status: string; cwd: string;
  output: string; error: string | null; spawn_id: string | null;
}

export const choresApi = {
  list: (signal?: AbortSignal) => call<{ runs: ChoreView[] }>("/v1/chores", { signal }),
  choose: (id: string, action: "ok" | "continue") => call<{ run: ChoreView }>(`/v1/chores/${encodeURIComponent(id)}/choice`, { method: "POST", body: { action } }),
};

export const controlApi = {
  latestQuotas: (signal?: AbortSignal) => call<{ providers: AiWeeklyQuota[] }>("/v1/cost/limits/latest", { signal }),
  deskRequests: (signal?: AbortSignal) => call<{ requests: DeskRequestView[] }>("/v1/desk/requests", { signal }),
  deskRequest: (id: string, signal?: AbortSignal) => call<{ request: DeskRequestView; gen5Stage: { label: string; messageId: number } | null; projects?: Array<{ code: string; name: string }>; cards: Array<Pick<ControlCardView, "id" | "card_kind" | "summary" | "state" | "priority">> }>(`/v1/desk/requests/${encodeURIComponent(id)}`, { signal }),
  selectDeskProject: (id: string, project: string) =>
    call(`/v1/desk/requests/${encodeURIComponent(id)}/project`, { method: "POST", body: { project } }),
  retryDeskLaunch: (id: string) =>
    call(`/v1/desk/requests/${encodeURIComponent(id)}/retry-launch`, { method: "POST" }),
  submitDesk: (input: { client_request_id: string; body: string; provider: "claude" | "codex"; project?: string }) =>
    call<{ request: DeskRequestView; existing: boolean }>("/v1/desk/requests", { method: "POST", body: input }),
  cards: (state: "open" | "closed" | "all" | "discarded", signal?: AbortSignal) => call<ControlCardList>(`/v1/control/cards?state=${state}`, { signal }),
  updateCard: (id: string, patch: Record<string, unknown>) => call<{ card: ControlCardView }>(`/v1/control/cards/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  sessions: (signal?: AbortSignal) => call<{ items: SessionProgressRow[] }>("/v1/control/sessions", { signal }),
  sprints: (signal?: AbortSignal) => call<{ sprints: SprintView[] }>("/v1/control/sprints", { signal }),
};
