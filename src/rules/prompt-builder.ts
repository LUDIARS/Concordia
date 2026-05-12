/**
 * Rule firing 用の prompt builder.
 *
 * - 現在の Concordia 状態 (active sessions / 直近 chat / 直近 rule_log) を context に同梱
 * - rule の instructions を主指示として
 * - JSON 出力フォーマットを必須化
 */

import type { RuleRow } from "../db/rules-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import type { RulesRepo } from "../db/rules-repo.js";

export function buildPrompt(args: {
  rule: RuleRow;
  sessions: SessionsRepo;
  chat: ChatRepo;
  rules: RulesRepo;
  triggered_by?: string; // "tick" or "event:edit" 等
}): string {
  const active = args.sessions.listSessions({ status: "active" }).slice(0, 8);
  const recentChat = args.chat.list({ limit: 10 });
  const recentLogs = args.rules.recentLogs(10);
  const enabledRules = args.rules.list({ enabled: true });

  const ctx = {
    now_iso: new Date().toISOString(),
    triggered_by: args.triggered_by ?? args.rule.trigger_type,
    active_sessions: active.map((s) => ({
      id: s.id.slice(0, 8),
      provider: s.provider,
      branch: s.branch,
      role: tryParseRole(s.metadata),
      last_seen_sec_ago: Math.floor(Date.now() / 1000) - s.last_seen_at,
    })),
    recent_chat: recentChat.map((m) => ({
      ts_sec_ago: Math.floor(Date.now() / 1000) - m.ts,
      channel: m.channel,
      author: m.author_label,
      text: m.text.slice(0, 80),
    })),
    enabled_rules: enabledRules.map((r) => ({ id: r.id, trigger: r.trigger_type, desc: r.description })),
    recent_rule_actions: recentLogs.map((l) => ({
      ts_sec_ago: Math.floor(Date.now() / 1000) - l.ts,
      action: l.action,
      rule_id: l.rule_id,
      detail: l.detail?.slice(0, 80),
      actor: l.actor,
    })),
  };

  return [
    "あなたは Concordia (LUDIARS multi-agent session coordinator) のチャット司会 AI です.",
    "**rule = チャット発言フック (どんな状況でどの channel に何を投稿するかのトリガ). rule 自体の生成 / 削除メタ管理ではない.**",
    "以下の Concordia 状態を見て、 rule の指示に沿って 1 つだけ action を返してください.",
    "出力は JSON 1 つだけ。 余計な前置き / コードフェンスなし.",
    "",
    "## 利用可能な action (主用途は post / skip)",
    `1. {"action":"post","channel":"chitchat" | "consultation" | "<new>","text":"<one or two sentences>","reasoning":"<brief>"} — chat に投稿 ★ メイン`,
    `2. {"action":"skip","reasoning":"<why no post>"} — 投稿不要と判断 ★ メイン`,
    `3. {"action":"add_rule",...} — どうしても新発言パターンが必要な時のみ. メタ管理ではない.`,
    `4. {"action":"remove_rule",...} — 重複 / 壊れている rule を見つけた時のみ. 通常は触らない.`,
    "",
    "## ルール (本回呼ばれた rule)",
    JSON.stringify({
      id: args.rule.id,
      trigger_type: args.rule.trigger_type,
      tick_sec: args.rule.tick_sec,
      event_kind: args.rule.event_kind,
      target: args.rule.target,
      instructions: args.rule.instructions,
    }, null, 2),
    "",
    "## 現在の状況",
    JSON.stringify(ctx, null, 2),
    "",
    "## 重要な制約",
    "- 同じ内容を chitchat と consultation 両方に投稿することは禁止。 どちらか 1 つを選ぶか skip.",
    "- AI 同士の対話前提なので、 人間に対する配慮は不要。 短く軽く.",
    "- 直近 chat と内容が重複するなら skip すること.",
    "- 出力は必ず JSON 1 つだけ.",
  ].join("\n");
}

function tryParseRole(metadata: string | null): string {
  if (!metadata) return "雑用係";
  try {
    const m = JSON.parse(metadata) as { role_label?: string };
    return m.role_label ?? "雑用係";
  } catch { return "雑用係"; }
}
