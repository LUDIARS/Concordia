import { EventEmitter } from "node:events";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileOneShot } from "@ludiars/one-shot";
import { readFile, rm, stat } from "node:fs/promises";
import { patrolCodexArgs, runPatrolCodex, runTextCodex } from "./patrol-codex-runner.js";
import { recordLocalOneShot } from "../cost/one-shot-recorder.js";

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "C:/temp/patrol-owned"),
  readFile: vi.fn(async () => "名前: 月野 語\n本文"),
  stat: vi.fn(async () => ({ size: 30 })), rm: vi.fn(async () => undefined),
}));
vi.mock("../model-catalog/codex-command.js", () => ({
  resolveCodexModelCommand: vi.fn(async () => ({ executable: "codex.exe", prefixArgs: [] })),
}));
vi.mock("../cost/one-shot-recorder.js", () => ({ recordLocalOneShot: vi.fn() }));
vi.mock("@ludiars/one-shot", () => ({
  resolveModel: vi.fn(() => "gpt-6-luna"), execFileOneShot: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(stat).mockResolvedValue({ size: 30 } as Awaited<ReturnType<typeof stat>>);
  vi.mocked(execFileOneShot).mockImplementation(((_file: unknown, _args: unknown, _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    queueMicrotask(() => cb(null, "diagnostic output is not the answer", ""));
    return { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn() };
  }) as unknown as typeof execFileOneShot);
});
it("runs and records the selected model with cancellation while retaining tool restrictions", async () => {
  const controller = new AbortController();
  await runTextCodex("summary", { model: "gpt-6-sol", timeoutMs: 1000, signal: controller.signal, purpose: "available-text" });
  expect(execFileOneShot).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["gpt-6-sol", "shell_tool", "mcp_servers={}"]), expect.objectContaining({ signal: controller.signal }), expect.any(Function));
  expect(recordLocalOneShot).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6-sol", provider: "codex" }));
});
describe("patrol Codex isolation and output ownership", () => {
  it("uses Luna/high, disables tools and reads only the final answer file", async () => {
    expect(await runPatrolCodex("素材", 30_000)).toMatchObject({ ok: true, stdout: "名前: 月野 語\n本文" });
    const args = vi.mocked(execFileOneShot).mock.calls[0]![1];
    expect(args).toEqual(patrolCodexArgs("gpt-6-luna", join("C:/temp/patrol-owned", "answer.txt")));
    expect(args).toEqual(expect.arrayContaining(['model_reasoning_effort="high"', "shell_tool", "plugins", "mcp_servers={}"]));
    expect(rm).toHaveBeenCalledWith("C:/temp/patrol-owned", { recursive: true, force: true });
  });
  it("rejects oversized final output and still removes its temporary directory", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 16001 } as Awaited<ReturnType<typeof stat>>);
    expect(await runPatrolCodex("素材", 30_000)).toMatchObject({ ok: false, stderr: "patrol_output_limit" });
    expect(readFile).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledTimes(1);
  });
  it("preserves CLI failures without reading stale output", async () => {
    vi.mocked(execFileOneShot).mockImplementation(((_f: unknown, _a: unknown, _o: unknown,
      cb: (err: Error, stdout: string, stderr: string) => void) => {
      queueMicrotask(() => cb(new Error("timeout"), "", "timeout"));
      return { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn() };
    }) as unknown as typeof execFileOneShot);
    expect(await runPatrolCodex("素材", 30_000)).toMatchObject({ ok: false, stderr: "timeout" });
    expect(readFile).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledTimes(1);
  });
});
