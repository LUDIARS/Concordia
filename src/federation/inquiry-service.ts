/**
 * 拠点間ワンショット調査の手順 (application)。 本社 / 拠点どちらのロールでも同じ入口を持つ。
 *
 * - 自分から依頼: 本社は宛先拠点へ直接、 拠点は本社へ送る (本社が自分で実行するか宛先へ中継する)。
 * - 依頼を受ける: 自分で実行して結果を返す。 本社は拠点同士の依頼を中継する。
 *
 * 送信・実行は ports で受け取り、 ここは WS や CLI を直接知らない。
 *
 * @implements spec/feature/federation-link.md §拠点間ワンショット調査 (SPEC-FED-INQUIRY)
 */
import { randomUUID } from "node:crypto";
import type { FederationFrameInput, FederationInquiryRequestFrame, FederationInquiryResultFrame } from "./protocol.js";
import { INQUIRY_HQ } from "./protocol.js";
import { createInquiryBroker, type InquiryOutcome } from "./inquiry-broker.js";
import {
  INQUIRY_RESPONSE_GRACE_MS,
  clampInquiryTimeoutSec,
  decideHqInquiryRoute,
  validateHqInquiryTarget,
} from "./inquiry-policy.js";
import type { InquiryRunner } from "./inquiry-runner.js";

export type InquiryRole = { kind: "hq" } | { kind: "site"; siteId: string } | { kind: "none" };

export interface InquiryServicePorts {
  role(): InquiryRole;
  /** 本社: 拠点へ直接送る。 */
  sendToSite(siteId: string, frame: FederationFrameInput): boolean;
  /** 拠点: 本社へ直接送る。 */
  sendToHq(frame: FederationFrameInput): boolean;
  isActiveSite(siteId: string): boolean;
  isConnected(siteId: string): boolean;
  runner(): InquiryRunner | null;
  log: { info(message: string): void; warn(message: string): void };
}

export interface InquiryRequestInput {
  target: string;
  prompt: string;
  project?: string;
  timeoutSec?: number;
}

export interface InquiryService {
  /** 自分から依頼して結果を待つ。 */
  request(input: InquiryRequestInput): Promise<InquiryOutcome>;
  /** 本社: 拠点からの依頼。 */
  onSiteRequest(fromSite: string, frame: FederationInquiryRequestFrame): void;
  /** 本社: 拠点からの結果。 */
  onSiteResult(fromSite: string, frame: FederationInquiryResultFrame): void;
  /** 拠点: 本社からの依頼。 */
  onHqRequest(frame: FederationInquiryRequestFrame): void;
  /** 拠点: 本社からの結果。 */
  onHqResult(frame: FederationInquiryResultFrame): void;
  /** リンク断・停止。 */
  failAll(error: string): void;
}

function failure(executedBy: string, error: string): InquiryOutcome {
  return { ok: false, output: "", error, executedBy, durationMs: null };
}

export function createInquiryService(ports: InquiryServicePorts): InquiryService {
  const broker = createInquiryBroker();

  const runLocal = async (selfId: string, origin: string, frame: { prompt: string; project?: string; timeout_sec: number }): Promise<InquiryOutcome> => {
    const runner = ports.runner();
    if (!runner) return failure(selfId, "inquiry runner is unavailable on this Concordia");
    const result = await runner({ origin, prompt: frame.prompt, project: frame.project, timeoutSec: frame.timeout_sec });
    return { ok: result.ok, output: result.output, error: result.error, executedBy: selfId, durationMs: result.durationMs };
  };

  const resultFrame = (requestId: string, outcome: InquiryOutcome): FederationFrameInput => ({
    type: "inquiry-result",
    request_id: requestId,
    ok: outcome.ok,
    ...(outcome.output ? { output: outcome.output } : {}),
    ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
    executed_by: outcome.executedBy,
    ...(outcome.durationMs !== null ? { duration_ms: outcome.durationMs } : {}),
  });

  return {
    async request(input) {
      const role = ports.role();
      const timeoutSec = clampInquiryTimeoutSec(input.timeoutSec);
      const requestId = randomUUID();
      const frame = { prompt: input.prompt, ...(input.project ? { project: input.project } : {}), timeout_sec: timeoutSec };
      const waitMs = timeoutSec * 1000 + INQUIRY_RESPONSE_GRACE_MS;
      if (role.kind === "none") return failure(input.target, "federation is not configured on this Concordia");

      if (role.kind === "hq") {
        const validated = validateHqInquiryTarget({ target: input.target, isActiveSite: ports.isActiveSite, isConnected: ports.isConnected });
        if (!validated.ok) return failure(input.target, validated.error);
        if (validated.local) return runLocal(INQUIRY_HQ, INQUIRY_HQ, frame);
        const pending = broker.wait(requestId, input.target, waitMs);
        const sent = ports.sendToSite(input.target, { type: "inquiry-request", request_id: requestId, origin: INQUIRY_HQ, target: input.target, ...frame });
        if (!sent) broker.fail(requestId, `could not send to site: ${input.target}`);
        ports.log.info(`federation inquiry sent request=${requestId} target=${input.target} sent=${sent}`);
        return pending;
      }

      if (input.target === role.siteId) return runLocal(role.siteId, role.siteId, frame);
      // 拠点からはどの宛先でも本社を経由する。 結果は本社 (宛先が本社) か中継された宛先拠点から届く。
      const pending = broker.wait(requestId, input.target, waitMs);
      const sent = ports.sendToHq({ type: "inquiry-request", request_id: requestId, origin: role.siteId, target: input.target, ...frame });
      if (!sent) broker.fail(requestId, "HQ link is not connected");
      ports.log.info(`federation inquiry sent request=${requestId} target=${input.target} via=hq sent=${sent}`);
      return pending;
    },

    onSiteRequest(fromSite, frame) {
      const route = decideHqInquiryRoute({
        origin: frame.origin,
        target: frame.target,
        fromSite,
        isActiveSite: ports.isActiveSite,
        isConnected: ports.isConnected,
      });
      if (route.kind === "reject") {
        ports.log.warn(`federation inquiry rejected request=${frame.request_id} from=${fromSite}: ${route.error}`);
        ports.sendToSite(fromSite, resultFrame(frame.request_id, failure(frame.target, route.error)));
        return;
      }
      if (route.kind === "forward") {
        broker.relay(frame.request_id, fromSite, route.siteId, frame.timeout_sec * 1000 + INQUIRY_RESPONSE_GRACE_MS);
        const sent = ports.sendToSite(route.siteId, { ...frame, type: "inquiry-request" });
        ports.log.info(`federation inquiry relayed request=${frame.request_id} from=${fromSite} to=${route.siteId} sent=${sent}`);
        if (!sent) ports.sendToSite(fromSite, resultFrame(frame.request_id, failure(route.siteId, `could not send to site: ${route.siteId}`)));
        return;
      }
      void runLocal(INQUIRY_HQ, fromSite, frame).then((outcome) => {
        ports.sendToSite(fromSite, resultFrame(frame.request_id, outcome));
      });
    },

    onSiteResult(fromSite, frame) {
      const accepted = broker.accept(fromSite, frame);
      if (accepted.kind === "relay") {
        ports.sendToSite(accepted.origin, resultFrame(frame.request_id, {
          ok: frame.ok,
          output: frame.output ?? "",
          error: frame.error ?? null,
          executedBy: frame.executed_by,
          durationMs: frame.duration_ms ?? null,
        }));
        return;
      }
      if (accepted.kind === "ignored") ports.log.warn(`federation inquiry result ignored request=${frame.request_id} from=${fromSite}`);
    },

    onHqRequest(frame) {
      const role = ports.role();
      if (role.kind !== "site") return;
      if (frame.target !== role.siteId) {
        ports.sendToHq(resultFrame(frame.request_id, failure(role.siteId, `this site is ${role.siteId}, not ${frame.target}`)));
        return;
      }
      ports.log.info(`federation inquiry received request=${frame.request_id} origin=${frame.origin}`);
      void runLocal(role.siteId, frame.origin, frame).then((outcome) => {
        ports.sendToHq(resultFrame(frame.request_id, outcome));
      });
    },

    onHqResult(frame) {
      // 本社経由で届く結果は、 宛先 (本社自身か中継先の拠点) が executed_by に入る。
      broker.accept(frame.executed_by, frame);
    },

    failAll(error) {
      broker.failAll(error);
    },
  };
}
