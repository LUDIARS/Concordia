/**
 * AI プレイテスト感想を受けて、 Cc が持つ宛先 (本社の Discord チャンネルと Slack webhook、 設定で有効なら Tabula) へ
 * 投稿する手順。
 *
 * 1. runId で 1 回だけ受け付ける (CC-PLAYTEST-INV-02)。
 * 2. 宛先は設定から解決する。 送り手 (Ingenium) は宛先も URL も持たない (CC-PLAYTEST-INV-01)。
 * 3. 配送はデプロイ通知と同じ transport (`deliverDeploymentNotice`) を使い、 宛先ごとの成否を返す。
 *    1 つの宛先の失敗は他の宛先を止めない (CC-PLAYTEST-INV-04)。
 * 4. Tabula への投稿が設定で有効なら、 チャットの結果に関係なく同じ投稿文を共有ページにする (CC-PLAYTEST-INV-05)。
 *    無効なら `tabula: null`。 チャットの宛先も Tabula も無ければ配送せず unconfigured。
 *
 * @implements spec/feature/playtest-review-notify.md — 受付と配送
 */

import { deliverDeploymentNotice, type DeploymentDelivery, type DeploymentDeliveryResult, type DeployNotifyTarget } from "../deploy/service-deployed.js";
import { composePlaytestReviewNotice, type PlaytestReviewEvent } from "./playtest-review-notice.js";
import type { PlaytestReviewTabula } from "./playtest-review-tabula.js";
import type { PlaytestReviewLedger } from "./recent-run-ledger.js";

export interface PlaytestReviewTargets {
  targets(): DeployNotifyTarget[];
}

export type PlaytestTabulaOutcome = { url: string } | { error: string } | null;

export interface PlaytestReviewOutcome {
  duplicate: boolean;
  /** 宛先が 1 つも設定されていない。 配送は試みていない。 */
  unconfigured: boolean;
  delivered: DeploymentDeliveryResult[];
  failed: DeploymentDeliveryResult[];
  /** Tabula のページ (投稿した)、 失敗理由、 または null (設定で無効)。 */
  tabula: PlaytestTabulaOutcome;
}

async function postTabula(tabula: PlaytestReviewTabula | undefined, event: PlaytestReviewEvent, content: string): Promise<PlaytestTabulaOutcome> {
  if (!tabula?.enabled()) return null;
  try {
    return { url: (await tabula.post(event, content)).url };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "tabula post failed" };
  }
}

export async function handlePlaytestReview(input: {
  event: PlaytestReviewEvent;
  ledger: PlaytestReviewLedger;
  targets: PlaytestReviewTargets;
  delivery: DeploymentDelivery;
  tabula?: PlaytestReviewTabula;
}): Promise<PlaytestReviewOutcome> {
  if (!input.ledger.claim(input.event.runId)) return { duplicate: true, unconfigured: false, delivered: [], failed: [], tabula: null };
  const targets = input.targets.targets();
  const tabulaEnabled = input.tabula?.enabled() === true;
  if (targets.length === 0 && !tabulaEnabled) return { duplicate: false, unconfigured: true, delivered: [], failed: [], tabula: null };
  const content = composePlaytestReviewNotice(input.event);
  const results = targets.length === 0
    ? { delivered: [], failed: [] }
    : await deliverDeploymentNotice({ targets, content, delivery: input.delivery });
  const tabula = await postTabula(input.tabula, input.event, content);
  return { duplicate: false, unconfigured: false, ...results, tabula };
}
