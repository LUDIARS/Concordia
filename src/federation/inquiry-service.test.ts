import { describe, expect, it } from "vitest";
import type { FederationFrameInput, FederationInquiryRequestFrame, FederationInquiryResultFrame } from "./protocol.js";
import { FEDERATION_PROTOCOL_VERSION } from "./protocol.js";
import { createInquiryService, type InquiryService } from "./inquiry-service.js";
import type { InquiryRunner } from "./inquiry-runner.js";

const quietLog = { info: () => {}, warn: () => {} };

function runnerFor(name: string, calls: string[]): InquiryRunner {
  return async (request) => {
    calls.push(`${name}<-${request.origin}:${request.prompt}`);
    return { ok: true, output: `${name} answered ${request.prompt}`, error: null, durationMs: 5 };
  };
}

/** 本社 1 + 拠点 2 (melpot / aws) を、 WS の代わりに非同期の関数呼び出しでつなぐ。 */
function federation(opts: { online?: string[]; siteRunners?: boolean } = {}) {
  const online = new Set(opts.online ?? ["melpot", "aws"]);
  const calls: string[] = [];
  const services: Record<string, InquiryService> = {};
  const deliver = (fn: () => void) => { setTimeout(fn, 0); };
  const asFrame = <T>(frame: FederationFrameInput) => ({ ...frame, v: FEDERATION_PROTOCOL_VERSION }) as T;

  services.hq = createInquiryService({
    role: () => ({ kind: "hq" }),
    sendToSite: (siteId, frame) => {
      if (!online.has(siteId)) return false;
      deliver(() => frame.type === "inquiry-request"
        ? services[siteId]!.onHqRequest(asFrame<FederationInquiryRequestFrame>(frame))
        : services[siteId]!.onHqResult(asFrame<FederationInquiryResultFrame>(frame)));
      return true;
    },
    sendToHq: () => false,
    isActiveSite: (id) => id === "melpot" || id === "aws",
    isConnected: (id) => online.has(id),
    runner: () => runnerFor("hq", calls),
    log: quietLog,
  });
  for (const siteId of ["melpot", "aws"]) {
    services[siteId] = createInquiryService({
      role: () => ({ kind: "site", siteId }),
      sendToSite: () => false,
      sendToHq: (frame) => {
        if (!online.has(siteId)) return false;
        deliver(() => frame.type === "inquiry-request"
          ? services.hq!.onSiteRequest(siteId, asFrame<FederationInquiryRequestFrame>(frame))
          : services.hq!.onSiteResult(siteId, asFrame<FederationInquiryResultFrame>(frame)));
        return true;
      },
      isActiveSite: () => false,
      isConnected: () => false,
      runner: () => opts.siteRunners === false ? null : runnerFor(siteId, calls),
      log: quietLog,
    });
  }
  return { services, calls };
}

describe("inquiry service", () => {
  it("HQ asks a site and receives its answer", async () => {
    const { services, calls } = federation();
    const outcome = await services.hq!.request({ target: "melpot", prompt: "ログを見て" });
    expect(outcome).toMatchObject({ ok: true, executedBy: "melpot", output: "melpot answered ログを見て" });
    expect(calls).toEqual(["melpot<-hq:ログを見て"]);
  });

  it("a site asks HQ", async () => {
    const { services, calls } = federation();
    const outcome = await services.melpot!.request({ target: "hq", prompt: "版は?" });
    expect(outcome).toMatchObject({ ok: true, executedBy: "hq" });
    expect(calls).toEqual(["hq<-melpot:版は?"]);
  });

  it("a site asks another site through HQ", async () => {
    const { services, calls } = federation();
    const outcome = await services.aws!.request({ target: "melpot", prompt: "状態" });
    expect(outcome).toMatchObject({ ok: true, executedBy: "melpot", output: "melpot answered 状態" });
    expect(calls).toEqual(["melpot<-aws:状態"]);
  });

  it("runs locally when a site targets itself", async () => {
    const { services, calls } = federation();
    expect((await services.melpot!.request({ target: "melpot", prompt: "x" })).executedBy).toBe("melpot");
    expect(calls).toEqual(["melpot<-melpot:x"]);
  });

  it("reports an offline target without waiting for the timeout", async () => {
    const { services } = federation({ online: ["aws"] });
    const fromHq = await services.hq!.request({ target: "melpot", prompt: "x" });
    expect(fromHq).toMatchObject({ ok: false, error: "site is offline: melpot" });
    const fromSite = await services.aws!.request({ target: "melpot", prompt: "x" });
    expect(fromSite).toMatchObject({ ok: false, error: "site is offline: melpot" });
  });

  it("returns the target's error when it has no runner", async () => {
    const { services } = federation({ siteRunners: false });
    const outcome = await services.hq!.request({ target: "aws", prompt: "x" });
    expect(outcome).toMatchObject({ ok: false, executedBy: "aws", error: "inquiry runner is unavailable on this Concordia" });
  });

  it("ignores a result from a site other than the target", async () => {
    const { services } = federation();
    const pending = services.hq!.request({ target: "melpot", prompt: "x" });
    services.hq!.onSiteResult("aws", {
      v: FEDERATION_PROTOCOL_VERSION, type: "inquiry-result", request_id: "unknown", ok: true, output: "forged", executed_by: "aws",
    });
    expect((await pending).output).toBe("melpot answered x");
  });

  it("fails pending inquiries when the link drops", async () => {
    const services = createInquiryService({
      role: () => ({ kind: "site", siteId: "melpot" }),
      sendToSite: () => false,
      sendToHq: () => true,
      isActiveSite: () => false,
      isConnected: () => false,
      runner: () => null,
      log: quietLog,
    });
    const pending = services.request({ target: "hq", prompt: "x", timeoutSec: 30 });
    services.failAll("HQ link closed");
    expect(await pending).toMatchObject({ ok: false, error: "HQ link closed" });
  });
});
