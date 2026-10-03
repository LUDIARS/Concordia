/**
 * 相談ログ (spec/feature/tech-consultation.md §6.2) の場所と中身を決める純関数。
 *
 * 2026-10-03 neco 指示:「相談内容は Consult フォルダにすべてログとして保存するようにしてください」「時刻は JST」。
 * 相談のセッションごとに、 相談者のデータフォルダの `logs/` に Markdown を 1 本書く。 中身は見出し (開始時刻・部署・
 * 役職・モデル)、 事前ヒアリング、 以後の「相談者の発言」と「最終回答」の時系列、 終了時刻と終了理由。
 * Cc の指令 (inject の転記)・途中の発言・ツール出力は書かない (投稿と同じ範囲、 CC-CONSULT-INV-10)。
 *
 * 書き込みは consult-log-writer.ts が行う。
 *
 * @implements SPEC-CONSULT-LOG
 */

import { join } from "node:path";
import type { SessionMessageAuthorType } from "../shared/session-message-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:5bae913c */
import augurContract_77d47953 from './consult-log-markdown.contract.js'; /* augur-inject:contract-predicate:cd7b9e81 */
import augurContract_2724378b from './consult-log-classify.contract.js'; /* augur-inject:contract-predicate:0d445a1c */
import augurContract_70719b19 from './consult-log-jst.contract.js'; /* augur-inject:contract-predicate:e927bd5b */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** Discord 以外からの起動 (相談者の ID が無い) のログの置き場所。 */
export const CONSULT_LOG_UNKNOWN_OWNER = "_unknown";
/** 人が書いた発言として残す入口 (Cc の指令や端末のキー入力は author_platform を持たない)。 */
const HUMAN_PLATFORMS: ReadonlySet<string> = new Set(["discord", "slack", "web"]);

/** 時刻を JST の `YYYY-MM-DD HH:mm:ss` で書く。 */
export function formatJstTimestamp(ms: number): string {
  const iso = new Date(ms + JST_OFFSET_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}
// @ts-expect-error augur-inject
formatJstTimestamp = contract(formatJstTimestamp, { ...augurContract_70719b19, contractId: 'consult-log-C-4', mode: 'observe', sample: 1, where: 'src/consultation/consult-log-markdown.ts:24', rule: 'contract-wrap', id: '70719b19' }); /* augur-inject:contract-wrap:70719b19 */

export interface ConsultLogPathInput {
  /** 相談の作業ディレクトリ (役職フォルダ)。 */
  roleWorkspace: string;
  /** 相談者の Discord の個人 ID。 無ければ `_unknown` に置く。 */
  requesterDiscordUserId: string | null;
  sessionId: string;
  /** セッションの開始時刻 (ms)。 ファイル名の日付 (JST) に使う。 */
  startedAtMs: number;
}

/** `<役職フォルダ>/<Discord ID か _unknown>/logs/<YYYY-MM-DD>_<session id>.md`。 */
export function consultLogFilePath(input: ConsultLogPathInput): string {
  const id = input.requesterDiscordUserId?.trim() ?? "";
  const owner = /^\d{5,32}$/.test(id) ? id : CONSULT_LOG_UNKNOWN_OWNER;
  // session id はファイル名に入るので、 パスを作れない文字を落とす。
  const session = input.sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
  const date = formatJstTimestamp(input.startedAtMs).slice(0, 10);
  return join(input.roleWorkspace, owner, "logs", `${date}_${session}.md`);
}
// @ts-expect-error augur-inject
consultLogFilePath = contract(consultLogFilePath, { ...augurContract_77d47953, contractId: 'consult-log-C-2', mode: 'observe', sample: 1, where: 'src/consultation/consult-log-markdown.ts:40', rule: 'contract-wrap', id: '77d47953' }); /* augur-inject:contract-wrap:77d47953 */

export interface ConsultLogMessage {
  author_type: SessionMessageAuthorType;
  author_platform: string | null;
  metadata?: { phase?: unknown } | null;
}

export type ConsultLogMessageKind = "requester" | "answer";

/** ログに残す発言か。 相談者の発言 = requester、 最終回答 = answer、 それ以外 (指令・途中・ツール) は null。 */
export function classifyConsultLogMessage(message: ConsultLogMessage): ConsultLogMessageKind | null {
  if (message.author_type === "user") {
    return message.author_platform !== null && HUMAN_PLATFORMS.has(message.author_platform) ? "requester" : null;
  }
  if (message.author_type === "summary") return "answer";
  if (message.author_type === "assistant" && message.metadata?.phase === "final_answer") return "answer";
  return null;
}
// @ts-expect-error augur-inject
classifyConsultLogMessage = contract(classifyConsultLogMessage, { ...augurContract_2724378b, contractId: 'consult-log-C-3', mode: 'observe', sample: 1, where: 'src/consultation/consult-log-markdown.ts:58', rule: 'contract-wrap', id: '2724378b' }); /* augur-inject:contract-wrap:2724378b */

export interface ConsultLogIntake {
  topic: string | null;
  skill_level: string | null;
  role_title: string | null;
  purpose: string | null;
}

export interface ConsultLogHeader {
  sessionId: string;
  startedAtMs: number;
  departmentName: string | null;
  roleFolder: string;
  model: string | null;
  intake: ConsultLogIntake | null;
}

function value(text: string | null | undefined): string {
  const trimmed = text?.trim() ?? "";
  return trimmed ? trimmed.replace(/\r?\n/g, " ") : "(未記入)";
}

/** ログの冒頭 (見出しと事前ヒアリング)。 */
export function renderConsultLogHeader(header: ConsultLogHeader): string {
  const lines = [
    "# 相談ログ",
    "",
    `- 開始: ${formatJstTimestamp(header.startedAtMs)} (JST)`,
    `- 部署: ${value(header.departmentName)}`,
    `- 役職: ${header.roleFolder}`,
    `- モデル: ${value(header.model)}`,
    `- セッション: ${header.sessionId}`,
    "",
    "## 事前ヒアリング",
    "",
  ];
  if (header.intake) {
    lines.push(
      `- 知りたいこと: ${value(header.intake.topic)}`,
      `- 技術レベル: ${value(header.intake.skill_level)}`,
      `- 役職: ${value(header.intake.role_title)}`,
      `- 目的: ${value(header.intake.purpose)}`,
    );
  } else {
    lines.push("(記録なし)");
  }
  lines.push("", "## やり取り", "", "");
  return lines.join("\n");
}

/** やり取り 1 件。 */
export function renderConsultLogEntry(kind: ConsultLogMessageKind, atMs: number, text: string): string {
  const label = kind === "requester" ? "相談者の発言" : "最終回答 (FINAL ANSWER)";
  return [`### ${formatJstTimestamp(atMs)} (JST) ${label}`, "", text.trim(), "", ""].join("\n");
}

/** 終了の記録。 */
export function renderConsultLogFooter(atMs: number, reason: string): string {
  return ["## 終了", "", `- 終了: ${formatJstTimestamp(atMs)} (JST)`, `- 理由: ${reason}`, ""].join("\n");
}
