import { describe, it, expect, afterEach } from "vitest";
import {
  getRwf,
  initReactionWorkflow,
  _isValidRwfModule,
  _resetReactionWorkflowLoader,
} from "./reaction-workflow-loader.js";

const silentLog = { info: () => {}, warn: () => {} };

afterEach(() => _resetReactionWorkflowLoader());

describe("reaction-workflow-loader", () => {
  it("init 前は同梱エンジン (契約シンボルを備える) を返す", () => {
    const rwf = getRwf();
    expect(typeof rwf.ReactionWorkflowRunner).toBe("function");
    expect(typeof rwf.classifyReactionWorkflow).toBe("function");
    expect(typeof rwf.isReservedNonActionEmoji).toBe("function");
    expect(typeof rwf.isStandaloneEmoji).toBe("function");
    expect(typeof rwf.reactionAckText).toBe("function");
    expect(_isValidRwfModule(rwf)).toBe(true);
  });

  it("rejects an external engine that predates the required local-PR listing action", () => {
    const rwf = getRwf();
    const stale = {
      ...rwf,
      WORKFLOW_ACTIONS: rwf.WORKFLOW_ACTIONS.filter((action) => action !== "list-local-prs"),
      classifyReactionWorkflow: (emoji: string) => emoji === "📋" ? null : rwf.classifyReactionWorkflow(emoji),
    };

    expect(_isValidRwfModule(stale)).toBe(false);
  });

  it("rejects an external engine that predates action policies", () => {
    const stale: Partial<ReturnType<typeof getRwf>> = { ...getRwf() };
    delete stale.workflowActionDefaults;
    delete stale.WORKFLOW_ACTION_POLICY_CAPABILITIES;

    expect(_isValidRwfModule(stale)).toBe(false);
  });

  it("rejects an external engine that assigns the reserved OK-hand emoji", () => {
    const rwf = getRwf();
    const unsafe = {
      ...rwf,
      classifyReactionWorkflow: (emoji: string) =>
        emoji.trim() === "👌" ? "handoff-document" as const : rwf.classifyReactionWorkflow(emoji),
    };

    expect(_isValidRwfModule(unsafe)).toBe(false);
  });

  it("rejects an external engine that leaves an OK-hand display variant actionable", () => {
    const rwf = getRwf();
    const unsafe = {
      ...rwf,
      isReservedNonActionEmoji: (emoji: string) => emoji.trim() === "👌",
      classifyReactionWorkflow: (emoji: string) =>
        emoji.trim() === "👌🏽" ? "handoff-document" as const : rwf.classifyReactionWorkflow(emoji),
    };

    expect(_isValidRwfModule(unsafe)).toBe(false);
  });

  it("rejects an external engine that exposes the reserved emoji in its default map", () => {
    const rwf = getRwf();
    const unsafe = {
      ...rwf,
      defaultReactionEmojiMap: () => ({
        ...rwf.defaultReactionEmojiMap(),
        "👌": "handoff-document" as const,
      }),
    };

    expect(_isValidRwfModule(unsafe)).toBe(false);
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

});
