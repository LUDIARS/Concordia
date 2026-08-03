/**
 * Concordia API client. dev/prod とも同 origin を想定 (vite proxy).
 */

const BASE = "";

/**
 * delegation の target_provider (論理プリセット) 一覧. backend
 * `src/db/delegation-repo.ts` の DelegationProvider と合わせる.
 * gemma4-12 = ローカル LLM レーン (旧名 gamma。 内部は codex CLI を Ollama 経由で起動。
 * 実 spawn CLI への解決は backend `src/control/provider-preset.ts`)。 新規追加時は backend を同時更新する.
 */
export type SpawnProvider = "claude" | "codex" | "codex-sdk" | "gemini" | "gemma4-12";

export interface DelegationInputSchemaItem {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}

export interface DelegationOptionChoice {
  label: string;
  value: string;
  description?: string;
}

export interface DelegationOptionSuggestion {
  key: string;
  label: string;
  type: "select" | "string" | "boolean" | "number";
  description?: string;
  choices?: DelegationOptionChoice[];
}

/** Monitor の spawn フォームが使う delegation テンプレ (GET /v1/delegation/templates)。 */
export interface DelegationTemplateLite {
  id: string;
  call_name: string;
  title: string;
  description: string;
  target_provider: SpawnProvider;
  model: string | null;
  default_cwd: string | null;
  project: string | null;
  input_schema: DelegationInputSchemaItem[];
  is_active: boolean;
  emoji: string;
  call_only: boolean;
  sort_order: number;
  default_options?: Record<string, unknown>;
  runtime_options?: DelegationOptionSuggestion[];
}

/** delegation テンプレ / spawn が選べるモデル候補 (GET /v1/model-catalog)。 */
export type ModelCatalogProvider = "any" | "claude" | "codex" | "gemini" | "gemma4-12";
export interface ModelCatalogItem {
  id: string;
  model_id: string;
  label: string;
  provider: ModelCatalogProvider;
  sort_order: number;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  provider: string;
  repo_path: string;
  repo_origin: string | null;
  target_project?: string | null;
  branch: string | null;
  host: string;
  started_at: number;
  ended_at: number | null;
  status: "active" | "ended" | "lost" | "abandoned";
  last_seen_at: number;
  current_task: string | null;
  metadata: Record<string, any> | null;
  sufficiency?: ProjectSufficiency;
}

export interface ProjectSufficiency {
  project: string;
  anatomia: {
    present: boolean;
    functions?: number;
    domains?: number;
    links?: number;
  };
  thaleia: {
    present: boolean;
    generatedAt?: string;
    specs?: number;
    implementedSpecs?: number;
    gapCount?: number;
  };
}

export interface SessionEvent {
  id: number;
  ts: number;
  kind: string;
  payload: any;
}

export interface MonitorPayload {
  active: SessionRow[];
  lost: SessionRow[];
  recent_ended: SessionRow[];
  repos: Array<{ key: string; count: number }>;
}

export type TaskflowTaskStatus = "pending" | "delegated" | "done" | "cancelled";
export type TaskflowCiStatus = "unknown" | "pending" | "success" | "failure";

export interface TaskflowOverviewTask {
  path: string;
  repo_path: string;
  title: string;
  task: string;
  project: string;
  kind: string;
  status: TaskflowTaskStatus;
  created: string;
  assignee: string | null;
  source_session: string | null;
  session_status: SessionRow["status"] | null;
  delegation_run_id: string | null;
  delegation_status: string | null;
  pr: { number: number; title: string; url: string | null; state: string } | null;
  ci_status: TaskflowCiStatus;
}

export interface TaskflowOverviewResult {
  generated_at: number;
  counts: {
    total: number;
    pending: number;
    delegated: number;
    done: number;
    cancelled: number;
    ci_failure: number;
    ci_pending: number;
  };
  tasks: TaskflowOverviewTask[];
}

export interface FederationSiteView {
  site_id: string;
  name: string | null;
  status: "active" | "revoked";
  connection: "online" | "offline";
  connected_at: number | null;
  last_seen_at: number | null;
  last_connected_at: number | null;
  site_version: string | null;
  pending_events: number;
  created_at: number;
  revoked_at: number | null;
}

export interface FederationListResult {
  listener_enabled: boolean;
  sites: FederationSiteView[];
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

async function patch<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return (await r.json()) as T;
}

async function del<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return (await r.json()) as T;
}

type FieldSource = "db" | "env" | "none" | "default";

export interface BotRuntimeStatus {
  running: boolean;
  embedded_enabled: boolean;
  last_status: string | null;
  last_error: string | null;
}

export interface SlackConfigStatus {
  enabled: boolean;
  channel_id: string | null;
  bot_token_set: boolean;
  app_token_set: boolean;
  runtime: BotRuntimeStatus;
  source: {
    enabled: FieldSource;
    channel_id: FieldSource;
    bot_token: FieldSource;
    app_token: FieldSource;
  };
}

/** Revisor workflow token の状態。 値は返らず set 済みと出所だけ。 */
export interface RevisorConfigStatus {
  workflow_token_set: boolean;
  source: "db" | "env" | "none";
}

export interface SlackBotActionResult {
  ok: boolean;
  status: string;
  error?: string;
}

export interface DiscordConfigStatus {
  enabled: boolean;
  guild_id: string | null;
  application_id: string | null;
  permission_requests_enabled: boolean;
  message_optimization_enabled: boolean;
  token_set: boolean;
  runtime: BotRuntimeStatus;
  source: {
    enabled: FieldSource;
    guild_id: FieldSource;
    application_id: FieldSource;
    permission_requests_enabled: FieldSource;
    message_optimization_enabled: FieldSource;
    token: FieldSource;
  };
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

export interface SessionLogMeta {
  id: string;
  date: string;
  seq: number;
  title: string;
  projects: string[];
  sections: string[];
  size_bytes: number;
  mtime: number;
  excerpt: string;
}
export interface SessionLogFull extends SessionLogMeta {
  content_md: string;
}
export interface SessionLogsList {
  root: string | null;
  total: number;
  total_matched: number;
  projects: Array<{ name: string; count: number }>;
  entries: SessionLogMeta[];
}

export interface RepoCleanupReport {
  name: string;
  path: string;
  default_branch: string | null;
  current_branch: string | null;
  actions: string[];
  deferred: string[];
  error: string | null;
}
export interface WsCleanupResult {
  apply: boolean;
  repos: RepoCleanupReport[];
  summary: { repos: number; actions: number; deferred: number; errors: number };
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
  /** 旧 persona 機構の遺構カラム (常に null。過去行にのみ値が残る)。 */
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

export interface RepoWorktree {
  path: string;
  branch: string | null;
  is_main: boolean;
}
export interface RepoSessionRef {
  id: string;
  branch: string | null;
  status: string;
  current_task: string | null;
}
export interface RepoStatus {
  name: string;
  path: string;
  branch: string | null;
  detached: boolean;
  is_worktree: boolean;
  default_branch: string | null;
  on_default_branch: boolean;
  worktrees: RepoWorktree[];
  extra_worktree_count: number;
  /** HEAD 最終コミット時刻 (epoch 秒、 取れなければ null)。 */
  updated_at: number | null;
  sessions: RepoSessionRef[];
  error: string | null;
}

export interface HostSnapshot {
  sampled_at: number;
  host: { totalMem: number; usedMem: number; freeMem: number; cpuCount: number; loadPct: number | null };
  topProcesses: Array<{ name: string; rss: number; count: number }>;
  sessions: Array<{
    session_id: string;
    label: string;
    repo_path: string;
    status: string;
    rss: number;
    procCount: number;
    pid: number;
  }>;
}

/** クロスサービス cost-feed の集計 1 group (GET /v1/cost-feed)。 */
export interface CostAgg {
  /** group key: "(total)" / サービス名 / model id。 */
  key: string;
  sessions: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface CostFeedReport {
  total: CostAgg;
  byService: CostAgg[];
  byModel: CostAgg[];
  /** 見えた最新 entry の ts (epoch ms)、空なら null。 */
  updatedAt: number | null;
}

// ── 自セッションコスト (/v1/cost) — Discord の「Concordia Monitor」「コスト」と同内容 ──
/** 1 組織 (本社 or 子会社) のコスト行。 */
export interface OrgCostRow {
  id: string | null;
  name: string;
  tokens: number;
  budget: number;
  blocked: boolean;
}
export interface OrgCostReport {
  headOffice: OrgCostRow;
  subsidiaries: OrgCostRow[];
  totalTokens: number;
  label: string;
}
/** 1 セッション (= 1 チャンネル) の現在の context/cost。 */
export interface ChannelCostRow {
  sessionId: string;
  channelId: string | null;
  provider: string;
  contextTokens: number | null;
  costTokens: number;
}
export interface CostOverview {
  windows: { daily: OrgCostReport; weekly: OrgCostReport };
  channels: ChannelCostRow[];
}
/** 時系列グラフ 1 点 (バケット)。 */
export interface UsageTimeseriesPoint {
  ts: number;
  sessions: number;
  contextTokens: number;
  spentTokens: number;
}
export interface UsageProviderTimeseriesPoint extends UsageTimeseriesPoint {
  provider: string;
}
export interface UsageTimeseries {
  bucketSec: number;
  points: UsageTimeseriesPoint[];
  providers: Record<string, UsageTimeseriesPoint[]>;
  providerPoints: UsageProviderTimeseriesPoint[];
}
export interface LimitTimeseriesPoint {
  ts: number;
  provider: string;
  plan: string | null;
  used5hPct: number | null;
  usedWeeklyPct: number | null;
  reset5hAt: number | null;
  resetWeeklyAt: number | null;
}
export interface LimitTimeseries {
  points: LimitTimeseriesPoint[];
  providers: Record<string, LimitTimeseriesPoint[]>;
}

// ── Library Hygiene (メモリ/スキル整理) ──────────────────────────────
export interface LibraryBlockFlags {
  orphanIndex?: boolean;
  orphanFile?: boolean;
  duplicateName?: boolean;
  stale?: boolean;
  oversize?: boolean;
  poison?: string[];
}
export interface LibraryBlock {
  id: string;
  sourceId: string;
  kind: "memory" | "skill";
  name: string;
  title: string;
  description: string;
  relPath: string;
  size_bytes: number;
  line_count: number;
  mtime: number;
  flags: LibraryBlockFlags;
  indexLine?: string;
}
export interface LibrarySource {
  id: string;
  kind: "memory" | "skill";
  sourceKind: "central-memory" | "project-memory" | "global-skill" | "project-skill";
  label: string;
  rootDir: string;
  indexPath?: string;
  indexLineCount?: number;
  indexBytes?: number;
  blocks: LibraryBlock[];
}
export interface LibraryFinding {
  level: "warn" | "info";
  code: string;
  message: string;
  sourceId?: string;
  blockId?: string;
}
export interface LibrarySnapshot {
  scannedAt: number;
  sources: LibrarySource[];
  summary: {
    totalSources: number;
    totalBlocks: number;
    totalBytes: number;
    memoryBlocks: number;
    skillBlocks: number;
  };
  findings: LibraryFinding[];
}
export interface LibrarySuggestion {
  kind: "contradiction" | "merge" | "archive" | "shorten" | "split";
  message: string;
  blockIds: string[];
  rationale?: string;
}
export interface LibraryAnalyzeResult {
  disabled: boolean;
  model: string;
  suggestions: LibrarySuggestion[];
  error?: string;
}
export interface ArchivePlanItem {
  blockId: string;
  name: string;
  action: "move-and-deindex" | "deindex-only" | "move";
  from: string | null;
  to: string | null;
  indexLineRemoved: boolean;
  warnings: string[];
  ok: boolean;
}
export interface ArchiveResponse {
  applied: boolean;
  items: ArchivePlanItem[];
  notFound: Array<{ sourceId: string; name: string }>;
}
export interface ArchivedRecord {
  ts: number;
  blockId: string;
  name: string;
  kind: "memory" | "skill";
  relPath: string;
  archivedAs: string | null;
  indexLine?: string;
  reason?: string;
}

export const api = {
  health: () => get<{ ok: boolean; service: string; version: string }>("/health"),
  costFeed: () => get<CostFeedReport>("/v1/cost-feed"),
  costOverview: () => get<CostOverview>("/v1/cost/overview"),
  costTimeseries: (opts?: { sinceSec?: number; bucketSec?: number }) => {
    const q = new URLSearchParams();
    if (opts?.sinceSec !== undefined) q.set("since", String(opts.sinceSec));
    if (opts?.bucketSec !== undefined) q.set("bucket", String(opts.bucketSec));
    const qs = q.toString();
    return get<UsageTimeseries>(`/v1/cost/timeseries${qs ? "?" + qs : ""}`);
  },
  costLimitTimeseries: (opts?: { sinceSec?: number }) => {
    const q = new URLSearchParams();
    if (opts?.sinceSec !== undefined) q.set("since", String(opts.sinceSec));
    const qs = q.toString();
    return get<LimitTimeseries>(`/v1/cost/limit-timeseries${qs ? "?" + qs : ""}`);
  },
  monitor: () => get<MonitorPayload>("/v1/monitor"),
  taskflowOverview: () => get<TaskflowOverviewResult>("/v1/taskflow/overview"),
  metrics: () => get<{ snapshot: HostSnapshot | null }>("/v1/monitor/metrics"),
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
  projectCodes: () =>
    get<{
      source_path: string;
      categories: Array<{ name: string; entries: Array<[string, string]> }>;
    }>("/v1/project-codes"),
  adminSpawn: (body: {
    provider?: SpawnProvider;
    /** delegation テンプレ call_name 起動。 指定時は provider/model/既定 cwd をテンプレから採用 */
    template?: string;
    /** template 起動時、 render したプロンプトを自動注入するか (既定 false = provider+model のみ) */
    inject_prompt?: boolean;
    /** inject_prompt 時の render 引数 */
    args?: Record<string, unknown>;
    options?: Record<string, unknown>;
    cwd?: string;
    branch?: string;
    worktree?: boolean;
    title?: string;
    mode?: "tab" | "window";
    /** 子会社セッションとして spawn (metadata.subsidiary_id へ焼かれる) */
    subsidiary_id?: string | null;
    /** project 限定 spawn: workspace roots 配下のプロジェクト名。 cwd 固定 + 範囲制限プロンプト注入 */
    project?: string;
    /** 自由テキストの初回プロンプト */
    prompt?: string;
  }) =>
    post<{
      ok: boolean;
      pid: number | null;
      command: string[];
      injected_prompt?: boolean;
      run_id?: string;
      project?: string | null;
      cwd?: string | null;
      branch?: string | null;
      worktree_path?: string | null;
      worktree_created?: boolean;
      error?: string;
    }>(
      "/v1/admin/spawn-session",
      body,
    ),
  delegationTemplates: () =>
    get<{ templates: DelegationTemplateLite[] }>("/v1/delegation/templates"),
  delegationOptions: (provider: SpawnProvider, model?: string | null) => {
    const params = new URLSearchParams({ provider });
    if (model && model.trim()) params.set("model", model.trim());
    return get<{ provider: SpawnProvider; model: string | null; suggestions: DelegationOptionSuggestion[] }>(
      `/v1/delegation/options?${params.toString()}`,
    );
  },
  // ── model catalog (delegation テンプレ / spawn が選べるモデル候補) ──
  modelCatalogList: (includeInactive = false) =>
    get<{ models: ModelCatalogItem[] }>(`/v1/model-catalog${includeInactive ? "?all=1" : ""}`),
  modelCatalogCreate: (body: {
    model_id: string;
    label?: string;
    provider?: ModelCatalogProvider;
    sort_order?: number;
    is_active?: boolean;
  }) => post<{ model: ModelCatalogItem }>("/v1/model-catalog", body),
  modelCatalogUpdate: (id: string, body: {
    model_id?: string;
    label?: string;
    provider?: ModelCatalogProvider;
    sort_order?: number;
    is_active?: boolean;
  }) => patch<{ model: ModelCatalogItem }>(`/v1/model-catalog/${encodeURIComponent(id)}`, body),
  modelCatalogDelete: (id: string) =>
    del<{ ok: boolean }>(`/v1/model-catalog/${encodeURIComponent(id)}`),
  adminStop: (id: string) =>
    post<{ ok: boolean; pid: number }>(`/v1/admin/stop-session/${encodeURIComponent(id)}`, {}),
  discordBotStart: () =>
    post<{ ok: boolean; status: string; error?: string }>("/v1/admin/discord/start", {}),
  discordBotStop: () =>
    post<{ ok: boolean; status: string; error?: string }>("/v1/admin/discord/stop", {}),
  discordBotRestart: () =>
    post<{ ok: boolean; status: string; error?: string }>("/v1/admin/discord/restart", {}),
  discordConfigGet: () => get<DiscordConfigStatus>("/v1/admin/discord/config"),
  discordConfigSet: (body: {
    enabled?: boolean;
    guild_id?: string | null;
    application_id?: string | null;
    token?: string | null;
    permission_requests_enabled?: boolean;
    message_optimization_enabled?: boolean;
  }) =>
    put<{ ok: boolean; status: DiscordConfigStatus; restart: SlackBotActionResult }>(
      "/v1/admin/discord/config",
      body,
    ),
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
  revisorConfigGet: () => get<RevisorConfigStatus>("/v1/admin/revisor/config"),
  // workflow_token: null = クリア (env フォールバックへ) / undefined = 据え置き
  revisorConfigSet: (body: { workflow_token?: string | null }) =>
    put<RevisorConfigStatus>("/v1/admin/revisor/config", body),
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
  answerQuestion: (
    id: string,
    body:
      | { question_id: number; answer_index: number }
      | { question_id: number; answer_indices: number[] }
      | { question_id: number; other_text: string },
  ) =>
    post<{ ok: boolean; ts: number }>(`/v1/sessions/${encodeURIComponent(id)}/answer-question`, body),
  resolveQuestion: (id: string, questionId: number) =>
    post<{ ok: boolean }>(
      `/v1/sessions/${encodeURIComponent(id)}/pending-question/${encodeURIComponent(String(questionId))}/resolve`,
      {},
    ),
  sessionTranscript: (
    id: string,
    opts: { since_id?: number; limit?: number; tail?: boolean } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.since_id !== undefined) qs.set("since_id", String(opts.since_id));
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.tail) qs.set("tail", "1");
    const qstr = qs.toString();
    return get<{
      session_id: string;
      total: number;
      entries: Array<{ id: number; seq: number; ts: number; kind: string; payload: unknown }>;
      next_since_id: number;
    }>(`/v1/sessions/${encodeURIComponent(id)}/transcript${qstr ? `?${qstr}` : ""}`);
  },
  // /v1/chat の client は Chat ページ削除に伴い撤去した (backend は無変更で稼働中)。
  workRepos: () => get<{ root: string; roots: string[]; repos: RepoStatus[] }>("/v1/work/repos"),
  prsQueue: (repo?: string, author?: string) => {
    const q = new URLSearchParams();
    if (repo) q.set("repo", repo);
    if (author) q.set("author", author);
    const tail = q.toString();
    return get<PrQueueResult>(`/v1/prs${tail ? `?${tail}` : ""}`);
  },
  reportsList: (limit = 30) => get<{ reports: ReportSummary[] }>(`/v1/reports?limit=${limit}`),
  sessionLogsList: (opts: { project?: string; q?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.project) qs.set("project", opts.project);
    if (opts.q) qs.set("q", opts.q);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const tail = qs.toString();
    return get<SessionLogsList>(`/v1/session-logs${tail ? `?${tail}` : ""}`);
  },
  sessionLog: (id: string) => get<SessionLogFull>(`/v1/session-logs/${encodeURIComponent(id)}`),
  federationList: () => get<FederationListResult>("/v1/federation"),
  federationCreateSite: (body: { site_id: string; name?: string | null }) =>
    post<{ ok: true; site_id: string; token: string }>("/v1/federation/sites", body),
  federationRevokeSite: (siteId: string) =>
    post<{ ok: true; site_id: string }>(`/v1/federation/sites/${encodeURIComponent(siteId)}/revoke`, {}),
  wsCleanupDryRun: () => get<WsCleanupResult>("/v1/admin/ws-cleanup"),
  wsCleanupApply: (body: { fetch?: boolean; delete_merged_remote_gone?: boolean } = {}) =>
    post<WsCleanupResult>("/v1/admin/ws-cleanup", { apply: true, ...body }),
  skillsList: () => get<{ skills: SkillSnapshot[] }>("/v1/skills"),
  skillsHistory: (repo_path: string, skill_name = "concordia") =>
    get<{ history: SkillSnapshot[] }>(
      `/v1/skills/history?repo_path=${encodeURIComponent(repo_path)}&skill_name=${encodeURIComponent(skill_name)}`,
    ),
  report: (id: string) =>
    get<{ session_id: string; summary_md: string; bullets: any; duration_sec: number }>(
      `/v1/reports/${encodeURIComponent(id)}`,
    ),
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
  library: () => get<LibrarySnapshot>("/v1/library"),
  libraryContent: (sourceId: string, path: string, archived = false) =>
    get<{ path: string; content: string; truncated: boolean; size_bytes: number }>(
      `/v1/library/content?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(path)}${archived ? "&archived=1" : ""}`,
    ),
  libraryArchived: (sourceId: string) =>
    get<{ source: string; archived: ArchivedRecord[] }>(
      `/v1/library/archived?source=${encodeURIComponent(sourceId)}`,
    ),
  libraryAnalyze: (home: string) => post<LibraryAnalyzeResult>("/v1/library/analyze", { home }),
  libraryArchive: (
    blocks: Array<{ sourceId: string; name: string }>,
    opts: { apply?: boolean; reason?: string } = {},
  ) => post<ArchiveResponse>("/v1/library/archive", { blocks, ...opts }),
  libraryRestore: (blocks: Array<{ sourceId: string; blockId: string }>) =>
    post<{ results: Array<{ ok: boolean; name: string; restoredTo: string | null; indexLineRestored: boolean; warnings: string[] }> }>(
      "/v1/library/restore",
      { blocks },
    ),

  // ── 共通ハーネスルール (子会社ガードのポリシー) ──
  harnessRulesList: (all = false) =>
    get<{ rules: HarnessRule[] }>(`/v1/harness-rules${all ? "?all=1" : ""}`),
  harnessRuleCreate: (body: Partial<HarnessRule> & { kind: "allow" | "block"; description: string }) =>
    post<{ rule: HarnessRule }>("/v1/harness-rules", body),
  harnessRuleUpdate: (id: string, body: Partial<HarnessRule>) =>
    patch<{ rule: HarnessRule }>(`/v1/harness-rules/${encodeURIComponent(id)}`, body),
  harnessRuleDelete: (id: string) =>
    del<{ ok: boolean; error?: string }>(`/v1/harness-rules/${encodeURIComponent(id)}`),

  // ── 社員名簿 (役職権限登録リスト) ──
  staffList: () => get<StaffListResult>("/v1/staff"),
  staffCreate: (body: {
    platform: StaffPlatform;
    platform_user_id: string;
    role: StaffRole;
    display_name?: string;
    note?: string;
  }) => post<{ member: StaffMember }>("/v1/staff", body),
  staffUpdate: (
    platform: StaffPlatform,
    userId: string,
    body: { role?: StaffRole; note?: string },
  ) => patch<{ member: StaffMember }>(
    `/v1/staff/${platform}/${encodeURIComponent(userId)}`,
    body,
  ),
  staffDelete: (platform: StaffPlatform, userId: string) =>
    del<{ ok: boolean }>(`/v1/staff/${platform}/${encodeURIComponent(userId)}`),

  // ── Revisor (ローカル PR レビューサービス) の local PR ──
  prsRevisor: () => get<RevisorLocalPrsResult>("/v1/prs/revisor"),

  // ── kind 別 Inject マニュアル (delegation 協調コンテキストへ差し込む作業マニュアル) ──
  injectManualsList: () => get<{ manuals: InjectManual[] }>("/v1/admin/inject-manuals"),
  injectManualUpdate: (kind: string, content: string) =>
    put<{ manual: InjectManual }>(`/v1/admin/inject-manuals/${encodeURIComponent(kind)}`, { content }),

  // ── ハーネス監査ログ (ローカルセッション強制ゲートの裏取り) ──
  harnessAudit: (
    params: { session_id?: string; decision?: HarnessAuditDecision; event?: HarnessAuditEvent; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.session_id) q.set("session_id", params.session_id);
    if (params.decision) q.set("decision", params.decision);
    if (params.event) q.set("event", params.event);
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return get<HarnessAuditResponse>(`/v1/harness/audit${qs ? `?${qs}` : ""}`);
  },

  // ── 子会社 Delegation ──
  subsidiariesList: () => get<{ subsidiaries: SubsidiarySummary[] }>("/v1/subsidiaries"),
  subsidiaryGet: (id: string) =>
    get<{ subsidiary: SubsidiarySummary; delegations: SubsidiaryDelegation[]; locks: SubsidiaryLock[]; requests: SubsidiaryRequest[] }>(
      `/v1/subsidiaries/${encodeURIComponent(id)}`,
    ),
  subsidiaryCreate: (body: SubsidiaryInput) => post<{ subsidiary: SubsidiarySummary }>("/v1/subsidiaries", body),
  subsidiaryUpdate: (id: string, body: Partial<SubsidiaryInput>) =>
    patch<{ subsidiary: SubsidiarySummary }>(`/v1/subsidiaries/${encodeURIComponent(id)}`, body),
  subsidiaryDelete: (id: string) => del<{ ok: boolean }>(`/v1/subsidiaries/${encodeURIComponent(id)}`),
  // 所有 delegation: 1 件 upsert (可搬 JSON 貼付) / 削除 / 既定設定 / export(コピー) / clone。
  subsidiaryDelegationUpsert: (id: string, callName: string, body: PortableDelegation) =>
    put<{ delegation: SubsidiaryDelegation }>(
      `/v1/subsidiaries/${encodeURIComponent(id)}/delegations/${encodeURIComponent(callName)}`,
      body,
    ),
  subsidiaryDelegationDelete: (id: string, callName: string) =>
    del<{ ok: boolean }>(`/v1/subsidiaries/${encodeURIComponent(id)}/delegations/${encodeURIComponent(callName)}`),
  subsidiaryDelegationSetDefault: (id: string, callName: string) =>
    post<{ ok: boolean; delegations: SubsidiaryDelegation[] }>(
      `/v1/subsidiaries/${encodeURIComponent(id)}/delegations/${encodeURIComponent(callName)}/default`,
      {},
    ),
  subsidiaryDelegationExport: (id: string, callName: string) =>
    get<{ delegation: PortableDelegation }>(
      `/v1/subsidiaries/${encodeURIComponent(id)}/delegations/${encodeURIComponent(callName)}/export`,
    ),
  subsidiaryDelegationClone: (id: string, body: { call_name: string; as_call_name?: string; is_default?: boolean }) =>
    post<{ delegation: SubsidiaryDelegation }>(`/v1/subsidiaries/${encodeURIComponent(id)}/delegations/clone`, body),
  subsidiaryStart: (id: string) => post<{ ok: boolean; status: string; error?: string }>(`/v1/subsidiaries/${encodeURIComponent(id)}/start`, {}),
  subsidiaryStop: (id: string) => post<{ ok: boolean; status: string; error?: string }>(`/v1/subsidiaries/${encodeURIComponent(id)}/stop`, {}),
  subsidiaryRestart: (id: string) => post<{ ok: boolean; status: string; error?: string }>(`/v1/subsidiaries/${encodeURIComponent(id)}/restart`, {}),
  subsidiaryUnlock: (id: string, platform: string, userId: string) =>
    del<{ ok: boolean }>(`/v1/subsidiaries/${encodeURIComponent(id)}/locks/${encodeURIComponent(platform)}/${encodeURIComponent(userId)}`),
};

// ─── 社員名簿 (役職権限登録リスト) ───────────────────────────────────────────
// backend `src/staff/roles.ts` の StaffRole / StaffCapability と対応する。
// 役職を追加するときは backend を同時に更新する (固定語彙)。

export type StaffPlatform = "discord" | "slack";
export type StaffRole = "staff" | "manager" | "executive";
export type StaffCapability =
  | "converse"
  | "reaction_workflow"
  | "session_spawn"
  | "session_end"
  | "merge_pr"
  | "kill_switch";

export interface StaffMember {
  platform: StaffPlatform;
  platform_user_id: string;
  display_name: string;
  /** サーバーでのプロファイル名 (Discord の guild nickname)。 空なら未取得。 */
  profile_name: string;
  role: StaffRole;
  note: string;
  first_seen_at: number;
  last_seen_at: number;
  updated_at: number;
}

export interface StaffListResult {
  members: StaffMember[];
  counts: Record<StaffPlatform, Record<StaffRole, number>>;
  /** 執行役員が 1 人も居ない = キルスイッチを誰も踏めない状態。 */
  has_executive: boolean;
  roles: Array<{
    role: StaffRole;
    label: string;
    capabilities: Array<{ capability: StaffCapability; label: string }>;
  }>;
  capabilities: Array<{
    capability: StaffCapability;
    label: string;
    min_role: StaffRole;
    min_role_label: string;
  }>;
}

/** Revisor local PR (GET /v1/prs/revisor)。 Revisor 側の camelCase をそのまま受ける。 */
export interface RevisorLocalPr {
  id: string;
  number: number;
  repository: string;
  title: string;
  author: string;
  status: string;
  checkStatus: string;
  draft?: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  reviewedHeadSha?: string | null;
  reviewer?: string | null;
  labels?: string[];
  reasons?: string[];
  advisories?: string[];
  humanQuestion?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RevisorLocalPrsResult {
  /** Revisor 読み取り口が未注入なら false (セクションを描かない)。 token 有無とは無関係。 */
  configured: boolean;
  /** Revisor WebUI の base URL (loopback)。 到達不能なら null。 */
  base_url: string | null;
  pull_requests: RevisorLocalPr[];
  error: string | null;
}

/** kind 別 Inject マニュアル (GET/PUT /v1/admin/inject-manuals)。 */
export interface InjectManual {
  kind: string;
  content: string;
  updated_at: number;
}

export interface HarnessRule {
  id: string;
  kind: "allow" | "block";
  title: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export type HarnessAuditEvent = "inject" | "gate" | "block" | "start_prompt" | "override";
export type HarnessAuditDecision = "allow" | "deny" | "warn";

/** ローカルセッションのハーネス強制ゲート 監査ログ 1 行 (created_at は ms = Date.now())。 */
export interface HarnessAuditRow {
  id: string;
  session_id: string;
  project: string;
  hook: string;
  event: HarnessAuditEvent;
  tool: string;
  action: string;
  repo: string;
  rule: string;
  decision: HarnessAuditDecision;
  reason: string;
  detail_json: string;
  ms: number;
  created_at: number;
}

export interface HarnessAuditResponse {
  audit: HarnessAuditRow[];
  summary: Array<{ decision: HarnessAuditDecision; count: number }>;
}

/** 子会社が所有する delegation 複製 (cwd / project を内包)。 */
export interface SubsidiaryDelegation {
  call_name: string;
  is_default: boolean;
  title: string;
  description: string;
  target_provider: SpawnProvider;
  model: string | null;
  prompt_template: string;
  input_schema: DelegationInputSchemaItem[];
  default_cwd: string | null;
  project: string | null;
  emoji: string;
  created_at: number;
  updated_at: number;
}

/** 1 つの delegation を持ち運ぶ可搬 JSON (コピー/貼付)。 */
export interface PortableDelegation {
  kind?: string;
  version?: number;
  call_name?: string;
  title?: string;
  description?: string;
  target_provider: SpawnProvider;
  model?: string | null;
  prompt_template?: string;
  input_schema?: DelegationInputSchemaItem[];
  default_cwd?: string | null;
  project?: string | null;
  emoji?: string;
  sort_order?: number;
}
export interface SubsidiaryLock {
  id: number;
  subsidiary_id: string;
  platform: string;
  platform_user_id: string;
  user_label: string;
  reason: string;
  locked_at: number;
}
export interface SubsidiaryRequest {
  id: string;
  platform: string;
  platform_user_id: string;
  user_label: string;
  instruction: string;
  decision: "allow" | "deny";
  reason: string;
  violations_json: string;
  matched_call_name: string | null;
  locked: number;
  run_id: string | null;
  created_at: number;
}
/** subsidiary = 別サーバへ出張 (専用 Bot) / desk = 本社サーバ内の軽量窓口 (Bot 無し)。 */
export type SubsidiaryMode = "subsidiary" | "desk";

export interface SubsidiarySummary {
  id: string;
  name: string;
  display_name: string;
  description: string;
  platform: "discord" | "slack";
  mode: SubsidiaryMode;
  enabled: boolean;
  guild_id: string | null;
  application_id: string | null;
  channel_id: string | null;
  guard_model: string;
  guard_scope: string;
  home_cwd: string | null;
  daily_token_budget: number;
  bot_token_set: boolean;
  app_token_set: boolean;
  running: boolean;
  usage_today_tokens?: number;
  budget_blocked?: boolean;
  delegations?: SubsidiaryDelegation[];
  lock_count?: number;
  /** 直近 24h にガードが処理した依頼の decision 別件数 (一覧 GET のみ)。 */
  requests_24h?: { allow: number; deny: number };
}
export interface SubsidiaryInput {
  name?: string;
  display_name?: string;
  description?: string;
  platform?: "discord" | "slack";
  mode?: SubsidiaryMode;
  enabled?: boolean;
  guild_id?: string | null;
  application_id?: string | null;
  channel_id?: string | null;
  bot_token?: string | null;
  app_token?: string | null;
  guard_model?: string;
  guard_scope?: string;
  daily_token_budget?: number;
}

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
