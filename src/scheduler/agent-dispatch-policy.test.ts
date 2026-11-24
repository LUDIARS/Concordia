import { describe, expect, it } from "vitest";
import {
  buildDedupeKey,
  fitParams,
  isClosedByConcordia,
  parseAgentChoice,
  parseCronInstructionParams,
  scrubText,
} from "./agent-dispatch-policy.js";

// spec/feature/parttimer-agent-dispatch.md
describe("agent-dispatch-policy", () => {
  it("宛先は '' / null を従来の委託、 dots / muse を外部エージェントと解釈し、 それ以外を拒否する", () => {
    expect(parseAgentChoice("")).toEqual({ ok: true, agent: null });
    expect(parseAgentChoice(null)).toEqual({ ok: true, agent: null });
    expect(parseAgentChoice(" dots ")).toEqual({ ok: true, agent: "dots" });
    expect(parseAgentChoice("muse")).toEqual({ ok: true, agent: "muse" });
    expect(parseAgentChoice("gemini").ok).toBe(false);
    expect(parseAgentChoice(1).ok).toBe(false);
  });

  it("dedupe_key は JST の分単位で、 同じ分の発火は同じキーになる", () => {
    expect(buildDedupeKey("kaizen", "", new Date("2026-11-23T15:00:59Z"))).toBe("cron:kaizen:-:2026-11-24T00:00");
    expect(buildDedupeKey("kaizen", "", new Date("2026-11-23T15:00:01Z"))).toBe(buildDedupeKey("kaizen", "", new Date("2026-11-23T15:00:59Z")));
    expect(buildDedupeKey("standup", "alpha", new Date("2026-11-23T15:01:00Z"))).toBe("cron:standup:alpha:2026-11-24T00:01");
  });

  it("fitParams は収まるなら手を入れず、 収まらなければ長い配列の末尾から落とす。 落とせないなら throw", () => {
    expect(fitParams({ job: "j" }, { a: [1, 2] })).toEqual({ job: "j", data: { a: [1, 2] } });
    const fitted = fitParams({ job: "j" }, { big: Array.from({ length: 50 }, () => "y".repeat(50)), small: ["keep"] }, 1000);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(1000);
    expect((fitted.data as { small: string[] }).small).toEqual(["keep"]);
    expect((fitted.data as { truncated: number }).truncated).toBeGreaterThan(0);
    expect(() => fitParams({ job: "j" }, { text: "z".repeat(2000) }, 1000)).toThrow(/exceed/);
  });

  it("scrubText はメール・トークン・URL の資格情報・Bearer を伏せ、 git の SHA は残す", () => {
    const sha = "ff20786ee617710c51c07dce5c5883e8396f230b";
    // トークン形の偽値は実行時に組み立てる (ソースに置くと情報流出検査が本物と区別できない)。
    const fakeKey = ["sk", "abcdefghijk"].join("-");
    const out = scrubText(`a@b.co ${fakeKey} Bearer xyz https://u:p@github.com/x?token=abc ${sha}`);
    expect(out).not.toContain(fakeKey);
    expect(out).not.toMatch(/a@b\.co|xyz|u:p@|token=abc/);
    expect(out).toContain(sha);
  });

  it("cron 由来の params だけを解釈し、 Cc が閉じた印を見分ける", () => {
    expect(parseCronInstructionParams({ job: "j", dedupe_key: "manual" })).toBeNull();
    expect(parseCronInstructionParams({ job: "j", dedupe_key: "cron:j:-:x", args: { d: 1 }, options: { team: "t" }, target: "alpha", call_name: "c" }))
      .toEqual({ job: "j", target: "alpha", callName: "c", args: { d: 1 }, options: { team: "t" }, dedupeKey: "cron:j:-:x" });
    expect(isClosedByConcordia({ closed_by: "concordia" })).toBe(true);
    expect(isClosedByConcordia({ items: [] })).toBe(false);
  });
});
