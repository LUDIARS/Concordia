import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import type { TaskStore } from "../taskflow/store.js";
import { readAwsBindings } from "./aws-config.js";
import { createAwsRuntime } from "./aws-runtime.js";

const tasks: TaskStore = {
  scan: async () => [], findForProject: async () => [], findByRelativePath: async () => null,
  relativePath: () => "", writeRemainingTasks: async () => ({ created: [], existed: [] }),
};
const binding = { repoPath: process.cwd(), subsidiaryId: null, ownerId: "owner", organizationId: "org",
  targetId: "configured-host", runner: "build", destination: "approved", maxSeconds: 90, usageUnitsPerMinute: 2, maxUsageUnits: 2 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cc-aws-config-"));
  const path = join(root, "targets.json");
  return { root, path, write(value: unknown) { writeFileSync(path, JSON.stringify(value), "utf8"); },
    close() { rmSync(path, { force: true }); rmdirSync(root); } };
}

afterEach(() => vi.unstubAllGlobals());

describe("AWS runtime configuration", () => {
  it("rejects duplicate bindings and unknown fields, and supports an unconfigured installation", async () => {
    const file = fixture();
    try {
      await expect(readAwsBindings(file.path)).resolves.toEqual([]);
      file.write([binding, binding]);
      await expect(readAwsBindings(file.path)).rejects.toThrow("cloud_configuration_invalid");
      file.write([{ ...binding, endpoint: "http://outside.invalid" }]);
      await expect(readAwsBindings(file.path)).rejects.toThrow("cloud_configuration_invalid");
    } finally { file.close(); }
  });

  it("makes no startup requests and lists only authorized Excubitor targets for the canonical repository", async () => {
    const file = fixture();
    file.write([binding]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: "excubitor", catalog_snapshot: { port: 43210 } }))
      .mockResolvedValueOnce(Response.json({ service: "excubitor" }))
      .mockResolvedValueOnce(Response.json({ owner: "excubitor", credentials: { configured: true },
        targets: ["configured-host", "unbound-host"].map(id => ({
          id, name: id, kind: "ec2", maxRuntimeSeconds: 300, runners: [{ id: "build", inputKeys: ["MODE"] }],
        })) }));
    vi.stubGlobal("fetch", fetcher);
    const service = createAwsRuntime({ root: file.root, tasks, env: {
      CONCORDIA_CLOUD_AWS_CONFIG_FILE: file.path, CONCORDIA_EXCUBITOR_URL: "http://127.0.0.1:43211",
    } });
    try {
      const scope = { repositoryKey: await mainRepositoryKey(binding.repoPath), subsidiaryId: null };
      const actor = { sessionId: "session", owner: { userId: "owner", organizationId: "org" } };
      expect(fetcher).not.toHaveBeenCalled();
      await expect(service.targets({ ...scope, subsidiaryId: "other" }, actor)).resolves.toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
      await expect(service.targets(scope, actor)).resolves.toEqual([{
        id: "configured-host", name: "configured-host", kind: "ec2",
        runners: [{ id: "build", destination: "approved", inputKeys: ["MODE"], maxSeconds: 60, ready: true }],
      }]);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      await service.close();
      file.close();
    }
  });
});
