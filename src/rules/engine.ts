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
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";
import type { PatrolPorts } from "./patrol-ports.js";
import { runPatrolCycle } from "./patrol-cycle.js";
import { acceptInbound } from "./patrol-inbound.js";
import { reconcileDeliveries, recoverStaleRuns } from "./patrol-maintenance.js";

const log = createChildLogger("rule-engine");
const ENGINE_TICK_MS = 1000;
/** 巡回の復旧・配達照合・期限切れ会話の整理を回す間隔。 */
const PATROL_MAINTENANCE_MS = 15_000;

export interface EngineDeps {
  rules: RulesRepo;
  sessions: SessionsRepo;
  /**
   * Runtime kill-switch. true を返す間は全 fire を skip
   * (admin の rules-enabled=false / コスト予算超過から配線).
   */
  rulesDisabled?: () => boolean;
  /**
   * 巡回チャット (execution_mode=patrol の rule) の実行 port。 未指定なら巡回 rule は動かない
   * (旧 rule の legacy-observe だけが従来どおり動く)。 spec/feature/patrol-chat.md
   */
  patrol?: Omit<PatrolPorts, "runtimeDisabled">;
  /**
   * 巡回の学習 (断片の抽出と 1 日ごとの学習)。 返信の周期とは別の流れで 1 分ごとに回す
   * (LLM の待ちで返信を遅らせない)。 spec/plan/2026-10-15-patrol-learning-design.md
   */
  learning?: { run: () => Promise<unknown> };
}

/** 学習の pass を回す間隔。 */
const PATROL_LEARNING_MS = 60_000;

export interface EngineHandle {
  stop: () => void;
  fireOnce: (rule: RuleRow, triggered_by: string) => Promise<void>;
}

export function startRuleEngine(deps: EngineDeps): EngineHandle {
  let running = false;
  let unsubEvent: (() => void) | null = null;
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
      if (ev.type === "chat.posted" && patrol) {
        // 巡回会話への人間の直接返信は定期 tick を待たず受理し、 すぐ巡回の 1 周を起こす。
        const accepted = acceptInbound(patrol, ev.message_id);
        if (accepted.accepted) void runPatrolPass();
      }
      const candidates = deps.rules
        .list({ enabled: true, trigger_type: "event", execution_mode: "legacy-observe" })
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
  const supervised = startSupervisedInterval("rule-engine", async () => {
      if (stopped) return;
      const now = Math.floor(Date.now() / 1000);
      // 深夜帯は tick の発火間隔を 1/freq 倍に伸ばす (= 行動頻度 1/10).
      const freq = actionFrequencyMultiplier();
      const ticks = deps.rules.list({ enabled: true, trigger_type: "tick", execution_mode: "legacy-observe" });
      for (const r of ticks) {
        if (!r.tick_sec) continue;
        const elapsed = r.last_fired_at ? now - r.last_fired_at : Infinity;
        if (elapsed >= r.tick_sec / freq) {
          await tryFire(r, "tick");
        }
      }
      void runPatrolPass();
  }, {
    intervalMs: ENGINE_TICK_MS,
    log: { warn: (message) => log.warn(message) },
  });

  log.info({ tickMs: ENGINE_TICK_MS, patrol: !!deps.patrol }, "rule engine started (deterministic / haiku-rendered)");

  // ─── 巡回チャット ───────────────────────────────────────
  // 旧 rule とは別の mutex。 巡回の生成 (最大 30 秒) が旧 rule の発火を "engine busy" で潰さない。
  // 巡回 rule 同士は 1 本ずつ実行し、 並列生成を増やさない。
  const patrol: PatrolPorts | null = deps.patrol
    ? { ...deps.patrol, runtimeDisabled: () => stopped || (deps.rulesDisabled?.() ?? false) }
    : null;
  let patrolRunning = false;
  let lastMaintenanceMs = 0;
  if (patrol) {
    try {
      const recovered = recoverStaleRuns(patrol);
      if (recovered.failed + recovered.committed + recovered.skipped > 0) log.info(recovered, "patrol runs recovered at start");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "patrol recovery at start failed");
    }
  }

  async function runPatrolPass(): Promise<void> {
    if (!patrol || stopped || patrolRunning) return;
    patrolRunning = true;
    try {
      const nowMs = patrol.nowMs();
      if (nowMs - lastMaintenanceMs >= PATROL_MAINTENANCE_MS) {
        lastMaintenanceMs = nowMs;
        recoverStaleRuns(patrol);
        reconcileDeliveries(patrol);
        patrol.conversations.closeExpired(Math.floor(nowMs / 1000));
        patrol.events.ignoreOlderThan(Math.floor(nowMs / 1000) - 86400);
      }
      const frequency = actionFrequencyMultiplier();
      for (const rule of deps.rules.list({ enabled: true, execution_mode: "patrol" })) {
        if (stopped) break;
        try {
          await runPatrolCycle(patrol, rule, { frequency });
        } catch (err) {
          deps.rules.log({ rule_id: rule.id, action: "error", actor: "engine", detail: `patrol cycle: ${(err as Error).message}` });
          log.warn({ err: (err as Error).message, rule_id: rule.id }, "patrol cycle failed");
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "patrol pass failed");
    } finally {
      patrolRunning = false;
    }
  }

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

  // 巡回の学習。 返信の周期 (runPatrolPass) とは別の mutex で回す。
  let learningRunning = false;
  const learningLoop = deps.learning
    ? startSupervisedInterval("patrol-learning", async () => {
        if (stopped || learningRunning || (deps.rulesDisabled?.() ?? false)) return;
        learningRunning = true;
        try {
          await deps.learning!.run();
        } catch (err) {
          log.warn({ err: (err as Error).message }, "patrol learning pass failed");
        } finally {
          learningRunning = false;
        }
      }, { intervalMs: PATROL_LEARNING_MS, log: { warn: (message) => log.warn(message) } })
    : null;

  return {
    stop: () => {
      stopped = true;
      supervised.stop();
      learningLoop?.stop();
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
