/**
 * 管制チャンネルの状況確認に答える側セッション。投稿 1 回ごとに進捗ボードと質問だけを読む
 * 会話専用の 1 回限りの実行で、管制セッション本体の文脈には入れない。
 *
 * @implements spec/feature/control-session.md — 3. 管制チャンネルと側セッション / CC-CTL-INV-03
 */
import { SESSION_STATUS_LABEL } from "../control/session-classify.js";
import type { ControlBoardRowWithLink } from "./session-link.js";

export const SIDE_DIALOGUE_MAX_CONCURRENT = 2;
const BOARD_ROW_LIMIT = 60;
const QUESTION_LIMIT = 2000;
const REPLY_LIMIT = 1800;

export type OneShotRunner = (prompt: string) => Promise<{ ok: boolean; stdout: string }>;

export type SideDialogueResult =
  | { ok: true; reply: string }
  | { ok: false; reason: "busy" | "failed" };

function boardTable(rows: readonly ControlBoardRowWithLink[], nowSec: number): string {
  if (!rows.length) return "(動いているセッションはありません)";
  return rows.slice(0, BOARD_ROW_LIMIT).map((row) => {
    const idleMin = row.last_activity_at == null ? "不明" : `${Math.max(0, Math.round((nowSec - row.last_activity_at) / 60))} 分前`;
    return [
      `- ${row.project}${row.branch ? ` / ${row.branch}` : ""} [${row.session_id}]`,
      `分類=${row.status ? SESSION_STATUS_LABEL[row.status] : "未分類"}${row.status_reason ? ` (${row.status_reason})` : ""}`,
      `状態=${row.followup_state ?? "未確認"}`,
      `変化なし=${row.unchanged_count}`,
      `最後の会話=${idleMin}`,
      row.current_task ? `タスク=${row.current_task}` : null,
      row.side_summary ? `現況=${row.side_summary}` : null,
      row.link ? `リンク=<${row.link}>` : null,
    ].filter(Boolean).join(" / ");
  }).join("\n");
}

export function buildSideDialoguePrompt(input: { rows: readonly ControlBoardRowWithLink[]; question: string; nowSec: number }): string {
  return [
    "あなたは Concordia の管制の窓口です。下の進捗ボード (各セッションの最新 1 行) だけを根拠に、人間の質問へ日本語で短く答えてください。",
    "ボードに無いことは「ボードに無い」と答え、推測で完了・成功・許可を述べないでください。指示を送ることはできません (一括指示は「一括: 本文」で投稿するよう案内してください)。",
    "判断が必要なセッション (人間の判断待ち・停止・応答なし) を挙げるときは、ボードにリンクがあれば山括弧ごとそのまま添えてください。リンクを作らないでください。",
    `## 進捗ボード (${input.rows.length} 件)`,
    boardTable(input.rows, input.nowSec),
    "## 人間の質問",
    input.question.slice(0, QUESTION_LIMIT),
  ].join("\n\n");
}

/** 同時実行数を数えて上限を守る側セッションの実行器。 */
export function createSideDialogue(run: OneShotRunner, maxConcurrent = SIDE_DIALOGUE_MAX_CONCURRENT) {
  let running = 0;
  return {
    async answer(input: { rows: readonly ControlBoardRowWithLink[]; question: string; nowSec: number }): Promise<SideDialogueResult> {
      if (running >= maxConcurrent) return { ok: false, reason: "busy" };
      running += 1;
      try {
        const result = await run(buildSideDialoguePrompt(input));
        const reply = result.stdout.trim();
        if (!result.ok || !reply) return { ok: false, reason: "failed" };
        return { ok: true, reply: reply.length > REPLY_LIMIT ? `${reply.slice(0, REPLY_LIMIT - 1)}…` : reply };
      } catch {
        return { ok: false, reason: "failed" };
      } finally {
        running -= 1;
      }
    },
    get running(): number { return running; },
  };
}
