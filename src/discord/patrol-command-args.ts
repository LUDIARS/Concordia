/**
 * 子会社サーバー管理者の `/patrol` の入力解釈と応答文 (spec/plan/2026-10-15-patrol-subsidiary-rules-design.md §3)。
 * Discord API に依存しない純関数だけを置く。
 */

/** "22:00-09:30" / "なし" / "既定" を解釈する。 */
export type QuietArg = { start: string; end: string } | null | "inherit";

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function pad(hhmm: string): string | null {
  const m = HHMM.exec(hhmm.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

export function parseQuietArg(text: string): QuietArg | { error: string } {
  const t = text.trim();
  if (["なし", "none", "off", "無し"].includes(t)) return null;
  if (["既定", "default", "inherit"].includes(t)) return "inherit";
  const parts = t.split(/[-〜~]/);
  if (parts.length === 2) {
    const start = pad(parts[0]);
    const end = pad(parts[1]);
    if (start && end) return { start, end };
  }
  return { error: "時間帯は「22:00-09:30」「なし」「既定」のどれかで指定してください" };
}

/** "<#123>" や生の ID から channel ID を取る。 */
export function channelIdOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(?:<#)?(\d{17,20})>?$/.exec(value.trim());
  return m ? m[1] : null;
}

export interface PatrolRuleView {
  id: string;
  enabled: boolean;
  tick_sec: number | null;
  instructions: string;
  action_config: Record<string, unknown> | null;
  effective_config: {
    root_limit_per_day: number;
    quiet_hours: { start: string; end: string } | null;
    discord_channel_id: string | null;
    persona_hint: string | null;
  } | null;
  readiness: { runnable: boolean; reason: string };
}

function quietText(q: { start: string; end: string } | null | undefined): string {
  return q ? `${q.start}〜${q.end} は新規投稿しない` : "時間帯なし";
}

/** 値の出どころ (rule で指定 / 子会社の既定値・全体の既定値を引き継ぎ)。 */
function origin(rule: PatrolRuleView, key: string): string {
  return rule.action_config && key in rule.action_config ? "" : " (既定)";
}

export function formatRule(rule: PatrolRuleView): string {
  const e = rule.effective_config;
  const lines = [
    `**${rule.id}** — ${rule.enabled ? "ON" : "OFF"}${rule.readiness.runnable || !rule.enabled ? "" : ` (動けません: ${rule.readiness.reason})`}`,
    `間隔 ${Math.round((rule.tick_sec ?? 0) / 60)} 分 · 1日 ${e?.root_limit_per_day ?? "?"} 件まで${origin(rule, "root_limit_per_day")}`,
    `${quietText(e?.quiet_hours)}${origin(rule, "quiet_hours")}`,
    `投稿先 ${e?.discord_channel_id ? `<#${e.discord_channel_id}>` : "未設定"}${origin(rule, "discord_channel_id")}`,
  ];
  if (e?.persona_hint) lines.push(`名前の雰囲気 ${e.persona_hint}${origin(rule, "persona_hint")}`);
  lines.push(`指示: ${rule.instructions.slice(0, 120)}`);
  return lines.join("\n");
}

export interface PatrolDefaultsView {
  defaults: {
    quiet_hours?: { start: string; end: string } | null;
    root_limit_per_day?: number;
    discord_channel_id?: string | null;
    persona_hint?: string | null;
    paused?: boolean;
    topic_keywords?: string[];
  };
  updated_by: string | null;
}

/** 「TGS, リズムゲーム、ローグライト」を関心キーワードの配列にする。 「なし」で空。 */
export function parseKeywordsArg(text: string): string[] {
  if (["なし", "none", "既定"].includes(text.trim())) return [];
  return [...new Set(text.split(/[,、\n]+/).map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 40))].slice(0, 50);
}

export function formatDefaults(view: PatrolDefaultsView): string {
  const d = view.defaults;
  return [
    "**このサーバーの巡回チャットの既定値**",
    `停止: ${d.paused ? "止めています (返信も含めて動きません)" : "動いています"}`,
    `時間帯: ${d.quiet_hours === undefined ? "未設定 (時間帯なし)" : quietText(d.quiet_hours)}`,
    `1日の上限: ${d.root_limit_per_day ?? "未設定 (8 件)"}`,
    `投稿先: ${d.discord_channel_id ? `<#${d.discord_channel_id}>` : "未設定"}`,
    `名前の雰囲気: ${d.persona_hint ?? "未設定"}`,
    `関心キーワード: ${d.topic_keywords?.length ? d.topic_keywords.join("、") : "未設定"}`,
    ...(view.updated_by ? [`最終更新: ${view.updated_by}`] : []),
  ].join("\n");
}

/** 既定値の更新: 指定された項目だけを差し替える。 "既定" (inherit) は項目を消す。 */
export function mergeDefaults(
  current: PatrolDefaultsView["defaults"],
  input: {
    quiet?: QuietArg;
    rootLimit?: number | null;
    channelId?: string | null;
    persona?: string | null;
    paused?: boolean | null;
    keywords?: string[] | null;
  },
): PatrolDefaultsView["defaults"] {
  const next: Record<string, unknown> = { ...current };
  if (input.quiet !== undefined) {
    if (input.quiet === "inherit") delete next.quiet_hours;
    else next.quiet_hours = input.quiet;
  }
  if (input.rootLimit !== undefined && input.rootLimit !== null) next.root_limit_per_day = input.rootLimit;
  if (input.channelId !== undefined && input.channelId !== null) next.discord_channel_id = input.channelId;
  if (input.persona !== undefined && input.persona !== null) {
    if (["既定", "なし", "none"].includes(input.persona.trim())) delete next.persona_hint;
    else next.persona_hint = input.persona.trim().slice(0, 80);
  }
  if (input.paused !== undefined && input.paused !== null) next.paused = input.paused;
  if (input.keywords !== undefined && input.keywords !== null) {
    if (input.keywords.length === 0) delete next.topic_keywords;
    else next.topic_keywords = input.keywords;
  }
  return next as PatrolDefaultsView["defaults"];
}
