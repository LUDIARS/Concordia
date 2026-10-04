import { expect, it, vi } from "vitest";
import { ConsultationSafetyService } from "./safety-service.js";
import { parseSafetyVerdict } from "./safety-policy.js";

function setup() {
  const ports = { isConsultation: () => true, confidentialTerms: async () => ["fictional-secret-value"],
    classify: vi.fn(async () => '{"decision":"allow","category":"none"}'),
    record: vi.fn(() => "audit1"), notify: vi.fn() };
  return { ports, service: new ConsultationSafetyService(ports) };
}
it("blocks missing ownership data without classifying it as a violation", async () => {
  const { ports } = setup();
  ports.isConsultation = () => { throw Error("missing department"); };
  expect(await new ConsultationSafetyService(ports).check({ sessionId: "s", phase: "prompt", text: "question" }))
    .toEqual({ blocked: true, reason: "guard_unavailable", penaltyEligible: false });
  expect(ports.classify).not.toHaveBeenCalled();
});
it("does not persist an untrusted tool name in audit metadata", async () => {
  const { ports, service } = setup();
  await service.check({ sessionId: "s", phase: "tool", tool: "fictional-secret-value", text: "x" });
  expect(JSON.stringify(ports.record.mock.calls)).not.toContain("fictional-secret-value");
});
it("blocks oversized outputs without sending them to the classifier", async () => {
  const { ports, service } = setup();
  expect(await service.check({ sessionId: "s", phase: "output", text: "x".repeat(50_001) }))
    .toMatchObject({ blocked: true, reason: "guard_unavailable", penaltyEligible: false });
  expect(ports.classify).not.toHaveBeenCalled();
});
it("blocks confidential operations before dispatch without copying input to the audit or notification", async () => {
  const { service, ports } = setup();
  expect(await service.check({ sessionId: "s", phase: "tool", tool: "WebSearch", text: "fictional-secret-value" }))
    .toMatchObject({ blocked: true, reason: "confidential_data", penaltyEligible: true });
  expect(ports.classify).not.toHaveBeenCalled();
  expect(JSON.stringify(ports.record.mock.calls)).not.toContain("fictional-secret-value");
  expect(ports.notify).toHaveBeenCalledWith("audit1");
});
it("distinguishes privacy violations from guard failures and harmless education", async () => {
  const { service, ports } = setup();
  expect(await service.check({ sessionId: "s", phase: "prompt", text: "個人情報を保護する設計を教えて" })).toMatchObject({ blocked: false });
  ports.classify.mockResolvedValueOnce('{"decision":"deny","category":"personal_data"}');
  expect(await service.check({ sessionId: "s", phase: "prompt", text: "private lookup" })).toMatchObject({ blocked: true, penaltyEligible: true });
  ports.classify.mockRejectedValueOnce(Error("offline"));
  expect(await service.check({ sessionId: "s", phase: "prompt", text: "question" })).toMatchObject({ blocked: true, reason: "guard_unavailable", penaltyEligible: false });
  expect(parseSafetyVerdict('{"decision":"allow","category":"personal_data"}').blocked).toBe(true);
});
it("applies to tools and output independently of display settings", async () => {
  const { service, ports } = setup();
  expect(await service.check({ sessionId: "s", phase: "tool", tool: "Bash", text: "cat file" })).toMatchObject({ blocked: true, reason: "unsafe_tool" });
  expect(await service.check({ sessionId: "s", phase: "output", text: "fictional-secret-value" })).toMatchObject({ blocked: true });
  expect(ports.notify).toHaveBeenCalledTimes(2);
});
it("leaves ordinary implementation sessions unchanged", async () => {
  const { ports } = setup(); ports.isConsultation = () => false;
  expect(await new ConsultationSafetyService(ports).check({ sessionId: "s", phase: "tool", tool: "Bash", text: "echo ok" })).toMatchObject({ blocked: false });
  expect(ports.classify).not.toHaveBeenCalled();
});
