/**
 * Rule engine (ブラックボックス / 決定的).
 *
 * - 1 秒ごとに rules を見て、 trigger=tick で last_fired_at から tick_sec 以上経った rule を発火
 * - event 発火は eventBus 購読で受ける (trigger=event の rule)
 * - 並列実行は禁止 (mutex 1 つ. 走行中は他 rule を skip)
 *
 * **LLM は使わない**: 「いつ / どの channel に / どんな意図で」 喋るかは
 * decide.ts が決定的に判定し、 発話文だけを中央 Haiku レスポンダ (chat/responder.ts)
 * が描画する. 旧来の claude CLI 判断 (buildPrompt + handler) は撤去した.
 */

import type { RulesRepo, RuleRow } from "../db/rules-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { decideRuleFire } from "./decide.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { actionFrequencyMultiplier } from "../shared/quiet-hours.js";

const log = createChildLogger("rule-engine");
const ENGINE_TICK_MS = 1000;

export interface EngineDeps {
  rules: RulesRepo;
  sessions: SessionsRepo;
  /**
   * Runtime kill-switch. true を返す間は全 fire を skip
   * (admin の rules-enabled=false / コスト予算超過から配線).
   */
  rulesDisabled?: () => boolean;
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
  // eventBus.emit の try/catch は同期 throw しか捕捉しない (async listener の
  // rejection は escape して unhandledRejection になる) ため、 body 全体を
  // try/catch で包み rejection を一切漏らさない。
  unsubEvent = eventBus.subscribe(async (ev) => {
    try {
      if (stopped) return;
      if (ev.type === "ping") return;
      const eventKind = ev.type;
      const candidates = deps.rules
        .list({ enabled: true, trigger_type: "event" })
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
    } catch (err) {
      log.warn({ err: (err as Error).message, event: ev.type }, "event rule pass failed");
    }
  });

  // tick timer (sweeper.ts と同じく tick 全体をガードし rejection を漏らさない)
  timer = setInterval(async () => {
    try {
      if (stopped) return;
      const now = Math.floor(Date.now() / 1000);
      // 深夜帯は tick の発火間隔を 1/freq 倍に伸ばす (= 行動頻度 1/10).
      const freq = actionFrequencyMultiplier();
      const ticks = deps.rules.list({ enabled: true, trigger_type: "tick" });
      for (const r of ticks) {
        if (!r.tick_sec) continue;
        const elapsed = r.last_fired_at ? now - r.last_fired_at : Infinity;
        if (elapsed >= r.tick_sec / freq) {
          await tryFire(r, "tick");
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "tick rule pass failed");
    }
  }, ENGINE_TICK_MS);

  log.info({ tickMs: ENGINE_TICK_MS }, "rule engine started (deterministic / haiku-rendered)");

  async function tryFire(rule: RuleRow, triggeredBy: string): Promise<void> {
    if (running) {
      deps.rules.log({ rule_id: rule.id, action: "skip", actor: "engine", detail: "engine busy" });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (rule.last_fired_at && now - rule.last_fired_at < rule.cooldown_sec) {
      return; // cooldown 内
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
    if (deps.rulesDisabled?.()) {
      deps.rules.log({ rule_id: rule.id, action: "skip", actor: "engine", detail: "rules disabled at runtime (admin/cost)" });
      return;
    }

    const active = deps.sessions.listSessions({ status: "active" });
    const decision = decideRuleFire(rule, {
      nowSec: Math.floor(Date.now() / 1000),
      activeSessionCount: active.length,
    });
    if (!decision.fire) {
      deps.rules.log({ rule_id: rule.id, action: "skip", actor: "engine", detail: decision.reason });
      return;
    }

    deps.rules.log({
      rule_id: rule.id,
      action: "fire",
      actor: "engine",
      detail: `${triggeredBy} → ${decision.channel}/${decision.intent}`,
    });
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

function matchesEvent(rulePattern: string, evKind: string): boolean {
  if (rulePattern === "*") return true;
  return rulePattern === evKind;
}
