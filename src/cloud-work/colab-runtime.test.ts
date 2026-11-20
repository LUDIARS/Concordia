import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ObservationStore } from "../cloud-observation/store.js";
import type { TaskStore } from "../taskflow/store.js";
import { createColabRuntime, settingsColabCredentials } from "./colab-runtime.js";
import { CloudEnvironmentSchema } from "./runtime-config.js";
import type { CloudWorkRuntime } from "./runtime-service.js";
import { readRegisteredColabProgram } from "./colab-program.js";
import { parseColabResult } from "./colab-result.js";
import { GOOGLE_COLAB_SCOPE, GoogleOAuthTokens } from "./google-oauth.js";
import { readHostedWorkerReport } from "./worker-report.js";
import { requestFingerprint } from "./execution-adapter.js";

const owner = { userId: "test-owner", organizationId: "test-org" };
const scope = { repositoryKey: "test-repository", subsidiaryId: null };
const revision = "a".repeat(40);
const credential = { clientId: "test-id", clientSecret: "test-secret", refreshToken: "test-refresh" };

describe("Colab runtime wiring", () => {
  it("binds the configured OAuth reference to the exact owner and purpose without provider calls when listing", async () => {
    const target = CloudEnvironmentSchema.parse({
      id: "colab", label: "Colab", provider: "colab", transferMode: "jupyter", repoPath: "test",
      subsidiaryId: null, environmentId: "test", sourceRevision: revision, publishedBranch: "main",
      standardHosted: true, environmentPreparable: true, requiresLargeProjectClone: false,
      colab: { ownerId: owner.userId, organizationId: owner.organizationId, credentialRef: "test-ref", destination: "owner",
        program: "check.py", programSha256: "b".repeat(64), code: "public", data: "non_confidential",
        runtimeSpec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" },
        maxSeconds: 60, maxUsageUnits: 1, usageUnitsPerMinute: 1 },
    });
    const key = `cloud_work.oauth.${requestFingerprint([owner.organizationId, owner.userId, "colab", "test-ref"])}`;
    const get = vi.fn((name: string) => name === key ? JSON.stringify(credential) : null);
    const credentials = settingsColabCredentials({ get });
    const fetcher = vi.fn<typeof fetch>();
    const runtime = createColabRuntime({ root: tmpdir(), runtime: { targets: async () => [target] } as unknown as CloudWorkRuntime,
      tasks: {} as TaskStore, credentials, fetcher });
    try {
      await expect(runtime.targets(scope, owner)).resolves.toEqual([
        { id: "colab", label: "Colab", destination: "owner", maxSeconds: 60, gpu: "T4", ready: true },
      ]);
      expect(get).toHaveBeenCalledExactlyOnceWith(key);
      expect(credentials.get({ ownerId: owner.userId, organizationId: owner.organizationId, purpose: "drive", ref: "test-ref" })).toBeNull();
      await expect(runtime.targets(scope, { ...owner, userId: "other" })).resolves.toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });

  it("exchanges an injected owner credential for the Colab-only scope", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: "test-token", expires_in: 3600 }));
    const tokens = new GoogleOAuthTokens(credential, {}, fetcher, () => 0, GOOGLE_COLAB_SCOPE);
    await expect(tokens.accessToken()).resolves.toBe("test-token");
    expect(new URLSearchParams(String(fetcher.mock.calls[0][1]?.body)).get("scope")).toBe(GOOGLE_COLAB_SCOPE);
    expect(fetcher.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
  });

  it("reads a notebook only from the pinned revision and checks the bytes before turning its cells into code", async () => {
    const bytes = Buffer.from(JSON.stringify({ nbformat: 4, cells: [
      { cell_type: "markdown", source: "unexecuted text" }, { cell_type: "code", source: ["print(1)"] },
    ] }));
    const programSha256 = createHash("sha256").update(bytes).digest("hex");
    const read = vi.fn(async () => bytes);
    const program = await readRegisteredColabProgram("test-repo", revision, { program: "check.ipynb", programSha256 }, read);
    expect(read).toHaveBeenCalledWith("test-repo", revision, "check.ipynb");
    expect(program).toContain("run_cell");
    expect(program).toContain(Buffer.from(JSON.stringify(["print(1)"])).toString("base64"));
    await expect(readRegisteredColabProgram("test-repo", revision, { program: "check.ipynb", programSha256: "b".repeat(64) }, read))
      .rejects.toThrow("cloud_colab_program_unverified");
  });

  it("does not accept a report from a different run or impossible test totals", () => {
    const report = { version: 1, attemptId: "a", sourceRevision: revision, exitCode: 0, tests: { total: 1, failed: 0, skipped: 0 } };
    expect(parseColabResult(Buffer.from(JSON.stringify(report)), "a", revision, []).exitCode).toBe(0);
    expect(() => parseColabResult(Buffer.from(JSON.stringify({ ...report, attemptId: "other" })), "a", revision, [])).toThrow();
    expect(() => parseColabResult(Buffer.from(JSON.stringify({ ...report, tests: { total: 1, failed: 1, skipped: 1 } })), "a", revision, [])).toThrow();
  });

  it("reads only the terminal worker report and leaves the observation journal untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-worker-report-"));
    const env = { CONCORDIA_CLOUD_OBSERVATION_ENABLED: "true", CONCORDIA_ARTIFACT_ROOT: dir };
    let store: ObservationStore | undefined;
    try {
      expect(readHostedWorkerReport(env, "target", "attempt")).toBeNull();
      store = new ObservationStore(dir);
      store.receive("target", "attempt", { id: "e1", sequence: 1, kind: "progress", message: "processing" }, 10);
      expect(readHostedWorkerReport(env, "target", "attempt")).toBeNull();
      const before = store.receive("target", "attempt", { id: "e2", sequence: 2, kind: "finished", message: "details" }, 15);
      expect(readHostedWorkerReport(env, "target", "attempt")).toEqual({ state: "reported_finished", reportedAt: 15 });
      expect(store.get("target", "attempt")).toEqual(before);
    } finally {
      store?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
