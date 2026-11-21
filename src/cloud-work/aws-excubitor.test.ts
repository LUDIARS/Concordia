import { describe, expect, it, vi } from "vitest";
import { awsExcubitorAdapter, awsExcubitorTransport } from "./aws-excubitor.js";
import { awsJobEvidence } from "./aws-policy.js";
import type { AwsJob } from "./aws-excubitor-schema.js";

const operation = "cf00fb85-4ded-40b0-8bcb-99abbcde865d";
const job: AwsJob = {
  operation_id: operation, job_id: "cc-key", target_id: "host", runner: "run", kind: "ec2",
  deadline: "2026-11-21T03:00:00Z", submission: "accepted", release: "confirmed", provider_state: "terminated",
  containers: [], observed_at: "2026-11-21T02:55:00Z", stop_requested_at: null, issue: null,
};

describe("Excubitor AWS transport", () => {
  it("resolves the catalog port and keeps all requests loopback without redirect or credentials", async () => {
    const fake = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: "excubitor", port: null, catalog_snapshot: { port: 43210 } }))
      .mockResolvedValueOnce(Response.json({ service: "excubitor" }))
      .mockResolvedValueOnce(Response.json({ targets: [], owner: "ex", credentials: { configured: false } }));
    const adapter = awsExcubitorTransport({ CONCORDIA_EXCUBITOR_URL: "http://127.0.0.1:43211" }, fake);
    await expect(adapter.targets()).resolves.toMatchObject({ targets: [] });
    expect(fake.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:43211/api/v1/services/excubitor", "http://127.0.0.1:43210/health",
      "http://127.0.0.1:43210/api/v1/aws-compute/targets",
    ]);
    expect(fake.mock.calls.every(([, init]) => init?.redirect === "error" && !init.headers)).toBe(true);
    await expect(awsExcubitorTransport({ CONCORDIA_EXCUBITOR_URL: "http://outside.invalid" }, fake).targets()).rejects.toThrow();
    expect(fake).toHaveBeenCalledTimes(3);
  });

  it("pages inactive jobs too, matches key and target, and never resends on lookup", async () => {
    const request = vi.fn(async (path: string, _body?: unknown) => ({ status: 200, body: { jobs: path.endsWith("=0")
      ? Array.from({ length: 100 }, (_, index) => ({ ...job, job_id: "unrelated-" + index }))
      : [job] } }));
    const adapter = awsExcubitorAdapter(request);
    const identity = { requestId: "cc-key", targetId: "host", runner: "run" };
    await expect(adapter.reconcile(identity)).resolves.toEqual(job);
    expect(request.mock.calls.map(([path, body]) => [path, body])).toEqual([
      ["/jobs?active=false&limit=100&offset=0", undefined], ["/jobs?active=false&limit=100&offset=100", undefined],
    ]);
    await expect(adapter.reconcile({ ...identity, runner: "wrong" })).resolves.toBeUndefined();
  });

  it("does not infer EC2 success from a released instance", () => {
    expect(awsJobEvidence(job)).toEqual({ providerTerminal: "unknown", resourceRelease: "released", exitCode: null, stopProgress: "none" });
  });
});
