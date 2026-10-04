import { expect, it } from "vitest";
import { instructionFragments, syncInstructionFragments } from "./instruction-fragments.js";
it("excludes bug items within a mixed implementation request", () => {
  const fragments = instructionFragments("actio:T", "UI 更新", "1. チャットを追加\n2. バグ修正: 表示崩れ\n3. 表を追加");
  expect(fragments).toHaveLength(2);
  expect(fragments.map(f => f.content).join("\n")).not.toContain("表示崩れ");
});
it("never resolves or posts private consultation material", async () => {
  const result = await syncInstructionFragments({ project: async () => { throw Error("must not resolve"); },
    post: async () => { throw Error("must not post"); } }, { repo: "r", origin: null, reference: "actio:T",
    title: "secret", body: "secret", privateConsultation: true });
  expect(result).toEqual({ state: "excluded_private" });
});
it("never sends bug reports to Pf", async () => {
  for (const item of [{ kind: "bug", title: "Layout issue" }, { kind: "実装", title: "不具合修正" }]) {
    expect(await syncInstructionFragments({ project: async () => { throw Error("must not query Pf"); }, post: async () => {} },
      { ...item, repo: "r", origin: "o", reference: "actio:T", body: "x" })).toEqual({ state: "excluded_bug" });
  }
});
it("preserves separate instructions and stable replay identity", () => {
  const items = instructionFragments("actio:T", "Title", "## Changes\n1. first\n continued\n2. second\n## Notes\nprivate notes");
  expect(items).toHaveLength(2);
  expect(items[0]!.content).toContain("1. first\n continued");
  expect(items[1]!.content).not.toContain("private notes");
  expect(instructionFragments("actio:T", "Title", "1. first\n continued")[0]).toEqual(items[0]);
  expect(instructionFragments("actio:U", "Title", "1. first")[0]!.sourceEventId).not.toBe(items[0]!.sourceEventId);
});
it("does not create missing projects and reports partial failures for safe retry", async () => {
  const input = { repo: "r", origin: "o", reference: "actio:T", title: "T", body: "1. one\n2. two" };
  const posted: string[] = [];
  expect(await syncInstructionFragments({ project: async () => null, post: async () => { throw Error(); } }, input)).toEqual({ state: "not_registered" });
  expect(await syncInstructionFragments({ project: async () => "p", post: async f => { posted.push(f); throw Error(); } }, input)).toEqual({ state: "unavailable" });
  expect(posted).toEqual(["p"]);
});
