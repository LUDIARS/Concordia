import { expect, it } from "vitest";
import { injectReference, syncHumanInjectFragments, type HumanInject } from "./inject-instruction-fragments.js";
import { syncInstructionFragments } from "./instruction-fragments.js";

const inject: HumanInject = { sessionId: "s1", repoPath: "E:/Document/Ars/Tirocinium", repoOrigin: "https://github.com/LUDIARS/Tirocinium",
  source: "discord:u1:thread:m1", ts: 100, authorLabel: "neco", text: "面接の評価を 3 段階で出す" };

it("records every human instruction into the registered Pf project", async () => {
  const posted: Array<{ project: string; content: string }> = [];
  const result = await syncHumanInjectFragments({ isPrivateConsultation: () => false,
    sync: input => syncInstructionFragments({ project: async () => "pf-tr", post: async (project, f) => { posted.push({ project, content: f.content }); } }, input) }, inject);
  expect(result).toEqual({ state: "registered", count: 1, project_id: "pf-tr" });
  expect(posted[0]!.project).toBe("pf-tr");
  expect(posted[0]!.content).toContain("「neco」さんの指示");
  expect(posted[0]!.content).toContain("面接の評価を 3 段階で出す");
});

it("keeps short replies too (neco: 全部入れる)", async () => {
  const posted: string[] = [];
  await syncHumanInjectFragments({ isPrivateConsultation: () => false,
    sync: input => syncInstructionFragments({ project: async () => "p", post: async (_p, f) => { posted.push(f.content); } }, input) }, { ...inject, text: "残作業" });
  expect(posted).toHaveLength(1);
});

it("never sends private consultations or bug reports", async () => {
  const ports = (privateConsultation: boolean) => ({ isPrivateConsultation: () => privateConsultation,
    sync: (input: Parameters<typeof syncInstructionFragments>[1]) => syncInstructionFragments({ project: async () => { throw Error("must not resolve"); }, post: async () => { throw Error("must not post"); } }, input) });
  expect(await syncHumanInjectFragments(ports(true), inject)).toEqual({ state: "excluded_private" });
  expect(await syncHumanInjectFragments(ports(false), { ...inject, text: "バグ報告: ログインできない" })).toEqual({ state: "excluded_bug" });
});

it("uses the same reference for a redelivered message and distinguishes id-less sources by time", () => {
  expect(injectReference(inject)).toBe(injectReference({ ...inject, ts: 999 }));
  expect(injectReference({ ...inject, source: "discord:u1" })).not.toBe(injectReference({ ...inject, source: "discord:u1", ts: 999 }));
});

it("does not query Pf without a checkout or text", async () => {
  const ports = { isPrivateConsultation: () => false, sync: async () => { throw Error("must not sync"); } };
  expect(await syncHumanInjectFragments(ports, { ...inject, repoPath: " " })).toEqual({ state: "not_registered" });
  expect(await syncHumanInjectFragments(ports, { ...inject, text: "  " })).toEqual({ state: "not_registered" });
});
