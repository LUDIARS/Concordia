import { z } from "zod";
import type { SessionRow } from "../../shared/types.js";
import type { PersonaRow } from "../../db/personas-repo.js";
import { fetchFromLictor } from "../../control/lictor-proxy.js";
import type { SpawnProvider } from "../../control/spawner.js";
import { createChildLogger } from "../../shared/logger.js";

export const log = createChildLogger("sessions-api");

/**
 * transcript-frame に乗ってくる user input 1 件分のログ出力上限.
 * 長文プロンプトの 1 回貼り付けが ~数 KB に達することがあるので、
 * 個人情報やシークレットを大量に流さないよう冒頭だけ残す.
 */
export const PROMPT_LOG_PREVIEW_CHARS = 200;
export const INACTIVE_TRANSCRIPT_LOG_WINDOW_MS = 30_000;
export const inactiveTranscriptPostLogState = new Map<string, { lastAt: number; suppressed: number }>();
/** DELETE 後 force-exit の猶予。 これを過ぎても lictor_pid 生存なら強制 kill する。 */
export const FORCE_EXIT_GRACE_MS = 5000;
/**
 * AI 側の session-end スキルが完了シグナルを送るまで force-exit を保留する猶予。
 * `POST /v1/sessions/:id/session-end-done` が来ればその時点で即 force-exit。
 * 来なくてもこの時間後に保険として force-exit を発行する。
 */
export const SESSION_END_DONE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
/** id → force-exit 実行関数。 session-end-done シグナルかタイムアウトで発火する。 */
export const pendingSessionEndExits = new Map<string, () => void>();

/** /co-relictor で再起動した新セッションへ流す引き継ぎ inject の source。 */
export const RELICTOR_INJECT_SOURCE = "auto:relictor-handoff";
export const RELICTOR_REINJECT_HEADER =
  "【Lictor 再起動・引き継ぎ】前のセッションを最新 Lictor で再起動しました。" +
  "直前にこのチャンネルへ投稿した引き継ぎ資料 (🔁) に従って作業を続行してください。" +
  "細部は前セッションのチャンネル / Slack スレッド履歴を遡れば確認できます。\n\n";

/** Concordia の provider 名 → spawn (Lictor launcher) provider 名。 spawn 不可は null。 */
export function toSpawnProvider(provider: string): SpawnProvider | null {
  switch (provider) {
    case "claude-code":
      return "claude";
    case "codex-cli":
      return "codex";
    case "gemini-cli":
      return "gemini";
    default:
      return null;
  }
}

export const StartSchema = z.object({
  id: z.string().min(1).max(128),
  provider: z.enum(["claude-code", "gemini-cli", "codex-cli", "local-llm", "unknown"]),
  repo_path: z.string().min(1),
  repo_origin: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  host: z.string().min(1),
  transcript_path: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** 作業衝突監視で使う「実際に扱う個別プロジェクト」の宣言 (conflict-scope.ts)。 */
  target_project: z.string().nullable().optional(),
});

export const PatchSchema = z.object({
  current_task: z.string().optional(),
  branch: z.string().optional(),
  repo_path: z.string().min(1).optional(),
  repo_origin: z.string().nullable().optional(),
  /**
   * 作業衝突監視のスコープ宣言。 cwd がワークスペースルート (umbrella) でも、 ここで
   * 個別プロジェクト (repo path 推奨) を宣言すればそのプロジェクト単位で衝突判定する。
   * null で宣言解除 (repo_path 判定に戻す)。 (conflict-scope.ts)
   */
  target_project: z.string().nullable().optional(),
  /**
   * Shallow merge into session.metadata. Use `null` value to delete a key.
   * Lictor uses this post-spawn to publish `lictor_port` once the sidecar
   * is bound (the initial register happens BEFORE the port is known).
   */
  metadata: z.record(z.unknown()).optional(),
});

export const EventSchema = z.object({
  kind: z.string().min(1).max(64),
  payload: z.record(z.unknown()).optional(),
  ts: z.number().int().positive().optional(),
});

export const InjectSchema = z.object({
  text: z.string().min(1).max(4000),
  source: z.string().min(1).max(120).optional(),
  // 人間入力者の表示名 (ingress が付与)。参加者レジストリ登録 + ミラー発言者明示に使う。
  author_label: z.string().min(1).max(120).optional(),
});

// セッションのゴール設定 (/co-goal)。 mode 明示 / 自由文どちらか or 両方。
export const GoalSchema = z.object({
  mode: z.enum(["complete", "scoped", "watch"]).optional(),
  text: z.string().max(500).optional(),
});

export const TranscriptFrameSchema = z.object({
  seq: z.number().int().nonnegative(),
  kind: z.string().min(1).max(64),
  payload: z.unknown(),
});

export const PermissionRequestSchema = z.object({
  request_id: z.string().min(1).max(128),
  tool_name: z.string().min(1).max(128),
  tool_input: z.unknown(),
});

export const PermissionResponseSchema = z.object({
  request_id: z.string().min(1).max(128),
  decision: z.enum(["allow", "deny", "ask"]),
  reason: z.string().max(2000).optional(),
});

/**
 * Body for POST /v1/sessions/:id/title-suggestion.
 * 上限 200 char は OSC タイトルの実用幅 + 多バイト混在を考慮して広めに取る.
 * 実際の rename は Lictor 側の sanitizer (32 char cap) が決める.
 */
export const TitleSuggestionSchema = z.object({
  text: z.string().min(1).max(200),
});
// /:id/title 用 (window-title hook / rename コマンドから。Lictor へは転送しない)。
export const TitleSetSchema = z.object({
  text: z.string().min(1).max(200),
});
// AskUserQuestion option は旧形式 string と新形式 {label, description?} の
// 両方を受け入れる. 内部 (DB / Discord embed) では正規化された {label, description?} で扱う.
export const PendingQuestionOptionSchema = z.union([
  z.string().min(1).max(80),
  z.object({
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(200).optional(),
  }),
]);
export const PendingQuestionSchema = z.object({
  question: z.string().min(1).max(2000),
  options: z.array(PendingQuestionOptionSchema).min(1).max(25),
  multi_select: z.boolean().optional(),
});
// 回答は 3 形態のいずれか: 単一 (answer_index) / 複数 (answer_indices) / 自由文 (other_text)。
export const AnswerQuestionSchema = z
  .object({
    question_id: z.number().int().positive(),
    answer_index: z.number().int().min(0).max(24).optional(),
    answer_indices: z.array(z.number().int().min(0).max(24)).min(1).max(25).optional(),
    other_text: z.string().min(1).max(2000).optional(),
  })
  .refine(
    (d) => d.answer_index !== undefined || d.answer_indices !== undefined || d.other_text !== undefined,
    { message: "one of answer_index / answer_indices / other_text required" },
  );

export const ForkSchema = z.object({
  /** Claude per-message uuid to resume from. Comes from the transcript frame's payload.claude_uuid. */
  claude_uuid: z.string().min(1).max(128),
  /** Working directory for the new session. Defaults to parent's repo_path. */
  cwd: z.string().min(1).optional(),
  /** Window vs tab — passed through to wt.exe spawner. */
  mode: z.enum(["tab", "window"]).optional(),
});


export function serializePersonaForResponse(p: PersonaRow) {
  let traits: unknown = [];
  let learned: unknown = [];
  try { traits = JSON.parse(p.traits); } catch { traits = []; }
  try { learned = JSON.parse(p.learned_notes); } catch { learned = []; }
  return {
    id: p.id,
    name: p.name,
    display_name: p.display_name ?? "",
    description: p.description,
    traits,
    speech_style: p.speech_style,
    skill_template: p.skill_template,
    learned_notes: learned,
  };
}


export function buildAdvisory(session: SessionRow, peers: SessionRow[]) {
  const sameBranchPeers = peers.filter((p) => p.branch && p.branch === session.branch);
  const branchConflict = sameBranchPeers.length > 0;
  const shortId = session.id.slice(0, 8);
  const repoBase = session.repo_path.split(/[/\\]/).pop() ?? "repo";
  const worktreeCommand = branchConflict
    ? `git worktree add ../${repoBase}-${shortId} ${session.branch ?? "HEAD"}`
    : null;
  return {
    active_peer_count: peers.length,
    active_peer_ids: peers.map((p) => p.id),
    branch_conflict: branchConflict,
    recommend_worktree: branchConflict,
    worktree_command: worktreeCommand,
  };
}

export function serializeSession(s: SessionRow) {
  return {
    id: s.id,
    provider: s.provider,
    repo_path: s.repo_path,
    repo_origin: s.repo_origin,
    target_project: s.target_project ?? null,
    branch: s.branch,
    host: s.host,
    started_at: s.started_at,
    ended_at: s.ended_at,
    status: s.status,
    last_seen_at: s.last_seen_at,
    current_task: s.current_task,
    metadata: s.metadata ? safeParse(s.metadata) : null,
  };
}

/**
 * sessions 行が sweeper (purgeStale) で消えても transcript_logs が残っている
 * 孤児セッション向けの、 閲覧用 synthetic session. serializeSession と同形.
 * 開始/終了は transcript の ts レンジ、 status は誤操作防止のため abandoned 扱い.
 */
export function syntheticPurgedSession(id: string, span: { first_ts: number; last_ts: number }) {
  return {
    id,
    provider: "purged",
    repo_path: null,
    repo_origin: null,
    branch: null,
    host: null,
    started_at: span.first_ts,
    ended_at: span.last_ts,
    status: "abandoned" as const,
    last_seen_at: span.last_ts,
    current_task: "(session purged — transcript ログのみ保持)",
    metadata: { synthetic: true, purged: true },
  };
}

export async function proxyGet(c: { json: (body: any, status: any) => Response }, port: number, path: string): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetchFromLictor(port, path, { method: "GET" });
  } catch (err) {
    return c.json({ error: `lictor unreachable: ${(err as Error).message}` }, 502 as 502);
  }
  const text = await upstream.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return c.json(body, upstream.status as 200);
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 生きた traffic (event / heartbeat / patch) を送ってきた lost セッションを active へ戻す。
 * lost への遷移は sweeper 側 (WS 切断 + last_seen 停滞) で起きるが、 従来は SessionStart
 * しか active へ戻す経路がなく、 一度 lost になった健全セッションが「lost のまま固定 →
 * purgeStale で行 DELETE → reaper が孤児と誤認して生きている process tree を kill」 という
 * 連鎖で殺されていた。 traffic があれば生きている証拠なので、 ここで復帰させて連鎖を断つ。
 * (ended / abandoned は意図的な状態なので対象外。 lost のみ復帰させる。)
 */
export function reviveIfLost(
  repo: {
    setStatus: (id: string, status: "active", ts: number) => void;
    appendEvent: (ev: { session_id: string; ts: number; kind: string; payload: Record<string, unknown> }) => void;
  },
  session: Pick<SessionRow, "id" | "status">,
  ts: number,
): boolean {
  if (session.status !== "lost") return false;
  repo.setStatus(session.id, "active", ts);
  repo.appendEvent({
    session_id: session.id,
    ts,
    kind: "revive",
    payload: { from: "lost", to: "active", reason: "live traffic received" },
  });
  log.info({ session_id: session.id }, "lost session revived by live traffic");
  return true;
}

export function logInactiveTranscriptPost(
  sessionId: string,
  seq: number,
  kind: string,
  status: { sessionStatus: string; discordStatus: string | null; persisted: boolean },
): void {
  const now = Date.now();
  const prev = inactiveTranscriptPostLogState.get(sessionId);
  if (prev && now - prev.lastAt < INACTIVE_TRANSCRIPT_LOG_WINDOW_MS) {
    prev.suppressed += 1;
    return;
  }
  const suppressed = prev?.suppressed ?? 0;
  inactiveTranscriptPostLogState.set(sessionId, { lastAt: now, suppressed: 0 });
  log.warn(
    {
      session_id: sessionId,
      seq,
      kind,
      session_status: status.sessionStatus,
      discord_status: status.discordStatus,
      persisted: status.persisted,
      suppressed,
    },
    "transcript frame accepted but not broadcast for inactive session",
  );
}

export function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export function parseMeta(s: string | null): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
