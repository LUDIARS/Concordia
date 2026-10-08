import { it, expect } from "vitest";
import { meetingLinkConfig } from "./config.js";
it("is disabled by default and fails closed for incomplete or unsafe configuration", () => {
  expect(meetingLinkConfig({})).toBeNull();
  expect(() => meetingLinkConfig({ CONCORDIA_MEETING_LINK_ENABLED: "true" })).toThrow();
  const base = { CONCORDIA_MEETING_LINK_ENABLED: "true", CONCORDIA_MEETING_LINK_GUILD_ID: "1136199339417534606" };
  for (const url of ["http://example.test", "https://u:p@example.test", "https://example.test/path", "https://example.test/#secret"]) {
    expect(() => meetingLinkConfig({ ...base, CONCORDIA_MEETING_LINK_PUBLIC_URL: url })).toThrow();
  }
  expect(meetingLinkConfig({ ...base, CONCORDIA_MEETING_LINK_PUBLIC_URL: "https://example.test/" })?.audience).toBe("https://example.test");
});
