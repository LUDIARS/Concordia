import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRwf, initReactionWorkflow, _resetReactionWorkflowLoader } from "./reaction-workflow-loader.js";
afterEach(() => { _resetReactionWorkflowLoader(); vi.unstubAllEnvs(); });
it("does not execute an existing external module, and reports the retired setting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-rwf-retired-"));
  try {
    const path = join(dir, "plugin.mjs");
    await writeFile(path, "throw new Error('external module executed');", "utf8");
    vi.stubEnv("CONCORDIA_RWF_PLUGIN_PATH", path);
    const log = { info: vi.fn(), warn: vi.fn() };
    await initReactionWorkflow(dir, log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("retired"));
    expect(getRwf().classifyReactionWorkflow("📋")).toBe("list-local-prs");
    expect(getRwf().classifyReactionWorkflow("👌🏽")).toBeNull();
    await initReactionWorkflow(dir, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
