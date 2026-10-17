/**
 * AI プレイテスト感想の宛先を Cc の設定から解決する (CC-PLAYTEST-INV-01)。
 * 本社の Discord チャンネル (Cc Bot) と Slack webhook の 2 つだけ。 未設定のものは宛先にしない。
 * URL・token は配送時にだけ読む (ここは「設定があるか」だけを見る)。
 *
 * @implements spec/feature/playtest-review-notify.md — 宛先
 */

import type { DeployNotifyTarget } from "../deploy/service-deployed.js";
import type { PlaytestReviewTargets } from "./handle-playtest-review.js";

/** Slack webhook の名前。 createDeploymentDelivery の webhookUrl(name) にこの名前で問い合わせる。 */
export const PLAYTEST_SLACK_WEBHOOK = "playtest-slack";

export function createPlaytestReviewTargets(input: {
  discordChannelConfigured: () => boolean;
  slackWebhookConfigured: () => boolean;
}): PlaytestReviewTargets {
  return {
    targets: () => [
      ...(input.discordChannelConfigured() ? [{ kind: "cc-channel" as const, target: "" }] : []),
      ...(input.slackWebhookConfigured() ? [{ kind: "slack" as const, target: PLAYTEST_SLACK_WEBHOOK }] : []),
    ] satisfies DeployNotifyTarget[],
  };
}
