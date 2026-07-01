import { describe, it, expect } from "vitest";
import { parseRequesterSource, lastHumanRequester, prefixRequesterTag } from "./requester.js";
import type { SessionEventRow } from "../shared/types.js";

function ev(kind: string, payload: object, ts = 0): SessionEventRow {
  return { id: ts, session_id: "s", ts, kind, payload: JSON.stringify(payload) };
}

describe("parseRequesterSource", () => {
  it("discord/slack の uid を解析する", () => {
    expect(parseRequesterSource("discord:123:456:789")).toEqual({ platform: "discord", userId: "123" });
    expect(parseRequesterSource("slack:U42:C1:1700")).toEqual({ platform: "slack", userId: "U42" });
  });
  it("制御 inject / 非文字列は null", () => {
    expect(parseRequesterSource("discord-enter-fallback")).toBeNull();
    expect(parseRequesterSource("initial-work")).toBeNull();
    expect(parseRequesterSource(null)).toBeNull();
    expect(parseRequesterSource("discord:")).toBeNull();
  });
});

describe("lastHumanRequester", () => {
  it("新しい順の中で最後の人間 inject を返す (制御injectは飛ばす)", () => {
    // recentEvents は ts DESC (新しい順) で渡る想定
    const events = [
      ev("inject", { text: "x", source: "discord-enter-fallback" }, 30), // 制御 → skip
      ev("prompt", {}, 25),
      ev("inject", { text: "y", source: "discord:111:c:m" }, 20), // ← これが最新の人間
      ev("inject", { text: "z", source: "discord:222:c:m" }, 10),
    ];
    expect(lastHumanRequester(events)).toEqual({ platform: "discord", userId: "111" });
  });
  it("人間 inject が無ければ null", () => {
    expect(lastHumanRequester([ev("inject", { source: "initial-work" }), ev("prompt", {})])).toBeNull();
    expect(lastHumanRequester([])).toBeNull();
  });
  it("壊れた payload は飛ばす", () => {
    const broken: SessionEventRow = { id: 1, session_id: "s", ts: 1, kind: "inject", payload: "{not json" };
    const good = ev("inject", { source: "discord:9:c:m" }, 0);
    expect(lastHumanRequester([broken, good])).toEqual({ platform: "discord", userId: "9" });
  });
});

describe("prefixRequesterTag", () => {
  it("本文に 1 行で前置する (改行なし)", () => {
    const out = prefixRequesterTag("構橋 慧", "ボタンを赤くして");
    expect(out).toBe("「構橋 慧」さんからの指示: ボタンを赤くして");
    expect(out).not.toContain("\n");
  });
});
