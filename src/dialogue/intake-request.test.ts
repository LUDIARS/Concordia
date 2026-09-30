import { describe, expect, it } from "vitest";
import { readConsultIntakeRequest } from "./intake-request.js";

describe("readConsultIntakeRequest", () => {
  it("reads the four items, the source and the reception channel", () => {
    expect(readConsultIntakeRequest({
      consultation_intake: { topic: " 集約 ", skill_level: "初級", role_title: "エンジニア", purpose: "", source: "forum" },
      source_discord_channel_id: "123456789012345678",
    })).toEqual({
      values: { topic: "集約", skill_level: "初級", role_title: "エンジニア", purpose: "" },
      source: "forum",
      channelId: "123456789012345678",
    });
  });

  it("returns null when absent or malformed so the launch itself is not blocked", () => {
    expect(readConsultIntakeRequest({})).toBeNull();
    expect(readConsultIntakeRequest({ consultation_intake: "text" })).toBeNull();
    expect(readConsultIntakeRequest({ consultation_intake: { topic: "t", extra: 1 } })).toBeNull();
  });

  it("defaults the source to api and drops a non-Discord channel id", () => {
    expect(readConsultIntakeRequest({
      consultation_intake: { topic: "t" },
      source_discord_channel_id: "not-a-snowflake",
    })).toMatchObject({ source: "api", channelId: null });
  });
});
