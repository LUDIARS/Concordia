import { describe, expect, it } from "vitest";
import { buildDomainReviewReport } from "./report.js";
import type { DomainReviewTarget } from "./types.js";

const target: DomainReviewTarget = {
  code: "Cc",
  project: "Concordia",
  repoPath: "E:/Document/Ars/Concordia",
};

function base() {
  return {
    target,
    trigger: "manual" as const,
    anatomiaProjectId: "concordia",
    businessView: null as unknown,
    programView: null as unknown,
    rawDomains: null,
    plan: null,
  };
}

describe("buildDomainReviewReport", () => {
  it("prepared のペイロードからコアドメイン / 関係 / 層 / 層違反を写す", () => {
    const report = buildDomainReviewReport({
      ...base(),
      businessView: {
        domains: [
          {
            id: "session-lifecycle",
            name: "session-lifecycle",
            purpose: "セッションの生死",
            status: "implemented",
            uxCritical: true,
            parentId: null,
            childIds: ["session-teardown"],
          },
        ],
        relations: [
          { from: "session-lifecycle", to: "chat-platforms", relation: "depends-on", rationale: "面へ出す" },
        ],
        unlinkedProgramDomains: [{ programDomainId: "tooling", codeSymbolCount: 3, codeSymbols: [] }],
      },
      programView: {
        layers: [
          { layer: "application", domains: [{ id: "session-lifecycle", cohesion: 0.8, misfitCount: 2 }] },
        ],
        dependencies: [
          { from: "infrastructure", to: "application", weight: 4, layerViolation: true },
          { from: "application", to: "domain", weight: 9, layerViolation: false },
        ],
        diagnostics: [{ kind: "unclassified", moduleId: "src/misc", symbolIds: [], reason: "no-layer-rule" }],
      },
    });

    expect(report).not.toBeNull();
    expect(report!.source).toBe("prepared");
    expect(report!.coreDomains).toHaveLength(1);
    expect(report!.coreDomains[0]!.uxCritical).toBe(true);
    expect(report!.relations).toHaveLength(1);
    expect(report!.unlinkedProgramDomains).toEqual(["tooling"]);
    expect(report!.layers[0]!.domains[0]!.misfitCount).toBe(2);
    // layerViolation が false の依存は載せない (読み手が見るのは違反だけ)。
    expect(report!.layerViolations).toEqual([{ from: "infrastructure", to: "application", weight: 4 }]);
    expect(report!.unclassifiedModules).toEqual(["src/misc"]);
  });

  it("prepared が無ければ生データへ落ちる", () => {
    const report = buildDomainReviewReport({
      ...base(),
      rawDomains: [
        { domain: "governance", implementorCount: 12, conforms: true, violationCount: 0 },
        { domain: "tooling", implementorCount: 0, conforms: false, violationCount: 3 },
      ],
    });
    expect(report!.source).toBe("raw");
    expect(report!.coreDomains.map((d) => d.name)).toEqual(["governance", "tooling"]);
    expect(report!.coreDomains[1]!.status).toBe("drifted");
    expect(report!.coreDomains[1]!.violationCount).toBe(3);
    expect(report!.layers).toEqual([]);
  });

  it("形の違うペイロードは黙って落とし、例外にしない", () => {
    const report = buildDomainReviewReport({
      ...base(),
      businessView: { domains: [{ nope: 1 }, "文字列", null], relations: "配列ではない" },
      programView: {
        layers: [{ layer: "application", domains: [{ id: "governance" }, "壊れた要素"] }],
        dependencies: { not: "an array" },
        diagnostics: null,
      },
    });
    // 層が読めた分だけ残り、読めなかった要素は 1 件も通らない。
    expect(report).not.toBeNull();
    expect(report!.coreDomains).toEqual([]);
    expect(report!.relations).toEqual([]);
    expect(report!.layers[0]!.domains.map((d) => d.id)).toEqual(["governance"]);
    expect(report!.layerViolations).toEqual([]);
    expect(report!.unclassifiedModules).toEqual([]);
  });

  it("prepared が読めても中身が空で層も plan も無ければ null", () => {
    expect(buildDomainReviewReport({
      ...base(),
      businessView: { domains: [], relations: [] },
    })).toBeNull();
  });

  it("出せる中身が何も無ければ null (= 投稿しない)", () => {
    expect(buildDomainReviewReport(base())).toBeNull();
  });

  it("plan の questions と unresolved を 1 本にまとめる", () => {
    const report = buildDomainReviewReport({
      ...base(),
      rawDomains: [{ domain: "governance", implementorCount: 1, conforms: true, violationCount: 0 }],
      plan: {
        taskHash: "0123456789abcdef",
        questions: ["新規ドメイン xyz の説明は妥当か"],
        unresolved: [{ subject: "src/foo.ts", reason: "どのドメインにも紐付かない" }],
      },
    });
    expect(report!.planTaskHash).toBe("0123456789abcdef");
    expect(report!.planQuestions).toEqual([
      "新規ドメイン xyz の説明は妥当か",
      "src/foo.ts — どのドメインにも紐付かない",
    ]);
  });

  it("plan の問いだけでも投稿材料になる", () => {
    const report = buildDomainReviewReport({
      ...base(),
      plan: { taskHash: "0123456789abcdef", questions: ["問い"], unresolved: [] },
    });
    expect(report).not.toBeNull();
    expect(report!.coreDomains).toEqual([]);
  });
});
