import { describe, expect, it } from "vitest";
import { channelIdOf, formatDefaults, formatRule, mergeDefaults, parseQuietArg, type PatrolRuleView } from "./patrol-command-args.js";

describe("/patrol args", () => {
  it("parses the quiet window, none and inherit", () => {
    expect(parseQuietArg("22:00-9:30")).toEqual({ start: "22:00", end: "09:30" });
    expect(parseQuietArg("22:00〜09:30")).toEqual({ start: "22:00", end: "09:30" });
    expect(parseQuietArg("なし")).toBeNull();
    expect(parseQuietArg("既定")).toBe("inherit");
    expect(parseQuietArg("夜")).toMatchObject({ error: expect.stringMatching(/22:00-09:30/) });
  });

  it("reads channel mentions and ids", () => {
    expect(channelIdOf("<#1546109590930853962>")).toBe("1546109590930853962");
    expect(channelIdOf("1546109590930853962")).toBe("1546109590930853962");
    expect(channelIdOf("general")).toBeNull();
  });

  it("merges only the given defaults and clears with 既定", () => {
    const cur = { quiet_hours: { start: "22:00", end: "09:30" }, persona_hint: "学校らしく", root_limit_per_day: 4 };
    expect(mergeDefaults(cur, { rootLimit: 6 })).toEqual({ ...cur, root_limit_per_day: 6 });
    expect(mergeDefaults(cur, { quiet: "inherit", persona: "既定" })).toEqual({ root_limit_per_day: 4 });
    expect(mergeDefaults(cur, { paused: true, rootLimit: null, channelId: null })).toEqual({ ...cur, paused: true });
  });

  it("shows where each value comes from", () => {
    const rule: PatrolRuleView = {
      id: "glab-trend-1", enabled: true, tick_sec: 1800, instructions: "短く",
      action_config: { root_limit_per_day: 3 },
      effective_config: { root_limit_per_day: 3, quiet_hours: { start: "22:00", end: "09:30" }, discord_channel_id: "1546109590930853962", persona_hint: null },
      readiness: { runnable: true, reason: "ready" },
    };
    const text = formatRule(rule);
    expect(text).toContain("間隔 30 分 · 1日 3 件まで\n");
    expect(text).toContain("22:00〜09:30 は新規投稿しない (既定)");
    expect(text).toContain("<#1546109590930853962> (既定)");
    expect(formatDefaults({ defaults: { paused: true }, updated_by: "discord:1" })).toMatch(/止めています/);
  });
});
