import { describe, expect, it, vi } from "vitest";
import {
  buildCodexWorkerArgs,
  extractModelArg,
  extractReasoningEffort,
  spawnCodexExecWorker,
} from "./codex-worker-spawn.js";
import type { SpawnRequest } from "./spawner.js";

describe("codex worker spawn (pure)", () => {
  it("extracts --model value", () => {
    expect(extractModelArg(["--model", "gpt-5.5", "-c", 'x="y"'])).toBe("gpt-5.5");
    expect(extractModelArg(["-c", 'x="y"'])).toBeNull();
    expect(extractModelArg(undefined)).toBeNull();
  });

  it("extracts reasoning effort from -c config arg (quotes stripped)", () => {
    expect(extractReasoningEffort(["-c", 'model_reasoning_effort="high"'])).toBe("high");
    expect(extractReasoningEffort(["-c", "model_reasoning_effort=xhigh"])).toBe("xhigh");
    expect(extractReasoningEffort(["--model", "gpt-5.5"])).toBeNull();
  });

  it("builds headless worker argv with autonomy flags and prompt-file", () => {
    const req: SpawnRequest = {
      provider: "codex",
      cwd: "E:/wt",
      args: ["--model", "gpt-5.5", "-c", 'model_reasoning_effort="xhigh"'],
    };
    const args = buildCodexWorkerArgs("/tools/worker.mjs", req, "/prompts/run.md");
    expect(args).toEqual([
      "/tools/worker.mjs",
      "--cd=E:/wt",
      "--prompt-file=/prompts/run.md",
      "--model=gpt-5.5",
      "--reasoning=xhigh",
      "--sandbox=danger-full-access",
    ]);
  });

  it("omits model/reasoning flags when absent", () => {
    const req: SpawnRequest = { provider: "codex", cwd: "/wt", args: [] };
    const args = buildCodexWorkerArgs("/w.mjs", req, "/p.md");
    expect(args).toEqual([
      "/w.mjs",
      "--cd=/wt",
      "--prompt-file=/p.md",
      "--sandbox=danger-full-access",
    ]);
  });

  it("errors when prompt file env is missing", () => {
    const req: SpawnRequest = { provider: "codex", cwd: "/wt", args: [], env: {} };
    const r = spawnCodexExecWorker(req, { workerScript: __filename });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/CONCORDIA_DELEGATION_PROMPT_FILE/);
  });

  it("errors when worker script is missing", () => {
    const req: SpawnRequest = {
      provider: "codex",
      cwd: "/wt",
      args: [],
      env: { CONCORDIA_DELEGATION_PROMPT_FILE: __filename },
    };
    const r = spawnCodexExecWorker(req, { workerScript: "E:/does/not/exist-worker.mjs" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/worker script not found/);
  });

  it("spawns node with the worker argv (injected spawn)", () => {
    const fakeChild = { pid: 4321, unref: vi.fn() };
    const spawnFn = vi.fn(() => fakeChild) as unknown as typeof import("node:child_process").spawn;
    const req: SpawnRequest = {
      provider: "codex",
      cwd: "/wt",
      args: ["--model", "gpt-5.5"],
      env: { CONCORDIA_DELEGATION_PROMPT_FILE: __filename },
    };
    const r = spawnCodexExecWorker(req, {
      workerScript: __filename,
      nodeBin: "node",
      spawnFn,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pid).toBe(4321);
      expect(r.command[0]).toBe("node");
      expect(r.command).toContain("--sandbox=danger-full-access");
      expect(r.command).toContain(`--prompt-file=${__filename}`);
    }
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(fakeChild.unref).toHaveBeenCalledOnce();
  });
});
