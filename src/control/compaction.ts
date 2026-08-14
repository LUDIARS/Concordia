/**
 * セッション・コンパクション (引き継ぎ型)。
 *
 * 一般的な要約 compact ではなく、 タスク引き継ぎ資料を作って Discord/Slack チャンネルへ
 * 投稿 → `/clear` → 資料を読み直して続行する。 不明点はチャンネル履歴を遡る前提なので、
 * チャンネルそのものが「圧縮されない完全ログ」になる。
 *
 * spec/feature/session-compaction.md。 clear は専用 API ではなく inject "/clear"+Enter
 * を使う (Lictor の既存経路 / provider 非依存)。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import { eventBus } from "../events.js";
import { ENTER_KEY_TEXT } from "./enter-key.js";

export type RunClaudeFn = (
  prompt: string,
  opts: { model?: string; timeoutMs?: number },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const CLEAR_WAIT_MS = Number(process.env.CONCORDIA_COMPACTION_CLEAR_WAIT_MS ?? "4000") || 4000;
const HANDOFF_MODEL = process.env.CONCORDIA_COMPACTION_MODEL || "sonnet";
const HANDOFF_TIMEOUT_MS = Number(process.env.CONCORDIA_COMPACTION_TIMEOUT_MS ?? "90000") || 90000;

// セッション自筆 handoff の捕捉 (elicit) パラメータ。 inject したプロンプトに対し
// セッション自身が書いた地の文 (transcript の assistant text frame) を since_id テールで拾う。
const ELICIT_TIMEOUT_MS = Number(process.env.CONCORDIA_COMPACTION_ELICIT_TIMEOUT_MS ?? "120000") || 120000;
const ELICIT_QUIET_MS = Number(process.env.CONCORDIA_COMPACTION_ELICIT_QUIET_MS ?? "8000") || 8000;
const ELICIT_POLL_MS = Number(process.env.CONCORDIA_COMPACTION_ELICIT_POLL_MS ?? "2000") || 2000;

// metadata に残す直近 handoff の上限。 索引 (フェーズ文脈) 用の抜粋であり、
// 全文は Discord のチャンネル投稿が正本。 metadata blob の肥大を防ぐ。
const LAST_HANDOFF_METADATA_LIMIT = 4000;

export interface CompactionDeps {
  sessions: SessionsRepo;
  transcriptLogs: TranscriptLogsRepo;
  runClaude: RunClaudeFn;
  /** セッションへ文字列を inject する (HTTP /v1/sessions/:id/inject 相当)。 */
  inject: (sessionId: string, text: string, source: string) => Promise<boolean>;
  /** handoff を session のチャンネル (Discord/Slack) へ投稿する。 */
  postHandoff: (sessionId: string, markdown: string) => Promise<void>;
  /** clear と再投入の間の待ち (テストで 0 にできる)。 */
  clearWaitMs?: number;
  /** 待機関数 (テスト差し替え用)。 */
  sleep?: (ms: number) => Promise<void>;
  /** elicit のタイミング上書き (テスト用)。 未指定は env / 既定値。 */
  elicitTimeoutMs?: number;
  elicitQuietMs?: number;
  elicitPollMs?: number;
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

export interface CompactionResult {
  ok: boolean;
  handoff?: string;
  error?: string;
}

const REINJECT_HEADER =
  "【コンパクション】直前にこのチャンネルへ投稿した引き継ぎ資料 (📌) に従って作業を続行してください。" +
  "資料に無い細部は、 このチャンネル / Slack スレッドの履歴を上に遡って確認できます。\n\n";

/** 直近 transcript を読みやすい文字列に畳む (handoff LLM の入力)。 */
export function collectRecentContext(
  transcriptLogs: TranscriptLogsRepo,
  sessionId: string,
  maxChars = 12000,
  maxFrames = 60,
): string {
  let entries: Array<{ kind: string; payload: unknown }> = [];
  try {
    // listBySession は古い順。 直近 maxFrames フレームが欲しいので末尾を取る。
    const all = transcriptLogs.listBySession(sessionId, { limit: 1000 });
    entries = all.slice(Math.max(0, all.length - maxFrames));
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const e of entries) {
    const text = extractText(e.payload);
    if (text) parts.push(`[${e.kind}] ${text}`);
  }
  const joined = parts.join("\n");
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

function extractText(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    for (const k of ["text", "summary", "content", "message"]) {
      if (typeof o[k] === "string" && (o[k] as string).trim()) return (o[k] as string).trim();
    }
    try {
      return JSON.stringify(o).slice(0, 400);
    } catch {
      return "";
    }
  }
  return "";
}

/** handoff 生成プロンプト (純粋 / テスト対象)。 */
export function buildHandoffPrompt(currentTask: string, recentContext: string): string {
  return [
    "あなたは作業セッションのコンテキストを `/clear` する直前にいます。",
    "次の担当 (= clear 後の自分自身) が、 会話の細部を失っても作業を続けられるように、",
    "**タスク引き継ぎ資料** を Markdown で簡潔に作ってください。 一般的な会話要約ではなく、",
    "「続行に必要な情報」だけを構造化します。",
    "",
    "## 出力フォーマット (この見出しで)",
    "### 現在のタスク / ゴール",
    "### これまでに完了したこと",
    "### 次の一手 (最優先)",
    "### 未解決の論点 / 判断待ち",
    "### 重要なファイル・コマンド・PR",
    "### 参照",
    "- 細部はこの Discord チャンネル / Slack スレッドの履歴を上に遡れば復元できます。",
    "",
    "## 既知の current_task",
    currentTask || "(未設定)",
    "",
    "## 直近の会話ログ (これを根拠に)",
    recentContext || "(ログ取得不可 — current_task と一般知識から推測してよい)",
    "",
    "資料本文のみを出力してください (前置き・後置きの地の文は不要)。",
  ].join("\n");
}

/** LLM 失敗時の決定論フォールバック資料。 無言で空にしない。 */
function fallbackHandoff(currentTask: string, recentContext: string): string {
  return [
    "### 現在のタスク / ゴール",
    currentTask || "(未設定 — チャンネル履歴を参照)",
    "",
    "### 次の一手 (最優先)",
    "直前の作業を継続。 詳細はこのチャンネル履歴を遡って確認。",
    "",
    "### 参照",
    "- このハーネスは LLM 要約に失敗したため、 完全な文脈はこの Discord チャンネル /",
    "  Slack スレッドの履歴にあります。 上に遡って確認してください。",
    recentContext ? `\n<!-- recent: ${recentContext.slice(-500)} -->` : "",
  ].join("\n");
}

/**
 * セッション自身に書かせる handoff プロンプト (session-end 相当)。
 *
 * 切り離し Sonnet に transcript 抜粋を要約させる buildHandoffPrompt と違い、 これは
 * **実作業を行った当のセッション** へ inject する。 セッションはフルコンテキスト
 * (実際に何をマージ/完了したか・リポ実状・残タスク) を持つので、 「計画では PR-A だが
 * 実際は A〜D 完了済み」 のような乖離を自分で解消できる。 出力 (地の文) は Lictor の
 * transcript-tail 経由で transcript_logs に入り、 Concordia が since_id で捕捉する。
 */
export function buildSessionEndHandoffPrompt(currentTask: string): string {
  return buildSessionTransitionHandoffPrompt(currentTask, {
    heading: "【コンパクション】このセッションのコンテキストをまもなく `/clear` します。",
    audience: "`/clear` 後の自分自身",
    finalInstruction:
      "資料を書き終えたら、 `/clear` 等の操作は **しないで** ください (Concordia が続けて行います)。",
  });
}

/** 次セッションへ移す handoff を、旧セッション自身に書かせるプロンプト。 */
export function buildSessionHandoverPrompt(currentTask: string): string {
  return buildSessionTransitionHandoffPrompt(currentTask, {
    heading: "【セッション移行】この作業をまもなく次のセッションへ移行します。",
    audience: "作業を引き継ぐ次のセッション",
    finalInstruction:
      "資料を書き終えたら、セッション終了や spawn は **しないで** ください (Concordia が続けて行います)。",
  });
}

function buildSessionTransitionHandoffPrompt(
  currentTask: string,
  transition: { heading: string; audience: string; finalInstruction: string },
): string {
  return [
    transition.heading,
    `session-end と同等の振り返りを行い、 ${transition.audience} が会話の細部を失っても`,
    "作業を続けられる **タスク引き継ぎ資料** を Markdown で書いてください。",
    "",
    "重要: あなたは実作業を行った当人です。 計画段階の発言ではなく **今この時点の実状**",
    "(実際にマージ/完了した PR・現在のブランチ/HEAD・残タスク・ブロック) を根拠にしてください。",
    "計画と実状が食い違う場合は **実状を優先** し、 既に完了済みなら次の一手をそれに合わせて更新します。",
    "必要なら git log / PR 状態を確認してから書いて構いません。",
    "",
    "## 出力フォーマット (この見出しで / 資料本文のみ。 前置き・後置きの地の文は不要)",
    "### 現在のタスク / ゴール",
    "### これまでに完了したこと",
    "### 次の一手 (最優先)",
    "### 未解決の論点 / 判断待ち",
    "### 重要なファイル・コマンド・PR",
    "### 参照",
    "- 細部はこの Discord チャンネル / Slack スレッドの履歴を上に遡れば復元できます。",
    "",
    "## 既知の current_task (参考。 実状と違えば実状を優先)",
    currentTask || "(未設定)",
    "",
    transition.finalInstruction,
  ].join("\n");
}

/** transcript / LLM 出力を Discord や後継セッションへ渡す前の最終資格情報マスク。 */
function redactHandoffSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[REDACTED]",
    );
}

/** transcript frame からセッション (assistant) の地の文を取り出す。 user 指示・tool 系は除外。 */
function assistantTextFromFrame(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  if (o.role === "user") return null; // inject したプロンプトのエコーを除外
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  return null;
}

/**
 * inject した session-end プロンプトに対し、 セッションが書いた handoff (assistant 地の文) を
 * transcript_logs の since_id テールで捕捉する。
 *
 * - watermark: inject 前の最大 transcript id。 これより新しい frame だけ見る。
 * - 最初の地の文が出るまで待ち、 出た後 quiet (新規地の文が途絶える) まで集約する。
 * - timeout までに何も得られなければ null (呼び出し側が切り離し生成へフォールバック)。
 */
export async function elicitHandoffFromSession(
  deps: Pick<CompactionDeps, "transcriptLogs" | "sleep" | "elicitTimeoutMs" | "elicitQuietMs" | "elicitPollMs" | "log">,
  sessionId: string,
  watermark: number,
): Promise<string | null> {
  const pollMs = deps.elicitPollMs ?? ELICIT_POLL_MS;
  const quietMs = deps.elicitQuietMs ?? ELICIT_QUIET_MS;
  const timeoutMs = deps.elicitTimeoutMs ?? ELICIT_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;

  const maxPolls = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs)));
  const quietPolls = Math.max(1, Math.ceil(quietMs / Math.max(1, pollMs)));

  let sinceId = watermark;
  const collected: string[] = [];
  let emptyStreak = 0;

  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    let entries: Array<{ id: number; payload: unknown; kind: string }> = [];
    try {
      entries = deps.transcriptLogs.listBySession(sessionId, { since_id: sinceId, limit: 1000 });
    } catch (e) {
      deps.log?.warn(`compaction: elicit transcript 取得失敗 session=${sessionId}: ${(e as Error).message}`);
      continue;
    }
    let gotText = false;
    for (const e of entries) {
      if (e.id > sinceId) sinceId = e.id;
      if (e.kind !== "text") continue;
      const t = assistantTextFromFrame(e.payload);
      if (t) {
        collected.push(t);
        gotText = true;
      }
    }
    if (collected.length === 0) continue; // まだ最初の地の文が来ていない
    if (gotText) emptyStreak = 0;
    else if (++emptyStreak >= quietPolls) break; // 地の文が途絶えた = 書き終わり
  }

  const handoff = redactHandoffSecrets(collected.join("\n").trim());
  return handoff.length > 0 ? handoff : null;
}

/** handoff を生成する。 LLM 失敗時はフォールバック。 */
export async function generateHandoff(
  deps: Pick<CompactionDeps, "runClaude" | "log">,
  currentTask: string,
  recentContext: string,
): Promise<string> {
  const prompt = buildHandoffPrompt(currentTask, recentContext);
  try {
    const res = await deps.runClaude(prompt, { model: HANDOFF_MODEL, timeoutMs: HANDOFF_TIMEOUT_MS });
    const out = (res.stdout ?? "").trim();
    if (res.ok && out.length > 0) return redactHandoffSecrets(out);
    deps.log?.warn(`compaction: handoff LLM 失敗 (ok=${res.ok}) → フォールバック`);
  } catch (e) {
    deps.log?.warn(`compaction: handoff LLM 例外 → フォールバック: ${(e as Error).message}`);
  }
  return redactHandoffSecrets(fallbackHandoff(currentTask, recentContext));
}

/**
 * コンパクションを実行する。 生成 → 投稿 → /clear → 再投入。
 */
export async function runCompaction(deps: CompactionDeps, sessionId: string): Promise<CompactionResult> {
  const session = deps.sessions.findSession(sessionId);
  if (!session) return { ok: false, error: "session not found" };
  if (session.status !== "active") return { ok: false, error: `session is ${session.status}` };

  const currentTask = session.current_task ?? "";

  // 0) handoff は **セッション自身に書かせる** (session-end 相当)。 実作業を行った当人が
  //    フルコンテキストで書くため、 切り離し要約のような計画/実状の乖離が起きない。
  //    inject 前の transcript 最大 id を watermark にし、 以後の assistant 地の文を捕捉する。
  let handoff = "";
  let watermark = 0;
  try {
    watermark = deps.transcriptLogs.maxId(sessionId);
  } catch (e) {
    deps.log?.warn(`compaction: watermark 取得失敗 session=${sessionId}: ${(e as Error).message}`);
  }
  const askedOk = await deps.inject(sessionId, buildSessionEndHandoffPrompt(currentTask), "compaction-handoff-request");
  await deps.inject(sessionId, ENTER_KEY_TEXT, "compaction-handoff-request-enter");
  if (askedOk) {
    const captured = await elicitHandoffFromSession(deps, sessionId, watermark);
    if (captured) handoff = captured;
  }

  // フォールバック (無言で空にしない): 捕捉失敗時は従来の切り離し生成に切替える。
  if (!handoff) {
    deps.log?.warn(`compaction: セッション自筆 handoff の捕捉失敗 → 切り離し生成にフォールバック session=${sessionId}`);
    const recent = collectRecentContext(deps.transcriptLogs, sessionId);
    handoff = await generateHandoff(deps, currentTask, recent);
  }

  // 1) チャンネルへ投稿 (= 活かす durable ログ)。 失敗しても続行はするが警告。
  try {
    await deps.postHandoff(sessionId, `📌 **引き継ぎ資料 (コンパクション)**\n\n${handoff}`);
  } catch (e) {
    deps.log?.warn(`compaction: handoff 投稿失敗 session=${sessionId}: ${(e as Error).message}`);
  }

  // 2) /clear を inject (TUI スラッシュコマンド + Enter)。
  const clearedOk = await deps.inject(sessionId, "/clear", "compaction-clear");
  await deps.inject(sessionId, ENTER_KEY_TEXT, "compaction-clear-enter");
  if (!clearedOk) {
    deps.log?.warn(`compaction: /clear inject 失敗 session=${sessionId}`);
    return { ok: false, handoff, error: "/clear inject failed" };
  }

  // 3) clear の反映を待つ。
  const wait = deps.clearWaitMs ?? CLEAR_WAIT_MS;
  if (wait > 0) await (deps.sleep ?? defaultSleep)(wait);

  // 4) 引き継ぎを読んで続行するよう再投入 (資料本文も冗長化のため同梱)。
  const reinjected = await deps.inject(sessionId, `${REINJECT_HEADER}${handoff}`, "compaction-reinject");
  await deps.inject(sessionId, ENTER_KEY_TEXT, "compaction-reinject-enter");
  if (!reinjected) {
    deps.log?.warn(`compaction: 再投入 inject 失敗 session=${sessionId}`);
    return { ok: false, handoff, error: "reinject failed" };
  }

  // 5) コンパクション時刻と直近 handoff を記録する (時刻は auto-compaction の
  //    クールダウン判定、 handoff はフェーズ文脈索引 — phase-compaction §2 参照層)。
  try {
    deps.sessions.mergeMetadata(sessionId, {
      last_compaction_at: Date.now(),
      last_handoff: handoff.slice(0, LAST_HANDOFF_METADATA_LIMIT),
    });
  } catch (e) {
    deps.log?.warn(`compaction: metadata 記録失敗 session=${sessionId}: ${(e as Error).message}`);
  }

  deps.log?.info(`compaction: done session=${sessionId} handoff_len=${handoff.length}`);
  return { ok: true, handoff };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * inject / postHandoff の実装 (eventBus + chat repo) を組む。 HTTP endpoint と
 * 自動コンパクションスケジューラの両方が同じ IO を使うための共有ヘルパ (DRY)。
 */
export function makeCompactionIO(deps: { sessions: SessionsRepo; chat: ChatRepo }): Pick<CompactionDeps, "inject" | "postHandoff"> {
  const nowSec = () => Math.floor(Date.now() / 1000);
  return {
    inject: async (sessionId, text, source) => {
      const ts = nowSec();
      eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source, author_label: null, ts });
      deps.sessions.appendEvent({ session_id: sessionId, ts, kind: "inject", payload: { text, source } });
      return true;
    },
    postHandoff: async (sessionId, markdown) => {
      const msg = deps.chat.insert({
        channel: "報告", session_id: sessionId, author_label: "Concordia (compaction)",
        text: markdown, in_reply_to: null, is_actionable: false, metadata: null,
      });
      eventBus.emit({
        type: "chat.posted", message_id: msg.id, channel: msg.channel, author_label: msg.author_label,
        session_id: msg.session_id, ts: msg.ts, is_actionable: false,
      });
    },
  };
}
