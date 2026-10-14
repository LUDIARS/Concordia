import { describe, expect, it } from "vitest";
import { inheritRequester } from "./requester-inheritance.js";

const parent = JSON.stringify({ subsidiary_id: "glab", discord_requester_user_id: "111111111" });

describe("inheritRequester (spec §3 — 委託の子への依頼者の引き継ぎ)", () => {
  it("body に依頼者が無ければ、 親の依頼者と会社の組を引き継ぐ", () => {
    expect(inheritRequester({ bodyRequesterUserId: null, parentMetadata: parent }))
      .toEqual({ subsidiaryId: "glab", discordUserId: "111111111" });
  });

  it("body に依頼者の指定があれば、 それを優先して引き継がない", () => {
    expect(inheritRequester({ bodyRequesterUserId: "222222222", parentMetadata: parent })).toBeNull();
  });

  it("親に依頼者が無い・会社が無い (本社)・親が無い・metadata が壊れていれば引き継がない", () => {
    expect(inheritRequester({ bodyRequesterUserId: null, parentMetadata: JSON.stringify({ subsidiary_id: "glab" }) })).toBeNull();
    expect(inheritRequester({ bodyRequesterUserId: null, parentMetadata: JSON.stringify({ discord_requester_user_id: "111111111" }) })).toBeNull();
    expect(inheritRequester({ bodyRequesterUserId: undefined, parentMetadata: null })).toBeNull();
    expect(inheritRequester({ bodyRequesterUserId: "  ", parentMetadata: "{broken" })).toBeNull();
  });

  it("孫以降は、 親が引き継いだ組をそのまま渡す (遡って探索しない)", () => {
    const child = JSON.stringify({ personal_budget_requester: { subsidiary_id: "glab", discord_user_id: "111111111" } });
    expect(inheritRequester({ bodyRequesterUserId: null, parentMetadata: child }))
      .toEqual({ subsidiaryId: "glab", discordUserId: "111111111" });
  });

  it("空白だけの body の依頼者は指定なしとして扱う", () => {
    expect(inheritRequester({ bodyRequesterUserId: "  ", parentMetadata: parent }))
      .toEqual({ subsidiaryId: "glab", discordUserId: "111111111" });
  });
});
