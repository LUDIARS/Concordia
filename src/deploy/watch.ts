/**
 * Revisor → Cc の既存通知 (session.inject, source="revisor") を購読し、
 * `checkout_published` だけを deploy フローへ繋ぐ。
 *
 * 通信路は増やさない。 Revisor の審査終局通知と同じ inject 経路に相乗りし、
 * 本文が checkout 前進を告げているときだけ動く (src/deploy/notice.ts)。
 *
 * 同じ前進が二重に届くこと (Revisor の再送 / 複数セッションへの通知) はありうるので、
 * repo+sha 単位で短時間の重複抑止を持つ。 再起動を 2 回走らせないため。
 *
 * @implements spec/feature/checkout-published-deploy.md §2 (`SPEC-CHECKOUT-PUBLISHED-NOTICE`)
 */

import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { deployAfterCheckoutPublish, type CheckoutDeployDeps } from "./deploy-service.js";
import { parseCheckoutPublishedNotice } from "./notice.js";
import { recordDeployOutcome, type DeployRecordDeps } from "./record.js";

const log = createChildLogger("deploy/checkout-watch");

/** 同一 checkout 前進の再通知を無視する窓 (ミリ秒)。 */
const DEDUPE_WINDOW_MS = 10 * 60_000;

export interface CheckoutPublishedWatchDeps extends CheckoutDeployDeps, DeployRecordDeps {
  /** 通知の repository が読めないとき、対象セッションの repo_path から補う。 */
  resolveSessionRepo?: (sessionId: string) => string | null;
}

export interface CheckoutPublishedWatchHandle {
  stop(): void;
}

/**
 * Revisor inject の購読を張る。 checkout 前進を読めたときだけ deploy を起動する。
 *
 * @implements spec/feature/checkout-published-deploy.md §2 (`SPEC-CHECKOUT-PUBLISHED-NOTICE`) — 通知の受け口
 */
export function startCheckoutPublishedDeployWatch(
  deps: CheckoutPublishedWatchDeps,
): CheckoutPublishedWatchHandle {
  const seen = new Map<string, number>();
  const clock = deps.now ?? Date.now;

  const unsubscribe = eventBus.subscribe((event) => {
    if (event.type !== "session.inject" || event.source !== "revisor") return;
    const notice = parseCheckoutPublishedNotice(event.text);
    if (!notice) return;

    const repository = notice.repository ?? deps.resolveSessionRepo?.(event.target_session_id) ?? null;
    const now = clock();
    // 抑止キーは「同じ前進」を指せるときだけ立てる。 sha も PR 番号も読めない通知で
    // repo だけをキーにすると、 **別々の前進**が同じキーに畳まれ、 10 分窓の 2 本目以降が
    // 黙って落ちる (= main は進んだのにサービスは古いまま — この機構が防ぐはずの状態)。
    // 前進を識別できない通知は抑止せず、 deploy 側の直列化と冪等な再起動に委ねる。
    const identity = notice.sha ?? (notice.prNumber !== null ? `pr-${notice.prNumber}` : null);
    if (identity !== null) {
      const key = `${repository ?? "?"}@${identity}`;
      const last = seen.get(key);
      if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
      seen.set(key, now);
    }
    for (const [k, at] of seen) if (now - at >= DEDUPE_WINDOW_MS) seen.delete(k);

    void handle(deps, { repository, sha: notice.sha });
  });

  return { stop: () => unsubscribe() };
}

/**
 * deploy 1 回ぶんの実行と記録。 例外は checkout 前進やマージへ波及させない。
 *
 * @implements spec/feature/checkout-published-deploy.md §4 (`SPEC-CHECKOUT-PUBLISHED-DEPLOY-RECORD`) — 記録
 */
async function handle(
  deps: CheckoutPublishedWatchDeps,
  input: { repository: string | null; sha: string | null },
): Promise<void> {
  try {
    const outcome = await deployAfterCheckoutPublish(deps, input);
    recordDeployOutcome(deps, outcome);
  } catch (e) {
    // deploy 経路の想定外の失敗は、checkout 前進やマージへ波及させない。
    log.error({ err: (e as Error).message, repo: input.repository }, "checkout 前進後の deploy 経路で例外");
  }
}
