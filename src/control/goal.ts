/**
 * セッションごとの「ゴール」。作業モード・確認頻度・完了判定を表示/分類する。
 *
 * 保存先は sessions.metadata JSON の `goal` キー (schema 列は足さない)。
 * 既定は `complete` (完成まで実装)。 ユーザが無指定なら既定がそのまま使われる。
 *
 * SRP: ゴールの型 + 自然文解釈 + metadata 読み書き(純粋マージ) + 表示/述語のみ。
 * DB 反映 (setMetadata) は呼び出し側、 /co-goal の UI は discord/commands/goal.ts。
 */

export type GoalMode = "complete" | "scoped" | "watch";

export interface Goal {
  /** complete=完成まで / scoped=範囲限定 / watch=様子見(確認しながら)。 */
  mode: GoalMode;
  /** 範囲や条件の自由文 (例「月内目標 #441 まで」)。未指定は undefined。 */
  text?: string;
}

export const DEFAULT_GOAL: Goal = { mode: "complete" };

const MODE_KEYWORDS: Array<readonly [GoalMode, RegExp]> = [
  ["watch", /様子見|確認しながら|都度確認|慎重|watch|step.?by.?step/i],
  ["scoped", /範囲限定|範囲|月内|今月|目標まで|ここまで|scoped|まで(?:やる|で)/i],
  ["complete", /完成|完了まで|最後まで|全部|フル|complete|done/i],
];

/** 自由文 / 選択値から GoalMode を推定。 該当キーワードが無ければ null。 */
export function coerceGoalMode(raw: string | null | undefined): GoalMode | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === "complete" || s === "scoped" || s === "watch") return s;
  for (const [mode, re] of MODE_KEYWORDS) {
    if (re.test(s)) return mode;
  }
  return null;
}

/**
 * /co-goal の入力 (明示 mode 任意 + 自由文 text 任意) を Goal に正規化する。
 *  - mode 明示があればそれを採用。
 *  - mode 無しで text から推定できればそれを採用。
 *  - どちらも無ければ既定 complete。
 * text は範囲条件として常に保持する (推定に使った文面もそのまま残す)。
 */
export function parseGoalInput(input: { mode?: string | null; text?: string | null }): Goal {
  const text = input.text?.trim() || undefined;
  const explicit = coerceGoalMode(input.mode);
  const mode = explicit ?? coerceGoalMode(text ?? null) ?? DEFAULT_GOAL.mode;
  return text ? { mode, text } : { mode };
}

function isGoal(v: unknown): v is Goal {
  if (typeof v !== "object" || v === null) return false;
  const m = (v as { mode?: unknown }).mode;
  return m === "complete" || m === "scoped" || m === "watch";
}

/** metadata JSON 文字列から goal を読む。 未設定/壊れていれば既定 complete。 */
export function readGoalFromMetadata(metadata: string | null | undefined): Goal {
  if (!metadata) return DEFAULT_GOAL;
  try {
    const o = JSON.parse(metadata) as { goal?: unknown };
    return isGoal(o.goal) ? normalizeGoal(o.goal) : DEFAULT_GOAL;
  } catch {
    return DEFAULT_GOAL;
  }
}

function normalizeGoal(g: Goal): Goal {
  const text = typeof g.text === "string" && g.text.trim() ? g.text.trim() : undefined;
  return text ? { mode: g.mode, text } : { mode: g.mode };
}

/**
 * 既存 metadata JSON に goal をマージして新しい JSON 文字列を返す (純粋 RMW)。
 * role_label など既存キーは保持する。 壊れた metadata は破棄して再構築。
 */
export function mergeGoalIntoMetadata(metadata: string | null | undefined, goal: Goal): string {
  let base: Record<string, unknown> = {};
  if (metadata) {
    try {
      const o = JSON.parse(metadata);
      if (o && typeof o === "object") base = o as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, goal: normalizeGoal(goal) });
}

const MODE_LABEL: Record<GoalMode, string> = {
  complete: "完成まで実装",
  scoped: "範囲限定",
  watch: "様子見 (確認しながら)",
};

/** 人間向けの 1 行表示。 例「完成まで実装」「範囲限定: 月内目標 #441」。 */
export function describeGoal(goal: Goal): string {
  const base = MODE_LABEL[goal.mode];
  if (goal.mode === "scoped" && goal.text) return `${base}: ${goal.text}`;
  if (goal.text) return `${base} (${goal.text})`;
  return base;
}

/** 状態カード用バッジ。 例「🎯 完成まで実装」。 */
export function formatGoalBadge(goal: Goal): string {
  return `🎯 ${describeGoal(goal)}`;
}
