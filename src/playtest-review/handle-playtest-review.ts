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
 * 5. run の動画が付いていれば、 Discord と Slack は投稿文と動画を同じ投稿で出す (playtest-review-video.ts)。
 *    動画付きで出せなかった宛先 (Slack の動画の宛先が未設定・添付の失敗) は投稿文だけを従来の経路で出し、
 *    感想は必ず届ける。 宛先ごとの動画の成否は `video` に返す (動画なしなら null、 CC-PLAYTEST-INV-06)。
 *
 * @implements spec/feature/playtest-review-notify.md — 受付と配送
 */

import { deliverDeploymentNotice, type DeploymentDelivery, type DeploymentDeliveryResult, type DeployNotifyTarget } from "../deploy/service-deployed.js";
import { composePlaytestReviewNotice, type PlaytestReviewEvent } from "./playtest-review-notice.js";
import type { PlaytestReviewTabula } from "./playtest-review-tabula.js";
import type { PlaytestReviewVideo, PlaytestVideoDelivery } from "./playtest-review-video.js";
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
  /** 動画を添付できた宛先とできなかった宛先。 動画が付いていなければ null。 */
  video: { delivered: DeploymentDeliveryResult[]; failed: DeploymentDeliveryResult[] } | null;
}

async function postTabula(tabula: PlaytestReviewTabula | undefined, event: PlaytestReviewEvent, content: string): Promise<PlaytestTabulaOutcome> {
  if (!tabula?.enabled()) return null;
  try {
    return { url: (await tabula.post(event, content)).url };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "tabula post failed" };
  }
}

function resultTarget(target: DeployNotifyTarget): DeploymentDeliveryResult["target"] {
  return { kind: target.kind, target: target.target };
}

/** 動画付きで出せた宛先と、 投稿文だけを出し直す宛先に分ける。 */
async function deliverVideo(targets: readonly DeployNotifyTarget[], content: string, video: PlaytestReviewVideo, delivery: PlaytestVideoDelivery): Promise<{ posted: DeploymentDeliveryResult[]; textOnly: DeployNotifyTarget[]; video: NonNullable<PlaytestReviewOutcome["video"]> }> {
  const posted: DeploymentDeliveryResult[] = [];
  const textOnly: DeployNotifyTarget[] = [];
  const result: NonNullable<PlaytestReviewOutcome["video"]> = { delivered: [], failed: [] };
  for (const target of targets) {
    try {
      if (target.kind === "cc-channel") await delivery.discord(content, video);
      else if (target.kind === "slack" && delivery.slackReady()) await delivery.slack(content, video);
      else if (target.kind === "slack") throw new Error("playtest Slack video channel is not configured");
      else throw new Error(`no video transport for ${target.kind}`);
      posted.push({ target: resultTarget(target) });
      result.delivered.push({ target: resultTarget(target) });
    } catch (error) {
      result.failed.push({ target: resultTarget(target), error: error instanceof Error ? error.message : "video delivery failed" });
      textOnly.push(target);
    }
  }
  return { posted, textOnly, video: result };
}

export async function handlePlaytestReview(input: {
  event: PlaytestReviewEvent;
  ledger: PlaytestReviewLedger;
  targets: PlaytestReviewTargets;
  delivery: DeploymentDelivery;
  tabula?: PlaytestReviewTabula;
  video?: PlaytestReviewVideo;
  videoDelivery?: PlaytestVideoDelivery;
}): Promise<PlaytestReviewOutcome> {
  if (!input.ledger.claim(input.event.runId)) return { duplicate: true, unconfigured: false, delivered: [], failed: [], tabula: null, video: null };
  const targets = input.targets.targets();
  const tabulaEnabled = input.tabula?.enabled() === true;
  if (targets.length === 0 && !tabulaEnabled) return { duplicate: false, unconfigured: true, delivered: [], failed: [], tabula: null, video: null };
  const content = composePlaytestReviewNotice(input.event);
  const withVideo = input.video && input.videoDelivery ? await deliverVideo(targets, content, input.video, input.videoDelivery) : null;
  const textTargets = withVideo ? withVideo.textOnly : targets;
  const text = textTargets.length === 0
    ? { delivered: [], failed: [] }
    : await deliverDeploymentNotice({ targets: textTargets, content, delivery: input.delivery });
  const tabula = await postTabula(input.tabula, input.event, content);
  return {
    duplicate: false,
    unconfigured: false,
    delivered: [...(withVideo?.posted ?? []), ...text.delivered],
    failed: text.failed,
    tabula,
    video: withVideo?.video ?? (input.video ? { delivered: [], failed: targets.map((target) => ({ target: resultTarget(target), error: "no video transport is wired" })) } : null),
  };
}
