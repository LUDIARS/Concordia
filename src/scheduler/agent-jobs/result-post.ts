/**
 * 外部エージェントの結果を、 Cc が従来の出力先へ投稿する文に整える (result applier の文面、 純関数)。
 * 文面は信頼できない入力として扱う: mention 無効化・リンク展開なし・長さ上限 (CC-PT-AGENT-INV-04)。
 * 投稿の送信側でも allowedMentions を空にする (二重)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 結果の反映
 */

import { agentLabel, INSTRUCTION_POST_MAX_CHARS, neutralizeLine } from "../../agent-instructions/instruction-posts.js";
import { FALLBACK_CLOSE_SUMMARY, REPORT_ONLY_CLOSE_SUMMARY } from "../agent-dispatch-policy.js";
import type { AgentJobResultKind } from "./types.js";

const SUMMARY_CHARS = 400;
const ITEM_CHARS = 200;
const MAX_ITEMS = 10;

export interface AgentJobResultView {
  jobName: string;
  title: string;
  agent: string;
  status: "done" | "failed";
  summary: string;
  /** canonical JSON (保存値)。 */
  detail: unknown;
  instructionId: string;
  application?: boolean;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function itemsOf(detail: unknown): string[] {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return [];
  const items = (detail as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (typeof item === "string" ? item : item !== null && typeof item === "object" ? JSON.stringify(item) : String(item)))
    .filter((item) => item.trim() !== "");
}

function idCode(id: string): string {
  return `\`${id.replace(/`/gu, "")}\``;
}

export function buildAgentJobResultPost(kind: AgentJobResultKind, view: AgentJobResultView): string {
  const who = agentLabel(view.agent);
  const title = neutralizeLine(view.title, 200);
  if (view.status === "failed") {
    return clip(`❌ **${title}** — ${who} が失敗: ${neutralizeLine(view.summary, SUMMARY_CHARS)} ${idCode(view.instructionId)}`, INSTRUCTION_POST_MAX_CHARS);
  }
  const items = itemsOf(view.detail);
  const lines = [
    `🤖 **${title}** — ${who} の${kind} ${idCode(view.instructionId)}`,
    `> ${neutralizeLine(view.summary, SUMMARY_CHARS)}`,
    ...items.slice(0, MAX_ITEMS).map((item) => `- ${neutralizeLine(item, ITEM_CHARS)}`),
    ...(items.length > MAX_ITEMS ? [`- …ほか ${items.length - MAX_ITEMS} 件`] : []),
    ...(view.application ? [] : ["書き込み・PR はしていません (提案の投稿まで)。"]),
  ];
  return clip(lines.join("\n"), INSTRUCTION_POST_MAX_CHARS);
}

/** 期限切れで Cc の委託へ戻した事実の投稿。 */
export function buildFallbackPost(input: { title: string; agent: string; instructionId: string; invoked: boolean; error?: string }): string {
  const who = agentLabel(input.agent);
  const outcome = input.invoked
    ? "元の委託を起動しました。"
    : `元の委託の起動に失敗しました: ${neutralizeLine(input.error ?? "不明", 200)}`;
  return clip(
    `↩️ **${neutralizeLine(input.title, 200)}** — ${who} 宛ての指令 ${idCode(input.instructionId)} は${FALLBACK_CLOSE_SUMMARY}。 ${outcome}`,
    INSTRUCTION_POST_MAX_CHARS,
  );
}

export function buildReportOnlyExpiryPost(
  record: { title: string; agent: string; id: string; params: unknown },
  job: string,
): string {
  const data = (record.params as { data?: { sweep_status?: unknown; failure_kind?: unknown; fetched?: unknown } } | null)?.data;
  const status = data?.sweep_status;
  const mail = job === "quaestor-mail-sweep"
    ? ` メール取り込み: ${status === "completed" ? `実行済み (取得 ${typeof data?.fetched === "number" ? data.fetched : "不明"} 件)`
      : status === "disabled" ? "無効" : status === "failed" ? "失敗" : "結果不明"}。`
    : "";
  return `⏳ **${neutralizeLine(record.title, 200)}** — ${agentLabel(record.agent)} 宛ての指令 ${idCode(record.id)} は${REPORT_ONLY_CLOSE_SUMMARY}。${mail}`;
}
