import { describe, expect, it } from "vitest";
import {
  buildDomainReviewNoteComponents,
  domainReviewNoteChosenText,
  domainReviewNoteReplyText,
  isDomainReviewNoteCustomId,
  parseDomainReviewNoteCustomId,
} from "./domain-review-note-choice.js";

describe("domain-review note choice", () => {
  it("選択待ちならドメインとプロジェクト全体の StringSelect を出す", () => {
    const components = buildDomainReviewNoteComponents({
      status: "awaiting_choice",
      answer_id: 12,
      choices: [{ value: "combat", label: "combat" }, { value: "*", label: "どのドメインでもない (プロジェクト全体)" }],
      omitted: 0,
    });
    expect(components).toEqual([{
      type: 1,
      components: [{
        type: 3,
        custom_id: "drn:12",
        placeholder: "どのドメインへの指摘か選ぶ",
        min_values: 1,
        max_values: 1,
        options: [
          { label: "combat", value: "combat" },
          { label: "どのドメインでもない (プロジェクト全体)", value: "*" },
        ],
      }],
    }]);
  });

  it("選択待ち以外・選択肢なしでは部品を出さない", () => {
    expect(buildDomainReviewNoteComponents({ status: "sent", answer_id: 1, proposal_id: "p" })).toEqual([]);
    expect(buildDomainReviewNoteComponents({ status: "awaiting_choice", answer_id: 1, choices: [] })).toEqual([]);
  });

  it("ドメイン名のメンションは無害化する", () => {
    const [row] = buildDomainReviewNoteComponents({
      status: "awaiting_choice",
      answer_id: 1,
      choices: [{ value: "x", label: "@everyone" }],
    });
    const select = (row!.components as Array<{ options: Array<{ label: string }> }>)[0]!;
    expect(select.options[0]!.label).not.toBe("@everyone");
  });

  it("custom_id から回答 id を読む", () => {
    expect(isDomainReviewNoteCustomId("drn:12")).toBe(true);
    expect(isDomainReviewNoteCustomId("fqs:12")).toBe(false);
    expect(parseDomainReviewNoteCustomId("drn:12")).toBe(12);
    expect(parseDomainReviewNoteCustomId("drn:abc")).toBeNull();
    expect(parseDomainReviewNoteCustomId("drn:0")).toBeNull();
  });

  it("未送信・拒否は理由を本文に出し、上限で省いたドメイン数を案内する", () => {
    expect(domainReviewNoteReplyText({ status: "failed", answer_id: 3, reason: "domains_unavailable:unreachable" }))
      .toContain("domains_unavailable:unreachable");
    expect(domainReviewNoteReplyText({ status: "rejected", answer_id: 3, reason: "unknown_domain" }))
      .toContain("unknown_domain");
    expect(domainReviewNoteReplyText({ status: "awaiting_choice", answer_id: 3, choices: [], omitted: 6 }))
      .toContain("6 件");
    expect(domainReviewNoteChosenText("neco", { status: "sent", answer_id: 3, domain_id: null, proposal_id: "p-1" }))
      .toContain("プロジェクト全体");
  });
});
