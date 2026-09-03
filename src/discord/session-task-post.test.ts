import { describe, it, expect, vi } from "vitest";
import { BLANK_SESSION_TASK } from "../shared/session-task.js";
import {
  buildSessionTaskMessage,
  DISCORD_TASK_PINNED_KEY,
  DISCORD_TASK_POSTED_KEY,
  postSessionTaskBody,
  shouldPinSessionTask,
  stripDelegationInjectHeader,
  taskKindForInjectSource,
} from "./session-task-post.js";

describe("taskKindForInjectSource", () => {
  it("委託由来の suffix を種別へ写す", () => {
    expect(taskKindForInjectSource("delegation:run-1:followup")).toBe("followup");
    expect(taskKindForInjectSource("delegation:run-1:parent")).toBe("parent");
    expect(taskKindForInjectSource("delegation:run-1:followup-memoria")).toBe("supplement");
  });

  it("委託由来でない source は null (Slack 転記・制御 inject を巻き込まない)", () => {
    expect(taskKindForInjectSource("slack:U123")).toBeNull();
    expect(taskKindForInjectSource("discord-enter")).toBeNull();
    expect(taskKindForInjectSource("delegation:run-1")).toBeNull();
    expect(taskKindForInjectSource(null)).toBeNull();
  });
});

describe("stripDelegationInjectHeader", () => {
  it("運搬用ヘッダを落として本文だけにする", () => {
    expect(stripDelegationInjectHeader("[delegation:run-1] Parent instruction\n\n## 第 2 段階\n本文"))
      .toBe("## 第 2 段階\n本文");
  });

  it("ヘッダが無い本文はそのまま", () => {
    expect(stripDelegationInjectHeader("## 第 2 段階\n本文")).toBe("## 第 2 段階\n本文");
  });

  it("本文中の同形の行は落とさない (先頭のみ)", () => {
    expect(stripDelegationInjectHeader("本文\n[delegation:run-1] Parent instruction\n続き"))
      .toBe("本文\n[delegation:run-1] Parent instruction\n続き");
  });
});

describe("shouldPinSessionTask", () => {
  const base = { kind: "startup" as const, taskText: "Cc の修正", stagedPending: false, alreadyPinned: false };

  it("最初のタスク本文は pin する", () => {
    expect(shouldPinSessionTask(base)).toBe(true);
  });

  it("「何もするな」は pin しない", () => {
    expect(shouldPinSessionTask({ ...base, taskText: BLANK_SESSION_TASK })).toBe(false);
  });

  it("段階注入の第 1 段階 (調査ブリーフ) は pin しない — 本文はまだ届いていない", () => {
    expect(shouldPinSessionTask({ ...base, stagedPending: true })).toBe(false);
  });

  it("段階注入の第 2 段階は pin する", () => {
    expect(shouldPinSessionTask({ ...base, kind: "followup" })).toBe(true);
  });

  it("補足・追加指示は最初のタスク本文ではないので pin しない", () => {
    expect(shouldPinSessionTask({ ...base, kind: "supplement" })).toBe(false);
    expect(shouldPinSessionTask({ ...base, kind: "parent" })).toBe(false);
  });

  it("pin 済みなら 2 通目以降は pin しない", () => {
    expect(shouldPinSessionTask({ ...base, kind: "followup", alreadyPinned: true })).toBe(false);
  });

  it("空文は pin しない", () => {
    expect(shouldPinSessionTask({ ...base, taskText: "   " })).toBe(false);
  });
});

describe("buildSessionTaskMessage", () => {
  it("見出し付きでタスク本文をそのまま載せる (mention は展開しない)", () => {
    const msg = buildSessionTaskMessage({ kind: "startup", taskText: "  <@everyone> を直す  " });
    expect(msg.content).toBe("📋 **タスク**\n\n<@everyone> を直す");
    expect(msg.allowedMentions).toEqual({ parse: [] });
  });

  it("第 2 段階は段階が分かる見出しにする", () => {
    expect(buildSessionTaskMessage({ kind: "followup", taskText: "実装する" }).content)
      .toContain("第 2 段階");
  });
});

function makeDeps(sent: { id: string } | null = { id: "msg-1" }) {
  return {
    webhooks: {
      getForSession: vi.fn(async () => ({}) as never),
      send: vi.fn(async () => sent),
    },
    sessionsRepo: { mergeMetadata: vi.fn() },
    log: { warn: vi.fn() },
  };
}

const POST_BASE = {
  sessionId: "sess-1",
  channelId: "chan-1",
  kind: "startup" as const,
  taskText: "Cc の修正",
  stagedPending: false,
  alreadyPinned: false,
};

describe("postSessionTaskBody", () => {
  it("投稿して pin し、両方の事実を metadata へ焼く", async () => {
    const deps = makeDeps();
    const pin = vi.fn(async () => true);
    const ok = await postSessionTaskBody({ ...POST_BASE, ...deps, pin });
    expect(ok).toBe(true);
    expect(pin).toHaveBeenCalledWith("chan-1", "msg-1");
    expect(deps.sessionsRepo.mergeMetadata).toHaveBeenCalledWith("sess-1", {
      [DISCORD_TASK_POSTED_KEY]: true,
      [DISCORD_TASK_PINNED_KEY]: true,
    });
  });

  it("「何もするな」は投稿するが pin しない", async () => {
    const deps = makeDeps();
    const pin = vi.fn(async () => true);
    await postSessionTaskBody({ ...POST_BASE, taskText: BLANK_SESSION_TASK, ...deps, pin });
    expect(deps.webhooks.send).toHaveBeenCalledTimes(1);
    expect(pin).not.toHaveBeenCalled();
    expect(deps.sessionsRepo.mergeMetadata).toHaveBeenCalledWith("sess-1", {
      [DISCORD_TASK_POSTED_KEY]: true,
    });
  });

  it("pin が権限不足で失敗しても投稿は成立させ、pin 済みにはしない", async () => {
    const deps = makeDeps();
    const ok = await postSessionTaskBody({ ...POST_BASE, ...deps, pin: vi.fn(async () => false) });
    expect(ok).toBe(true);
    expect(deps.log.warn).toHaveBeenCalled();
    expect(deps.sessionsRepo.mergeMetadata).toHaveBeenCalledWith("sess-1", {
      [DISCORD_TASK_POSTED_KEY]: true,
    });
  });

  it("空のタスク本文では何も投稿しない", async () => {
    const deps = makeDeps();
    const ok = await postSessionTaskBody({ ...POST_BASE, taskText: "  ", ...deps, pin: vi.fn(async () => true) });
    expect(ok).toBe(false);
    expect(deps.webhooks.send).not.toHaveBeenCalled();
    expect(deps.sessionsRepo.mergeMetadata).not.toHaveBeenCalled();
  });

  it("送信に失敗したら投稿済みフラグを立てない (次回の再投稿を残す)", async () => {
    const deps = makeDeps(null);
    const ok = await postSessionTaskBody({ ...POST_BASE, ...deps, pin: vi.fn(async () => true) });
    expect(ok).toBe(false);
    expect(deps.sessionsRepo.mergeMetadata).not.toHaveBeenCalled();
  });
});
