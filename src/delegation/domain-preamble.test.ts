import { describe, expect, it } from "vitest";
import type { DomainMapSearchHit } from "../anatomia/domain-map-client.js";
import {
  buildDomainPreamble,
  domainPreambleEnabled,
  isDomainPreambleTarget,
  pickDelegationTaskText,
  pickProject,
  prependDomainPreamble,
  type DomainPreambleDeps,
} from "./domain-preamble.js";

function hit(project: string, name: string, coreDomain: string | null = null): DomainMapSearchHit {
  return {
    project,
    kind: "content",
    name,
    coreDomain,
    programDomains: [],
    paths: [`renderer/${name}`],
    spec: `spec/feature/${name}.md`,
    score: 10,
  };
}

function deps(over: Partial<DomainPreambleDeps> = {}): DomainPreambleDeps {
  return {
    search: async () => ({ query: "q", hits: [hit("ludellus", "uni-jump", "uni-jump-trampoline")] }),
    plan: async () => "---\ntype: plan\nservice: ludellus\n---\n\n# ドメイン計画",
    ...over,
  };
}

describe("pickProject", () => {
  const hits = [hit("figmentum", "kirie"), hit("pictor", "decals")];

  it("target_repo の basename に一致するプロジェクトを最優先する", () => {
    expect(pickProject(hits, "E:/Document/Ars/Pictor")).toBe("pictor");
  });

  it("worktree (`<Project>-<slug>`) でも拾う", () => {
    expect(pickProject(hits, "E:/Document/Ars/Pictor-feat-kirie")).toBe("pictor");
  });

  it("一致が無ければ最上位ヒット", () => {
    expect(pickProject(hits, "E:/Document/Ars/Unknown")).toBe("figmentum");
  });

  it("ヒットが無ければ null", () => {
    expect(pickProject([], "E:/x")).toBeNull();
  });
});

describe("pickDelegationTaskText", () => {
  it("実装系テンプレの変数名を順に見る", () => {
    expect(pickDelegationTaskText({ task: "  実装する  " })).toBe("実装する");
    expect(pickDelegationTaskText({ description: "壊れている" })).toBe("壊れている");
    expect(pickDelegationTaskText({ goal: "速くする" })).toBe("速くする");
  });
  it("依頼文が無ければ null (織り込みを飛ばす)", () => {
    expect(pickDelegationTaskText({ target_repo: "E:/x" })).toBeNull();
    expect(pickDelegationTaskText({ task: "   " })).toBeNull();
  });
});

describe("buildDomainPreamble", () => {
  it("map 命中 + OKF を先頭に織り込む", async () => {
    const preamble = await buildDomainPreamble(
      { task: "トランポリンカウンターで連続跳躍を数える", targetRepo: "E:/Document/Ars/Ludellus" },
      deps(),
    );
    expect(preamble.source).toBe("map+okf");
    expect(preamble.project).toBe("ludellus");
    expect(preamble.text).toContain("ドメイン先行");
    expect(preamble.text).toContain("uni-jump-trampoline");
    expect(preamble.text).toContain("type: plan");
  });

  it("OKF が取れなければ map 命中だけを書く (委託は止めない)", async () => {
    const preamble = await buildDomainPreamble(
      { task: "何かする" },
      deps({ plan: async () => null }),
    );
    expect(preamble.source).toBe("map");
    expect(preamble.text).toContain("ドメイン定義が無い");
  });

  it("0 件なら『索引に無い』と書いて人間の確認を促す", async () => {
    const preamble = await buildDomainPreamble(
      { task: "まだ無いコンテンツ" },
      deps({ search: async () => ({ query: "q", hits: [] }) }),
    );
    expect(preamble.source).toBe("not-indexed");
    expect(preamble.project).toBeNull();
    expect(preamble.text).toContain("索引に無い");
  });

  it("Anatomia が落ちていれば何も足さない", async () => {
    const preamble = await buildDomainPreamble(
      { task: "何かする" },
      deps({ search: async () => null }),
    );
    expect(preamble).toEqual({ text: "", project: null, source: "none" });
  });

  it("検索が例外を投げても委託を止めない", async () => {
    const preamble = await buildDomainPreamble(
      { task: "何かする" },
      deps({ search: async () => { throw new Error("ECONNREFUSED"); } }),
    );
    expect(preamble.source).toBe("none");
  });

  it("plan が例外を投げても map 命中だけで続ける", async () => {
    const preamble = await buildDomainPreamble(
      { task: "何かする" },
      deps({ plan: async () => { throw new Error("timeout"); } }),
    );
    expect(preamble.source).toBe("map");
  });

  it("依頼文が空なら何もしない", async () => {
    expect((await buildDomainPreamble({ task: "   " }, deps())).text).toBe("");
  });
});

describe("prependDomainPreamble", () => {
  it("前置きを指示書の先頭へ足す", () => {
    const out = prependDomainPreamble("## 実装タスク", {
      text: "## ドメイン先行\n本文", project: "ludellus", source: "map",
    });
    expect(out.startsWith("## ドメイン先行")).toBe(true);
    expect(out).toContain("## 実装タスク");
  });

  it("空の前置きなら元のプロンプトのまま", () => {
    expect(prependDomainPreamble("body", { text: "", project: null, source: "none" })).toBe("body");
  });
});

describe("domainPreambleEnabled", () => {
  it("既定は ON、 明示的な 0 でだけ OFF", () => {
    expect(domainPreambleEnabled({})).toBe(true);
    expect(domainPreambleEnabled({ CONCORDIA_DELEGATION_DOMAIN_PREAMBLE: "0" })).toBe(false);
    expect(domainPreambleEnabled({ CONCORDIA_DELEGATION_DOMAIN_PREAMBLE: "1" })).toBe(true);
  });
});

describe("isDomainPreambleTarget", () => {
  it("実装テンプレだけを対象にし、設計相談とレビューを除外する", () => {
    expect(isDomainPreambleTarget({
      callName: "refactor", title: "局所リファクタ", category: "freelancer",
    })).toBe(true);
    expect(isDomainPreambleTarget({
      callName: "claude-sonnet-5-ask", title: "設計相談", category: "freelancer",
    })).toBe(false);
    expect(isDomainPreambleTarget({
      callName: "review-duo", title: "レビュー", category: "freelancer",
    })).toBe(false);
  });
});
