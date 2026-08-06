/**
 * セッション要約時に「人間が拾うべき2種」を Sonnet で検出する (④ サマリー検出)。
 *  - blocked: ハーネス/権限でブロックされ未完了の事項 (何が・なぜ止まったか)。
 *  - needsHuman: 人間の判断/確認が要る事項 (方針割れ・破壊的操作・本番影響・仕様曖昧 等)。
 *
 * session-end レポート (report/generator.ts) に別建てセクションとして載せ、 needsHuman が
 * あれば起因者を @メンションして気付かせる (end-session-flow.ts)。
 *
 * 検出は session の transcript/events から Sonnet narrative 抽出 (best-effort)。
 * 失敗/無効時は空 (無言フォールバック禁止: 失敗は warn ログに出し、 空のまま続行)。
 *
 * SRP: 検出 (Sonnet I/O) + JSON 解釈 + markdown 描画 (純粋) のみ。 通知/配線は呼び出し側。
 */

import type { SessionEventRow, SessionRow } from "../shared/types.js";
import type { HarnessAuditRow } from "../db/harness-audit-repo.js";
import { runClaude } from "../rules/claude-runner.js";
import { createChildLogger } from "../shared/logger.js";
import {
  buildSummaryEventExcerpt,
  type SummaryQuestionStateReader,
} from "./summary-event-excerpt.js";

const log = createChildLogger("summary-flags");

export interface SummaryFlags {
  /** ハーネス/権限でブロックされ未完了の事項。 */
  blocked: string[];
  /** 人間の判断/確認が要る事項。 */
  needsHuman: string[];
}

export const EMPTY_FLAGS: SummaryFlags = { blocked: [], needsHuman: [] };

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) out.push(x.trim().slice(0, 500));
  }
  return out;
}

/** Sonnet 出力テキストから {blocked, needsHuman} を解釈する (fence / 素 JSON 両対応)。 */
export function parseSummaryFlags(text: string): SummaryFlags | null {
  let parsed: unknown;
  parsed = safeParse(text.trim());
  if (typeof parsed === "string") {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fence) parsed = safeParse(fence[1].trim());
  }
  if (typeof parsed === "string") {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) parsed = safeParse(m[0]);
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as { blocked?: unknown; needsHuman?: unknown };
  return { blocked: asStringList(o.blocked), needsHuman: asStringList(o.needsHuman) };
}

/** 複数ソースの flags を結合し重複排除する (将来: 決定論ソースとの merge 用)。 */
export function mergeFlags(...all: SummaryFlags[]): SummaryFlags {
  const dedup = (xs: string[]) => [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
  return {
    blocked: dedup(all.flatMap((f) => f.blocked)),
    needsHuman: dedup(all.flatMap((f) => f.needsHuman)),
  };
}

/** 何か検出されているか。 */
export function hasFlags(f: SummaryFlags): boolean {
  return f.blocked.length > 0 || f.needsHuman.length > 0;
}

/**
 * ハーネス監査の deny 行を blocked 文字列へ変換する (決定論ソース)。
 * Sonnet 検出と併用してブロック検出を確実にする。 重複は排除。
 * 例: "Bash rm -rf — RULE_CODE§7: 破壊的操作は要確認"。
 */
export function harnessDenyToBlocked(rows: HarnessAuditRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (r.decision !== "deny") continue;
    const what = [r.tool, r.action].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
    const why = r.reason?.trim() || r.rule?.trim() || "ハーネスでブロック";
    const s = (what ? `${what} — ${why}` : why).slice(0, 500);
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * session-end レポートに足す markdown 行 (見出し含む)。 空セクションは省く。
 * 両方空なら空配列。
 */
export function renderSummaryFlagsMarkdown(f: SummaryFlags): string[] {
  const lines: string[] = [];
  if (f.blocked.length) {
    lines.push("## 🚧 ハーネスによるブロック");
    for (const b of f.blocked) lines.push(`- ${b}`);
  }
  if (f.needsHuman.length) {
    if (lines.length) lines.push("");
    lines.push("## 🙋 人間に確認してほしいこと");
    for (const n of f.needsHuman) lines.push(`- ${n}`);
  }
  return lines;
}

/** 質問の正本状態を含む、summary classifier 用 prompt を組み立てる。 */
export function buildSummaryFlagsPrompt(
  session: SessionRow,
  events: SessionEventRow[],
  opts: { questionState?: SummaryQuestionStateReader } = {},
): string {
  const compact = buildSummaryEventExcerpt(events, { questionState: opts.questionState });
  const completedQuestions = compact.filter((event) => event.kind === "question_completed");
  const ordinaryEvents = compact.filter((event) => event.kind !== "question_completed");

  return [
    "あなたはセッションログを精査し、 人間が拾うべき 2 種を抽出する分類器です。",
    "出力は **JSON のみ**。 前置き / code fence なし。",
    "",
    "## 出力スキーマ",
    `{"blocked": ["<ハーネス/権限でブロックされ未完了の事項>", ...], "needsHuman": ["<人間の判断/確認が要る事項>", ...]}`,
    "",
    "## 判定基準",
    "- blocked: ハーネス強制ゲート・権限拒否・分類器ブロック等で **実行できず未完了** になった操作。",
    "  「何を」「なぜ止まったか」 を 1 項目 1 行で簡潔に。 該当無しは空配列。",
    "- needsHuman: 方針が割れる / 破壊的操作 / 本番影響が不明 / 仕様が曖昧 等、 AI が決め打ちせず",
    "  **人間の判断/確認を仰ぐべき** 事項。 該当無しは空配列。",
    "- question_completed は質問状態の正本または回答イベントに基づく **解決済み証跡**。",
    "  同じ question_id の古い prompt / inject が未回答と述べていても needsHuman に含めない。",
    "- 通常完了した作業・単なる進捗は **含めない**。 拾うべきものが無ければ両方空配列。",
    "",
    "## 入力 (session events 抜粋)",
    JSON.stringify(
      {
        session: {
          id: session.id,
          repo: session.repo_origin ?? session.repo_path,
          branch: session.branch,
        },
        events: ordinaryEvents,
      },
      null,
      1,
    ).slice(0, 12_000),
    "",
    "## 解決済み質問 (入力末尾の正本。上の古い記述より優先)",
    JSON.stringify(completedQuestions, null, 1),
  ].join("\n");
}

/**
 * session の events から Sonnet でブロック/人間確認事項を抽出する (best-effort)。
 * CONCORDIA_DISABLE_CLAUDE=1 / 取得失敗 / 解釈不能なら空 (warn ログに出す)。
 */
export async function detectSummaryFlags(
  session: SessionRow,
  events: SessionEventRow[],
  opts: { questionState?: SummaryQuestionStateReader } = {},
): Promise<SummaryFlags> {
  if (process.env.CONCORDIA_DISABLE_CLAUDE === "1") return EMPTY_FLAGS;

  const prompt = buildSummaryFlagsPrompt(session, events, opts);

  const r = await runClaude(prompt, { model: "sonnet" });
  if (!r.ok) {
    log.warn({ session_id: session.id, stderr: r.stderr.slice(0, 200) }, "summary-flags Sonnet failed");
    return EMPTY_FLAGS;
  }
  const flags = parseSummaryFlags(r.stdout);
  if (!flags) {
    log.warn({ session_id: session.id, stdout: r.stdout.slice(0, 200) }, "summary-flags unparseable");
    return EMPTY_FLAGS;
  }
  return flags;
}
