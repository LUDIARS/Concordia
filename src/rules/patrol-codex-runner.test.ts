import { EventEmitter } from "node:events";
import { join } from "node:path";
// vitest.config.ts は isolate:false なので module registry がファイル間で共有される。
// 先に別ファイルが本物の依存で読んだ実装が残っていると、この file の vi.mock が効かず
// 本物の使用量取得や CLI 起動が走る (全体実行でだけ落ちる)。各テストで resetModules して
// import し直し、この file の mock 実体だけを見るようにする (context-report.test.ts と同じ形)。
import { beforeEach, describe, expect, it, vi } from "vitest";

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
let execFileOneShot: typeof import("@ludiars/one-shot")["execFileOneShot"];
let readFile: typeof import("node:fs/promises")["readFile"];
let rm: typeof import("node:fs/promises")["rm"];
let stat: typeof import("node:fs/promises")["stat"];
let patrolCodexArgs: typeof import("./patrol-codex-runner.js")["patrolCodexArgs"];
let runPatrolCodex: typeof import("./patrol-codex-runner.js")["runPatrolCodex"];
let runTextCodex: typeof import("./patrol-codex-runner.js")["runTextCodex"];
let recordLocalOneShot: typeof import("../cost/one-shot-recorder.js")["recordLocalOneShot"];
beforeEach(async () => {
  vi.resetModules();
  ({ execFileOneShot } = await import("@ludiars/one-shot"));
  ({ readFile, rm, stat } = await import("node:fs/promises"));
  ({ patrolCodexArgs, runPatrolCodex, runTextCodex } = await import("./patrol-codex-runner.js"));
  ({ recordLocalOneShot } = await import("../cost/one-shot-recorder.js"));
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
