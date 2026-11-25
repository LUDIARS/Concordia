import { describe, expect, it, vi } from "vitest";
import type { InstructionRecord } from "../../agent-instructions/instruction-service.js";
import { applyKaizenResult, type KaizenJudgment } from "./kaizen-applier.js";
import { assessKaizenProposal } from "./kaizen-proposal.js";
import { kaizenCloudLimit } from "./kaizen-settings.js";

const fix = { kind: "cloud_fix", title: "集計の改善", reason: "失敗が3件", target_repo: "Cc", instruction: "集計から重複を除く" };
const judgment = { ...fix, kind: "human_judgment" };

function record(items: unknown[]): InstructionRecord {
  return { id: "inst:dots:20261124T000000Z:000001", agent: "dots", type: "run_task", title: "カイゼン",
    createdAt: "", ackedAt: null, finishedAt: "", status: "done", body: "", params: {}, resultSummary: "要約 @everyone",
    resultDetail: { proposals: items, items: ["所見 https://example.com @here"] } };
}

function setup() {
  const target = vi.fn(async (repo: string) => repo === "/cc" ? { repositoryKey: "/cc", targetId: "cc" } : null);
  const card = vi.fn((_input: KaizenJudgment) => {});
  const submit = vi.fn(async () => ({ state: "submitted", taskReference: "actio:one" }));
  return { target, card, submit, limit: () => 1, projects: () => new Map([["Cc", "/cc"], ["Li", "/li"]]) };
}

describe("daily kaizen proposal application", () => {
  it("submits an eligible fix and puts out-of-scope, over-limit and judgment proposals on cards", async () => {
    const ports = setup();
    const report = await applyKaizenResult(record([{ ...fix, target_repo: "Li" }, fix, fix, judgment]), ports, () => true);
    expect(ports.submit).toHaveBeenCalledOnce();
    expect(ports.submit).toHaveBeenCalledWith(expect.stringMatching(/^kaizen-[a-f0-9]{64}-2$/),
      "/cc", expect.objectContaining({ kind: "cloud_fix" }), { repositoryKey: "/cc", targetId: "cc" }, expect.any(Function), "kaizen-daily");
    expect(ports.card.mock.calls.map(([card]) => card.summary)).toEqual([
      expect.stringContaining("利用不可"), expect.stringContaining("上限"), expect.stringContaining("人間の判断"),
    ]);
    expect(report).toContain("Cloud 受付 1 件・管制カード 3 件");
    expect(report).not.toMatch(/@everyone|@here|https:\/\/example.com/);
  });

  it("rejects unregistered repositories and instructions beyond the limit", async () => {
    const ports = setup();
    const report = await applyKaizenResult(record([{ ...fix, target_repo: "../Cc" }, { ...fix, instruction: "あ".repeat(3001) }]), ports, () => true);
    expect(ports.target).not.toHaveBeenCalled();
    expect(ports.card).not.toHaveBeenCalled();
    expect(report).toContain("不正または件数超過 2 件");
    expect(assessKaizenProposal({ ...fix, instruction: "あ".repeat(3000) }, new Set(["Cc"])).kind).toBe("cloud_fix");
    expect(kaizenCloudLimit(null)).toBe(3);
    expect(kaizenCloudLimit("4")).toBe(4);
  });

  it("reports transport failure and uncertain acceptance and creates judgment cards", async () => {
    const ports = { ...setup(), limit: () => 3 };
    ports.target.mockRejectedValueOnce(new Error("private token"));
    ports.submit.mockResolvedValueOnce({ state: "submission_unknown", taskReference: "actio:unknown" });
    const report = await applyKaizenResult(record([fix, fix]), ports, () => true);
    expect(ports.card.mock.calls.map(([card]) => card.summary)).toEqual([
      expect.stringContaining("設定を照合できません"), expect.stringContaining("受付不明"),
    ]);
    expect(report).toContain("投入経路の失敗 2 件");
    expect(report).not.toContain("private token");
  });
});
