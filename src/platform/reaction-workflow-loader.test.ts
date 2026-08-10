import { describe, it, expect, afterEach, vi } from "vitest";
import { getRwf, initReactionWorkflow, _resetReactionWorkflowLoader } from "./reaction-workflow-loader.js";

const silentLog = { info: () => {}, warn: () => {} };

afterEach(() => _resetReactionWorkflowLoader());

describe("reaction-workflow-loader", () => {
  it("init 前は同梱エンジン (契約シンボルを備える) を返す", () => {
    const rwf = getRwf();
    expect(typeof rwf.ReactionWorkflowRunner).toBe("function");
    expect(typeof rwf.classifyReactionWorkflow).toBe("function");
    expect(typeof rwf.isStandaloneEmoji).toBe("function");
    expect(typeof rwf.reactionAckText).toBe("function");
  });

  it("外部プラグインが存在しないパスなら同梱にフォールバック (throw しない)", async () => {
    await initReactionWorkflow("E:/no/such/workspace", silentLog);
    // 同梱のまま = classify が既定写像で動く
    expect(getRwf().classifyReactionWorkflow("👍")).toBe("start-impl");
  });

  it("env で空パスでも同梱で安全に動く", async () => {
    process.env.CONCORDIA_RWF_PLUGIN_PATH = "";
    await initReactionWorkflow(null, silentLog);
    expect(getRwf().isStandaloneEmoji("👍")).toBe(true);
    delete process.env.CONCORDIA_RWF_PLUGIN_PATH;
  });

  it("workflow.reaction が無効なら外部プラグインの読み込みを試みない", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };

    await initReactionWorkflow("E:/workspace", log, false);

    expect(log.info).toHaveBeenCalledWith(
      "rwf-loader: workflow.reaction disabled; external plugin load skipped",
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(getRwf().classifyReactionWorkflow("👍")).toBe("start-impl");
  });
});
