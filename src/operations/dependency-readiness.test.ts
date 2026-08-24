/** @implements spec/feature/dependency-readiness.md — readiness state acceptance tests */
import { describe, expect, it, vi } from "vitest";
import type { ExcubitorService } from "../excubitor/client.js";
import { checkDependencyReadiness } from "./dependency-readiness.js";

function service(code: string, state = "running"): ExcubitorService {
  return { code, name: code, port: null, state };
}

describe("dependency readiness", () => {
  it("reports catalog gaps independently instead of guessing endpoints", async () => {
    const report = await checkDependencyReadiness({
      excubitor: {
        listServices: vi.fn(async () => [
          service("augur", "stopped"),
          service("memoria-server"),
          service("revisor"),
        ]),
        isAlive: vi.fn(async (code: string) => code !== "augur"),
      },
      hasRevisorWorkflowToken: () => true,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });

    expect(report.excubitorReachable).toBe(true);
    expect(report.items.find((item) => item.project === "Anatomia")).toMatchObject({
      configured: false,
      state: "error",
    });
    expect(report.items.find((item) => item.project === "Augur")).toMatchObject({
      configured: true,
      requiredRunning: false,
      state: "warn",
    });
    expect(report.items.find((item) => item.project === "Actio")).toMatchObject({
      configured: false,
      state: "error",
    });
  });

  it("requires the Revisor workflow token in addition to catalog liveness", async () => {
    const report = await checkDependencyReadiness({
      excubitor: {
        listServices: vi.fn(async () => [service("revisor")]),
        isAlive: vi.fn(async () => true),
      },
      hasRevisorWorkflowToken: () => false,
    });

    expect(report.items.find((item) => item.project === "Revisor")).toMatchObject({
      configured: false,
      running: true,
      reachable: true,
      state: "error",
    });
  });

  it("fails visibly when Excubitor cannot be reached", async () => {
    const report = await checkDependencyReadiness({
      excubitor: {
        listServices: vi.fn(async () => { throw new Error("offline"); }),
        isAlive: vi.fn(),
      },
      hasRevisorWorkflowToken: () => true,
    });

    expect(report).toMatchObject({
      excubitorReachable: false,
      items: [],
      error: "excubitor_unreachable",
    });
  });

  it("does not copy liveness exception details into the Discord-facing report", async () => {
    const report = await checkDependencyReadiness({
      excubitor: {
        listServices: vi.fn(async () => [service("anatomia")]),
        isAlive: vi.fn(async () => { throw new Error("INTERNAL_DETAIL_SHOULD_NOT_ESCAPE"); }),
      },
      hasRevisorWorkflowToken: () => true,
    });

    const anatomia = report.items.find((item) => item.project === "Anatomia");
    expect(anatomia?.detail).toContain("liveness lookup failed");
    expect(anatomia?.detail).not.toContain("INTERNAL_DETAIL_SHOULD_NOT_ESCAPE");
  });
});
