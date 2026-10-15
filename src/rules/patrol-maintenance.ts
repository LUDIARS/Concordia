/**
 * 巡回チャットの復旧と配達照合 (spec/feature/patrol-chat.md §8)。
 *
 * 復旧 (lease が切れた投稿前の run):
 * - claimed / material_selected → failed (interrupted)。 素材の再選択は次の期日に任せる
 * - rendering                   → failed (render_interrupted)。 費用結果不明として残し、 自動再生成しない
 * - rendered                    → 保存済み本文で投稿を確定する (再生成しない)。 rule が止まっていれば skipped
 *
 * 配達照合:
 * - 既存 egress は chat.posted を受けて送信し、 成功時だけ Discord message ID を記録する
 * - 記録が見つかれば delivered。 一定時間見つからなければ delivery_unknown として表示し、 自動再送しない
 *   (送信後・記録前の中断と未送信を区別できないため。 CC-PATROL-03)
 */

import type { RuleRunRow } from "../db/rule-runs-repo.js";
import { commitRendered, type RunContext } from "./execute-patrol.js";
import { parseActionConfig } from "./patrol-config.js";
import {
  DELIVERY_UNKNOWN_AFTER_SEC,
  PATROL_LEASE_SEC,
  nowSecOf,
  ownerDefaultsOf,
  ownerStopReason,
  type PatrolPorts,
} from "./patrol-ports.js";

export interface RecoveryReport {
  failed: number;
  committed: number;
  skipped: number;
}

export function recoverStaleRuns(ports: PatrolPorts): RecoveryReport {
  const report: RecoveryReport = { failed: 0, committed: 0, skipped: 0 };
  const now = nowSecOf(ports);
  for (const run of ports.runs.listStale(now)) {
    if (!ports.runs.adopt(run.run_id, ports.leaseOwner, now + PATROL_LEASE_SEC, now)) continue;
    if (run.status === "rendered") {
      recoverRendered(ports, run, report);
      continue;
    }
    const interrupted = run.status === "rendering";
    ports.runs.transition(run.run_id, ports.leaseOwner, [run.status], "failed", {
      reason: interrupted ? "render interrupted (cost result unknown)" : "interrupted before render",
      error_code: interrupted ? "render_interrupted" : "interrupted",
    }, now);
    ports.rules.log({ rule_id: run.rule_id, action: "error", actor: "engine", detail: `recovered run ${run.run_id}: ${run.status} → failed` });
    report.failed++;
  }
  return report;
}

function recoverRendered(ports: PatrolPorts, run: RuleRunRow, report: RecoveryReport): void {
  const now = nowSecOf(ports);
  const rule = ports.rules.find(run.rule_id);
  const inherit = rule ? ownerDefaultsOf(ports, rule) : null;
  const parsed = rule ? parseActionConfig(rule.action_config, inherit) : null;
  if (!rule || !rule.enabled || rule.removed_at || rule.execution_mode !== "patrol" || ports.runtimeDisabled() || !parsed?.ok
    || ownerStopReason(ports, rule, inherit)) {
    ports.runs.transition(run.run_id, ports.leaseOwner, ["rendered"], "skipped", { reason: "recovered rendered run: rule stopped before send" }, now);
    report.skipped++;
    return;
  }
  const ctx: RunContext = { ports, rule, config: parsed.config, channel: run.channel };
  const conv = run.conversation_id ? ports.conversations.find(run.conversation_id) : null;
  const inReplyTo = conv ? conv.last_bot_message_id : null;
  const result = commitRendered(ctx, run.run_id, { inReplyTo, conversationId: run.conversation_id });
  if (!result.ok) {
    report.skipped++;
    return;
  }
  if (conv && (run.action_kind === "reply" || run.action_kind === "followup")) {
    ports.conversations.recordBotTurn(conv.conversation_id, result.chat.id, run.action_kind, now);
  } else if (!conv) {
    const conversationId = ports.newId();
    ports.conversations.open({
      conversation_id: conversationId,
      rule_id: rule.id,
      rule_revision: run.rule_revision,
      root_chat_id: result.chat.id,
      channel: run.channel,
      scope_key: run.scope_key,
      source_ref: run.source_ref,
      expires_at: now + parsed.config.followup.window_sec,
      now,
    });
    ports.runs.markConversation(run.run_id, conversationId, now);
  }
  report.committed++;
}

export function reconcileDeliveries(ports: PatrolPorts): { delivered: number; unknown: number } {
  const now = nowSecOf(ports);
  let delivered = 0;
  let unknown = 0;
  for (const run of ports.runs.listAwaitingDelivery(now)) {
    if (run.chat_message_id === null) continue;
    const external = ports.delivery?.findExternalId(run.chat_message_id) ?? null;
    if (external) {
      if (ports.runs.markDelivery(run.run_id, "delivered", `discord:${external}`, now)) delivered++;
    } else if (run.status === "delivery_pending" && now - run.updated_at >= DELIVERY_UNKNOWN_AFTER_SEC) {
      if (ports.runs.markDelivery(run.run_id, "delivery_unknown", null, now)) unknown++;
    }
  }
  return { delivered, unknown };
}
