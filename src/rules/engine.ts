/**
 * Rule engine.
 *
 * - 1 秒ごとに rules を見て、 trigger=tick で last_fired_at から tick_sec 以上経った rule を発火
 * - event 発火は eventBus 購読で受ける (trigger=event の rule)
 * - 並列実行は禁止 (claude CLI invocation は重い & コンテキスト混ざるとよくない)
 *   → mutex 1 つだけ. 走行中は他 rule は queue せずに skip
 */

import type { RulesRepo, RuleRow } from "../db/rules-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import { eventBus } from "../events.js";
import { runClaude, extractJson } from "./claude-runner.js";
import { buildPrompt } from "./prompt-builder.js";
import { handleAction } from "./handler.js";
import { createChildLogger } from "../shared/logger.js";
import { actionFrequencyMultiplier } from "../shared/quiet-hours.js";

const log = createChildLogger("rule-engine");
const ENGINE_TICK_MS = 1000;

export interface EngineDeps {
  rules: RulesRepo;
  sessions: SessionsRepo;
  chat: ChatRepo;
  /** dry-run 用. true で claude CLI を呼ばずスキップ (テスト・デバッグ) */
  disable_claude?: boolean;
}

export interface EngineHandle {
  stop: () => void;
  fireOnce: (rule: RuleRow, triggered_by: string) => Promise<void>;
}

export function startRuleEngine(deps: EngineDeps): EngineHandle {
  let running = false;
  let unsubEvent: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  // event-driven rules
  unsubEvent = eventBus.subscribe(async (ev) => {
    if (stopped) return;
    if (ev.type === "ping") return;
    const eventKind = ev.type;
    const candidates = deps.rules.list({ enabled: true, trigger_type: "event" })
      .filter((r) => !r.event_kind || r.event_kind === eventKind || matchesEvent(r.event_kind, eventKind));
    if (candidates.length === 0) return;
    // 強制ルール: 深夜帯 (23:00–翌05:00) は event rule の発火も 1/10 に間引く.
    const freq = actionFrequencyMultiplier();
    if (freq < 1 && Math.random() >= freq) {
      for (const r of candidates) {
        deps.rules.log({ rule_id: r.id, action: "skip", actor: "engine", detail: "quiet hours throttle" });
      }
      return;
    }
    for (const r of candidates) {
      await tryFire(r, `event:${eventKind}`);
    }
  });

  // tick timer
  timer = setInterval(async () => {
    if (stopped) return;
    const now = Math.floor(Date.now() / 1000);
    // 強制ルール: 深夜帯 (23:00–翌05:00) は tick の発火間隔を 1/freq 倍に伸ばす
    // (= 行動頻度 1/10). 昼帯は freq=1 で間隔は据え置き.
    const freq = actionFrequencyMultiplier();
    const ticks = deps.rules.list({ enabled: true, trigger_type: "tick" });
    for (const r of ticks) {
      if (!r.tick_sec) continue;
      const elapsed = r.last_fired_at ? now - r.last_fired_at : Infinity;
      if (elapsed >= r.tick_sec / freq) {
        await tryFire(r, "tick");
      }
    }
  }, ENGINE_TICK_MS);

  log.info({ tickMs: ENGINE_TICK_MS }, "rule engine started");

  async function tryFire(rule: RuleRow, triggeredBy: string): Promise<void> {
    if (running) {
      // 並列禁止: 既に走行中なら skip ログだけ
      deps.rules.log({ rule_id: rule.id, action: "skip", actor: "engine", detail: "engine busy" });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (rule.last_fired_at && now - rule.last_fired_at < rule.cooldown_sec) {
      // cooldown 内
      return;
    }

    // 簡易 condition チェック. skip でも last_fired_at を進めて毎秒 spam を防ぐ.
    if (!evaluateConditions(rule, deps)) {
      deps.rules.setLastFired(rule.id, now);
      log.debug({ rule_id: rule.id, reason: "conditions not met" }, "rule skip");
      return;
    }

    running = true;
    try {
      deps.rules.setLastFired(rule.id, now);
      await fireOnce(rule, triggeredBy);
    } catch (err) {
      deps.rules.log({ rule_id: rule.id, action: "error", actor: "engine", detail: (err as Error).message });
      log.warn({ err: (err as Error).message, rule_id: rule.id }, "fire failed");
    } finally {
      running = false;
    }
  }

  async function fireOnce(rule: RuleRow, triggeredBy: string): Promise<void> {
    if (deps.disable_claude) {
      deps.rules.log({ rule_id: rule.id, action: "skip", actor: "engine", detail: "claude disabled" });
      return;
    }

    const prompt = buildPrompt({
      rule,
      sessions: deps.sessions,
      chat: deps.chat,
      rules: deps.rules,
      triggered_by: triggeredBy,
    });

    const res = await runClaude(prompt);
    if (!res.ok) {
      deps.rules.log({
        rule_id: rule.id,
        action: "error",
        actor: "engine",
        detail: `claude failed: ${res.stderr.slice(0, 200)}`,
      });
      return;
    }

    const json = extractJson(res.stdout);
    if (!json) {
      deps.rules.log({
        rule_id: rule.id,
        action: "error",
        actor: "engine",
        detail: `unparsable: ${res.stdout.slice(0, 200)}`,
      });
      return;
    }

    const result = handleAction({ chat: deps.chat, rules: deps.rules }, rule.id, json);
    if (result.applied && result.action_type === "post") {
      // chat post 経路は eventBus.chat.posted 経由で onChatPosted が peer reaction を回すので、
      // 二重発火を避けるため fire 単独の log-update は出さない. (rule.add / rule.remove は handler 側で emit 済み.)
    }
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (unsubEvent) unsubEvent();
      log.info("rule engine stopped");
    },
    fireOnce,
  };
}

function evaluateConditions(rule: RuleRow, deps: EngineDeps): boolean {
  let conds: any[] = [];
  try { conds = JSON.parse(rule.conditions); } catch { conds = []; }
  for (const c of conds) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "any_active_session") {
      const n = deps.sessions.listSessions({ status: "active" }).length;
      if (n === 0) return false;
    }
    // (将来) 他の condition type を追加
  }
  return true;
}

function matchesEvent(rulePattern: string, evKind: string): boolean {
  // glob-ish: "*" だけ簡易対応
  if (rulePattern === "*") return true;
  return rulePattern === evKind;
}
