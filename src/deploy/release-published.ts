import { contract } from "./ontime-runtime.js"; /* augur-inject:import:release-published */
import releaseNoticeContract from "./release-published.contract.js"; /* augur-inject:contract-predicate:release-published */

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

export interface ReleaseNoticeDelivery {
  ccChannel(content: string): Promise<void>;
}

export interface ReleaseNoticeDecision {
  content: string;
  shouldDeliver: boolean;
}

export interface ReleaseNoticeOutcome {
  duplicate: boolean;
  unconfigured: boolean;
  delivered: boolean;
  failed: string | null;
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

/** Decides whether a configured HQ channel may receive an already-composed notice. */
export function decideReleaseNotice(input: { content: string; channelConfigured: boolean }): ReleaseNoticeDecision {
  return { content: input.content, shouldDeliver: input.channelConfigured };
}

// @ts-expect-error augur-inject
decideReleaseNotice = contract(decideReleaseNotice, { ...releaseNoticeContract, contractId: "C-7", mode: "observe", sample: 1, where: "src/deploy/release-published.ts:39", rule: "contract-wrap", id: "release-published-decide" }); /* augur-inject:contract-wrap:release-published-decide */

/** Claims one immutable release identity before attempting the external Bot delivery. */
export async function handleReleasePublished(input: {
  event: ReleasePublishedEvent;
  ledger: ReleaseNoticeLedger;
  channelConfigured: boolean;
  delivery: ReleaseNoticeDelivery;
}): Promise<ReleaseNoticeOutcome> {
  if (!input.ledger.claim(input.event.repository, input.event.tag)) {
    return { duplicate: true, unconfigured: false, delivered: false, failed: null };
  }
  const decision = decideReleaseNotice({ content: composeReleaseNotice(input.event), channelConfigured: input.channelConfigured });
  if (!decision.shouldDeliver) return { duplicate: false, unconfigured: true, delivered: false, failed: null };
  try {
    await input.delivery.ccChannel(decision.content);
    return { duplicate: false, unconfigured: false, delivered: true, failed: null };
  } catch (error) {
    return { duplicate: false, unconfigured: false, delivered: false, failed: error instanceof Error ? error.message : "release notification delivery failed" };
  }
}

// @ts-expect-error augur-inject
handleReleasePublished = contract(handleReleasePublished, { ...releaseNoticeContract, contractId: "C-5", mode: "observe", sample: 1, where: "src/deploy/release-published.ts:49", rule: "contract-wrap", id: "release-published-handle" }); /* augur-inject:contract-wrap:release-published-handle */
