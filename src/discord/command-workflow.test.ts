import { describe, expect, it } from "vitest";
import { commandNamesForRegistration } from "./commands.js";
import {
  isCommandWorkflowEnabled,
  startCommandRegistrationWatch,
  workflowCommandSignature,
  workflowForCommand,
} from "./command-workflow.js";
import { WORKFLOW_KEYS, type WorkflowKey } from "../workflow/keys.js";

describe("コマンドとワークフローの対応", () => {
  it("ワークフローに属するコマンドだけキーを持つ", () => {
    expect(workflowForCommand("mmtask")).toBe("task");
    expect(workflowForCommand("confirm")).toBe("test");
    expect(workflowForCommand("prs")).toBe("review");
    expect(workflowForCommand("rv-prs")).toBe("review");
    // セッションコントロール基盤のコマンドはワークフローに属さない。
    expect(workflowForCommand("spawn")).toBeNull();
    expect(workflowForCommand("end-session")).toBeNull();
  });

  it("属さないコマンドはワークフローが全部無効でも登録対象のまま", () => {
    expect(isCommandWorkflowEnabled("spawn", () => false)).toBe(true);
    expect(isCommandWorkflowEnabled("mmtask", () => false)).toBe(false);
  });
});

describe("commandNamesForRegistration", () => {
  it("既定 (resolver 未指定) では全コマンドを登録する", () => {
    const names = commandNamesForRegistration();
    expect(names).toContain("mmtask");
    expect(names).toContain("confirm");
    expect(names).toContain("prs");
    expect(names).toContain("rv-prs");
    expect(names).toContain("spawn");
  });

  it("workflow.task を無効にすると /mmtask を登録しない", () => {
    const names = commandNamesForRegistration({ isWorkflowEnabled: (key) => key !== "task" });
    expect(names).not.toContain("mmtask");
    expect(names).toContain("confirm");
    expect(names).toContain("spawn");
  });

  it("全ワークフロー無効ならセッションコントロールのコマンドだけ残る", () => {
    const names = commandNamesForRegistration({ isWorkflowEnabled: () => false });
    expect(names).not.toContain("mmtask");
    expect(names).not.toContain("confirm");
    expect(names).not.toContain("prs");
    expect(names).not.toContain("rv-prs");
    expect(names).toContain("spawn");
    expect(names).toContain("end-session");
  });
});

describe("startCommandRegistrationWatch", () => {
  const silentLog = { info: () => {}, warn: () => {} };

  it("フラグが変わったときだけ再登録する", async () => {
    const enabled = new Set<WorkflowKey>(WORKFLOW_KEYS);
    let reregistered = 0;
    const watch = startCommandRegistrationWatch({
      signature: () => workflowCommandSignature((key) => enabled.has(key)),
      reregister: async () => { reregistered += 1; },
      log: silentLog,
    });

    await watch.tick();
    expect(reregistered).toBe(0);

    enabled.delete("task");
    await watch.tick();
    expect(reregistered).toBe(1);

    await watch.tick();
    expect(reregistered).toBe(1);

    enabled.add("task");
    await watch.tick();
    expect(reregistered).toBe(2);

    watch.stop();
  });

  it("再登録が失敗したら次の tick で再試行する", async () => {
    const enabled = new Set<WorkflowKey>(["task"]);
    let attempts = 0;
    const watch = startCommandRegistrationWatch({
      signature: () => workflowCommandSignature((key) => enabled.has(key)),
      reregister: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("discord REST unavailable");
      },
      log: silentLog,
    });

    enabled.delete("task");
    await watch.tick();
    expect(attempts).toBe(1);

    await watch.tick();
    expect(attempts).toBe(2);

    // 成功したので以後は再試行しない。
    await watch.tick();
    expect(attempts).toBe(2);

    watch.stop();
  });
});
