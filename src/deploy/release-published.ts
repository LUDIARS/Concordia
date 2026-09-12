import { contract } from "./ontime-runtime.js"; /* augur-inject:import:release-published */
import releaseNoticeContract from "./release-published.contract.js"; /* augur-inject:contract-predicate:release-published */
import {
  deliverDeploymentNotice,
  type DeploymentDelivery,
  type DeploymentDeliveryResult,
  type DeployNotifyTarget,
} from "./service-deployed.js";

export interface ReleasePublishedEvent {
  repository: string;
  kind: "major" | "minor";
  tag: string;
  previousTag: string | null;
  version: string;
  title: string;
  notice: string;
  releaseUrl: string;
  publishedAt: string;
}

export interface ReleaseNoticeLedger {
  claim(repository: string, tag: string): boolean;
}

/**
 * 配送は デプロイ通知と同じ transport を使う。 本社チャンネル・Discord / Slack webhook・
 * 子会社チャンネルの送り分けはどちらのイベントでも同じ問題なので、 二重に持たない。
 */
export type ReleaseNoticeDelivery = DeploymentDelivery;

/**
 * リリース通知の宛先を解決する。 `repository` (owner/name) 起点なのは、 Revisor が送る
 * リリースイベントが catalog の service code ではなくリポジトリを名乗るため。
 */
export interface ReleaseNoticeLookup {
  targets(repository: string): DeployNotifyTarget[];
}

export interface ReleaseNoticeOutcome {
  duplicate: boolean;
  /** 宛先が 1 つも解決できなかった。 配送は試みていない。 */
  unconfigured: boolean;
  delivered: DeploymentDeliveryResult[];
  failed: DeploymentDeliveryResult[];
}

/** Creates the human-facing text without depending on Discord, storage, or settings. */
export function composeReleaseNotice(event: ReleasePublishedEvent): string {
  const notice = event.notice.trim().split(/\r?\n/).filter(Boolean).slice(0, 10).join("\n");
  return [`【${event.repository} ${event.tag} リリース】 ${event.title.trim()}`, notice, event.releaseUrl.trim()]
    .filter(Boolean)
    .join("\n");
}

// @ts-expect-error augur-inject
composeReleaseNotice = contract(composeReleaseNotice, { ...releaseNoticeContract, contractId: "C-6", mode: "observe", sample: 1, where: "src/deploy/release-published.ts:31", rule: "contract-wrap", id: "release-published-compose" }); /* augur-inject:contract-wrap:release-published-compose */

/**
 * Claims one immutable release identity before attempting the external Bot delivery.
 *
 * 宛先は本社チャンネルに加えて、 対象プロジェクトを担当する子会社チャンネルを含む。
 * 解決は `resolveDeploymentTargets` (CC-INV-06) に委ねる — 本社は無条件、 子会社は
 * project scope と Revisor workflow の両方が揃ったときだけという fail-closed の規則を
 * デプロイ通知と 1 か所で共有し、 リリースだけ緩い経路ができないようにする。
 */
export async function handleReleasePublished(input: {
  event: ReleasePublishedEvent;
  ledger: ReleaseNoticeLedger;
  lookup: ReleaseNoticeLookup;
  delivery: ReleaseNoticeDelivery;
}): Promise<ReleaseNoticeOutcome> {
  if (!input.ledger.claim(input.event.repository, input.event.tag)) {
    return { duplicate: true, unconfigured: false, delivered: [], failed: [] };
  }
  const targets = input.lookup.targets(input.event.repository);
  if (targets.length === 0) return { duplicate: false, unconfigured: true, delivered: [], failed: [] };
  const results = await deliverDeploymentNotice({
    targets,
    content: composeReleaseNotice(input.event),
    delivery: input.delivery,
  });
  return { duplicate: false, unconfigured: false, ...results };
}

// @ts-expect-error augur-inject
handleReleasePublished = contract(handleReleasePublished, { ...releaseNoticeContract, contractId: "C-5", mode: "observe", sample: 1, where: "src/deploy/release-published.ts:49", rule: "contract-wrap", id: "release-published-handle" }); /* augur-inject:contract-wrap:release-published-handle */
