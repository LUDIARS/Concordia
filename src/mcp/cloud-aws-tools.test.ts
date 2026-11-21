import { expect, it, vi } from "vitest";
import { executeCloudAwsTool } from "./cloud-aws-tools.js";

it("uses the inherited session and only proposes starts", async () => {
  const call = vi.fn(async () => ({ ok: true, status: 202, body: {} }));
  const base = "/v1/delegation/cloud/aws";
  const request = { attemptId: "attempt", taskReference: "actio:work", targetId: "host", runner: "build",
    inputs: {}, deadline: "2026-11-21T03:00:00Z", evidence: { code: "public", data: "non_confidential", destination: "approved" } };
  await executeCloudAwsTool({ operation: "targets" }, "session", call);
  await executeCloudAwsTool({ operation: "start", request }, "session", call);
  await executeCloudAwsTool({ operation: "status", attemptId: "attempt" }, "session", call);
  await executeCloudAwsTool({ operation: "stop", attemptId: "attempt" }, "session", call);
  expect(call.mock.calls).toEqual([
    ["GET", base + "/targets?session_id=session"],
    ["POST", base + "/proposals", { ...request, session_id: "session" }],
    ["GET", base + "/runs/attempt?session_id=session"],
    ["POST", base + "/runs/attempt/stop", { session_id: "session" }],
  ]);
  expect(() => executeCloudAwsTool({ operation: "start", request, ownerApproved: true }, "session", call)).toThrow();
  expect(() => executeCloudAwsTool({ operation: "status" }, undefined, call)).toThrow("cloud_active_session_required");
});
