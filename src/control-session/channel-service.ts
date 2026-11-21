/**
 * 管制チャンネルへの人間の投稿を処理する (Discord 非依存)。一括指示は対象を絞って届け、
 * それ以外は側セッションが進捗ボードを読んで答える。
 *
 * @implements spec/feature/control-session.md — 3. 管制チャンネルと側セッション / CC-CTL-INV-03 / CC-CTL-INV-05
 */
import type { SessionRow } from "../shared/types.js";
import type { ControlBoardRowWithLink } from "./session-link.js";
import { parseBulkCommand } from "./bulk-command.js";
import { INELIGIBLE_REASON_LABEL } from "./instruction-eligibility.js";
import type { DispatchResult, InstructionOrigin } from "./instruction-dispatch.js";
import type { SideDialogueResult } from "./side-dialogue.js";

export interface ControlChannelPost {
  actorLabel: string;
  /** 社員名簿でセッション操作を許可された人か。 */
  allowed: boolean;
  content: string;
}

export interface ControlChannelDeps {
  isEnabled(): boolean;
  activeSessions(): SessionRow[];
  projectOf(session: SessionRow): string;
  isControlSession(session: SessionRow): boolean;
  boardRows(): ControlBoardRowWithLink[];
  dispatch(input: { targets: string[]; text: string; origin: InstructionOrigin }): Promise<DispatchResult>;
  answer(input: { rows: ControlBoardRowWithLink[]; question: string; nowSec: number }): Promise<SideDialogueResult>;
  nowSec(): number;
}

export function renderDispatchSummary(result: DispatchResult): string {
  const lines = [`届けた: ${result.delivered.length} 件`];
  const counts = new Map<string, number>();
  for (const skip of result.skipped) {
    const label = skip.reason === "undeliverable" ? "届けられない" : INELIGIBLE_REASON_LABEL[skip.reason];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  for (const [label, count] of counts) lines.push(`送らなかった (${label}): ${count} 件`);
  return lines.join("\n");
}

export async function handleControlChannelPost(deps: ControlChannelDeps, post: ControlChannelPost): Promise<string> {
  if (!deps.isEnabled()) return "管制は OFF です (設定 session.control_session_enabled)。";
  if (!post.allowed) return "管制チャンネルはセッション操作を許可された人だけが使えます。";
  const content = post.content.trim();
  if (!content) return "質問か「一括: 指示」を書いてください。";
  const bulk = parseBulkCommand(content);
  if (bulk) {
    const wanted = new Set(bulk.projectCodes.map((code) => code.toLowerCase()));
    const targets = deps.activeSessions()
      .filter((s) => !deps.isControlSession(s))
      .filter((s) => wanted.size === 0 || wanted.has(deps.projectOf(s).toLowerCase()))
      .map((s) => s.id);
    if (!targets.length) return "対象のセッションがありません。";
    const result = await deps.dispatch({ targets, text: bulk.text, origin: { kind: "human", label: post.actorLabel } });
    return ["一括指示を送りました。", renderDispatchSummary(result)].join("\n");
  }
  const answer = await deps.answer({ rows: deps.boardRows(), question: content, nowSec: deps.nowSec() });
  if (answer.ok) return answer.reply;
  return answer.reason === "busy"
    ? "いま別の確認に答えています。少し待ってからもう一度投稿してください。"
    : "回答を作れませんでした。もう一度投稿するか、GET /v1/control/board を確認してください。";
}
