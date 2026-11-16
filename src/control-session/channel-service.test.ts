import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { handleControlChannelPost, renderDispatchSummary, type ControlChannelDeps } from "./channel-service.js";

const sessions = [
  { id: "cc1", repo_path: "Cc" }, { id: "at1", repo_path: "At" }, { id: "ctl", repo_path: "ctl" },
] as SessionRow[];

function deps(patch: Partial<ControlChannelDeps> = {}) {
  const dispatched: Array<{ targets: string[]; text: string }> = [];
  const asked: string[] = [];
  const value: ControlChannelDeps = {
    isEnabled: () => true,
    activeSessions: () => sessions,
    projectOf: (s) => s.repo_path,
    isControlSession: (s) => s.id === "ctl",
    boardRows: () => [],
    dispatch: async (input) => { dispatched.push(input); return { delivered: input.targets.slice(0, 1), skipped: input.targets.slice(1).map((id) => ({ session_id: id, reason: "human_wait" as const })) }; },
    answer: async (input) => { asked.push(input.question); return { ok: true, reply: "2 件動いています" }; },
    nowSec: () => 0,
    ...patch,
  };
  return { value, dispatched, asked };
}

const post = (content: string, allowed = true) => ({ actorLabel: "neco", allowed, content });

describe("handleControlChannelPost", () => {
  it("answers status questions through the side session", async () => {
    const d = deps();
    expect(await handleControlChannelPost(d.value, post("いま何が動いてる？"))).toBe("2 件動いています");
    expect(d.asked).toEqual(["いま何が動いてる？"]);
    expect(d.dispatched).toEqual([]);
  });

  it("sends bulk instructions to every worker except the control session", async () => {
    const d = deps();
    const reply = await handleControlChannelPost(d.value, post("一括: 状況を報告して"));
    expect(d.dispatched).toEqual([{ targets: ["cc1", "at1"], text: "状況を報告して", origin: { kind: "human", label: "neco" } }]);
    expect(reply).toContain("届けた: 1 件");
    expect(reply).toContain("送らなかった (人間待ち (human-wait)): 1 件");
  });

  it("narrows bulk instructions by project code", async () => {
    const d = deps();
    await handleControlChannelPost(d.value, post("一括[cc]: main を取り込んで"));
    expect(d.dispatched[0].targets).toEqual(["cc1"]);
    expect(await handleControlChannelPost(d.value, post("一括[Xx]: x"))).toBe("対象のセッションがありません。");
  });

  it("refuses posts while disabled or from people without session control", async () => {
    const d = deps();
    expect(await handleControlChannelPost(deps({ isEnabled: () => false }).value, post("一括: x"))).toContain("OFF");
    expect(await handleControlChannelPost(d.value, post("一括: x", false))).toContain("許可された人だけ");
    expect(d.dispatched).toEqual([]);
  });

  it("tells the human to wait when side sessions are busy", async () => {
    const d = deps({ answer: async () => ({ ok: false, reason: "busy" }) });
    expect(await handleControlChannelPost(d.value, post("状況は？"))).toContain("少し待って");
  });

  it("counts undeliverable sessions separately", () => {
    expect(renderDispatchSummary({ delivered: [], skipped: [{ session_id: "a", reason: "undeliverable" }] }))
      .toBe("届けた: 0 件\n送らなかった (届けられない): 1 件");
  });
});
