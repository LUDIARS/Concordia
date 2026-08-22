/**
 * deploy 1 回ぶんの記録。
 *
 * 「main は進んだがサービスは古いまま」を無言にしないことがこの機構の目的なので、
 * **結果は必ずログに 1 行残す**。 そのうえで人が見る面 (chat / errors) へは、
 * 行動が変わるものだけを出す:
 *
 * - サービスが無いリポ (`no_service`) / リポ不明 (`no_repository`) は日常的に起きるので
 *   chat へは出さない (spec: 「サービスが無いリポでは何もしない」)。 ログには残る。
 * - 実行した / 見送った (claim 衝突・本体クローン無し) は chat の system channel へ 1 行。
 * - 失敗は errors へも出す。 checkout 前進とマージは巻き戻さないことを文面に含める。
 *
 * @implements spec/feature/checkout-published-deploy.md §4 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RECORD`)
 */

import type { ChatRepo } from "../db/chat-repo.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { describeDeployOutcome, type DeployOutcome } from "./outcome.js";

const log = createChildLogger("deploy/checkout-published");

/** chat へ出さない (ログだけで足りる) 見送り理由。 */
const QUIET_SKIPS = new Set(["no_service", "no_repository"]);

export interface DeployRecordDeps {
  chat?: Pick<ChatRepo, "insert">;
}

/**
 * 結果 1 件を記録する。 実行した / しなかったのどちらでも 1 行残す。
 *
 * @implements spec/feature/checkout-published-deploy.md §4 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RECORD`) — 記録
 */
export function recordDeployOutcome(deps: DeployRecordDeps, outcome: DeployOutcome): string {
  const line = describeDeployOutcome(outcome);
  const fields = {
    kind: outcome.kind,
    repo: outcome.repository,
    service: outcome.serviceCode ?? null,
  };
  if (outcome.kind === "failed") log.error(fields, line);
  else log.info(fields, line);

  if (outcome.kind === "skipped" && QUIET_SKIPS.has(outcome.reason)) return line;

  try {
    const msg = deps.chat?.insert({
      channel: "system",
      session_id: null,
      author_label: "Concordia deploy",
      text: line,
      in_reply_to: null,
      is_actionable: false,
    });
    // insert しただけでは live な購読者 (Web UI の chat ペイン / 各プラットフォームのミラー) へ
    // 届かない。 他の投稿元 (api/chat.ts, end-session-flow.ts, compaction.ts) と同じく
    // chat.posted を出して初めて「無言にしない」が視認できる面まで成立する。
    if (msg) {
      eventBus.emit({
        type: "chat.posted",
        message_id: msg.id,
        channel: msg.channel,
        author_label: msg.author_label,
        session_id: msg.session_id,
        ts: msg.ts,
        is_actionable: false,
      });
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, "deploy 記録の chat 投稿に失敗した (ログには残る)");
  }

  if (outcome.kind === "failed") {
    eventBus.emit({
      type: "error.reported",
      source: "deploy:checkout-published",
      message: line,
      detail: { stage: outcome.stage, service: outcome.serviceCode, repo: outcome.repository },
      ts: Math.floor(Date.now() / 1000),
    });
  }
  return line;
}
