/**
 * 専用セッションへ送る確認・通知の文面 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 5. 1 時間ごとの確認 / 6. 終わり方
 *
 * 文面はゴール文・受入条件・許可範囲・Actio task ID・締切と、 Cc が集めた証跡だけから作る。
 * セッション外のタスクを持ち込ませない。
 */

import { PERMISSION_KEYS, PERMISSION_LABELS, type DailyGoal, type GoalPermissions } from "./domain.js";

export const DAILY_GOAL_INJECT_SOURCE = "auto:daily-goal-run";

export function describePermissions(permissions: GoalPermissions): string {
  return PERMISSION_KEYS.map((key) => `${PERMISSION_LABELS[key]}=${permissions[key] ? "可" : "不可"}`).join(" / ");
}

export function describeActioTasks(ids: readonly string[]): string {
  return ids.length ? ids.map((id) => `actio:${id}`).join(", ") : "なし";
}

function goalHeader(goal: DailyGoal): string[] {
  return [
    `デイリーゴール: ${goal.goalText}`,
    "受入条件:",
    ...goal.acceptance.map((item, index) => `  ${index + 1}. ${item}`),
    `対応する Actio task: ${describeActioTasks(goal.actioTaskIds)}`,
    `許可範囲: ${describePermissions(goal.permissions)} (許可に無い操作は ask で聞いて止まる)`,
  ];
}

function reportApis(goal: DailyGoal, baseUrl: string): string[] {
  return [
    `- 到達の報告: POST ${baseUrl}/v1/daily-goals/${goal.id}/reached`,
    '  body {"session_id":"<自分>","evidence":[{"item":"<受入条件の文>","refs":["pr:<origin>#<n>:merged","commit:<sha>","actio:<id>:done"]}]}',
    `- 十分にこなした (残りの報告): POST ${baseUrl}/v1/daily-goals/${goal.id}/exhausted`,
    '  body {"session_id":"<自分>","remaining":[{"item":"…","class":"unachievable","reason":"…"} | {"item":"…","class":"human_judgment","question_id":123} | {"item":"…","class":"human_judgment","human_wait":true} | {"item":"…","class":"doable"}]}',
    "- AI だけで進められる残りが 1 件でもあれば「十分にこなした」は認められず、続行 (GO) が返る。",
  ];
}

/** 進捗ありの確認。 */
export function buildProgressCheckPrompt(goal: DailyGoal, newEvidence: readonly string[], baseUrl: string): string {
  return [
    `[Concordia daily-goal-run 進捗確認 ${goal.id}]`,
    ...goalHeader(goal),
    `前回の確認以降に Cc が確認した証跡: ${newEvidence.slice(0, 20).join(", ")}`,
    "次の形で返答してから、そのまま作業を続けてください。",
    "  進み具合: 受入条件ごとに 完了 / 作業中 / 未着手",
    "  次の 1 時間でやること: 箇条書き",
    "  人間判断が要る点: 無ければ「なし」 (要るなら ask で聞いて止まる)",
    "ゴールの範囲だけで作業し、セッション外のタスク (Actio の他の task、git diff の残りなど) を持ち込まないでください。",
    ...reportApis(goal, baseUrl),
  ].join("\n");
}

/** 進捗なしの確認 (完了確認)。 進捗なしでも止めず、受入条件と task ごとに完了を確かめさせる。 */
export function buildCompletionCheckPrompt(goal: DailyGoal, baseUrl: string): string {
  return [
    `[Concordia daily-goal-run 完了確認 ${goal.id}]`,
    ...goalHeader(goal),
    "前回の確認以降、Cc が確認できた新しい証跡 (commit / PR / Actio task の状態変化) はありません。止めずに、次を確かめてください。",
    "受入条件と対応する Actio task の一つずつについて、完了しているか・残りは何かを書いてください。",
    "  - すべて完了している → 到達の報告 API に、受入条件ごとの証跡を付けて送る。",
    "  - AI だけで進められる残りがある → その残りを次の 1 時間でやることとして書き、続行する (残りの報告 API に doable として送ると予算が戻る)。",
    "  - 残りがすべて達成不能か人間判断待ち → 残りの報告 API に一覧を送る。",
    ...reportApis(goal, baseUrl),
  ].join("\n");
}

export function buildGoAfterRejectionPrompt(goal: DailyGoal, reason: string): string {
  return [
    `[Concordia daily-goal-run 続行 ${goal.id}]`,
    `報告は止まる条件に当たりませんでした: ${reason}`,
    "ゴールの範囲で、AI だけで進められる残りを続けてください。",
  ].join("\n");
}

export function buildStoppedNotice(goal: DailyGoal, status: "achieved" | "exhausted" | "stopped" | "deadline"): string {
  const reason = status === "achieved"
    ? "受入条件の証跡がそろい、ゴール到達を確認しました。"
    : status === "exhausted"
      ? "残りが達成不能か人間判断待ちだけであることを確認しました (やり切り)。"
      : status === "deadline"
        ? "締切 (翌朝の業務日の境界) に達しました。新しい作業を始めず、到達した受入条件と残りは Cc の日のまとめに載ります。"
        : "人間がこのデイリーゴールを停止しました。新しい作業を始めないでください。";
  return [
    `[Concordia daily-goal-run 終了 ${goal.id}]`,
    reason,
    "作業中の結果を保全し、既存の session-end 手順で終了してください。残りを翌日のゴールへ自動で持ち越さないでください。",
  ].join("\n");
}
