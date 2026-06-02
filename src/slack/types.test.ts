import { describe, it, expect } from "vitest";
import { readSlackEnv, slackEnvReady, readSlackChatMeta } from "./types.js";

describe("readSlackEnv / slackEnvReady", () => {
  it("ENABLED=1 + 3 値揃いで ready", () => {
    const env = readSlackEnv({
      CONCORDIA_SLACK_ENABLED: "1",
      CONCORDIA_SLACK_BOT_TOKEN: "xoxb-x",
      CONCORDIA_SLACK_APP_TOKEN: "xapp-x",
      CONCORDIA_SLACK_CHANNEL_ID: "C123",
    } as NodeJS.ProcessEnv);
    expect(env.enabled).toBe(true);
    expect(slackEnvReady(env)).toBe(true);
  });
  it("ENABLED 未設定なら disabled かつ not ready", () => {
    const env = readSlackEnv({} as NodeJS.ProcessEnv);
    expect(env.enabled).toBe(false);
    expect(slackEnvReady(env)).toBe(false);
  });
  it("token 欠落は not ready", () => {
    const env = readSlackEnv({ CONCORDIA_SLACK_ENABLED: "1", CONCORDIA_SLACK_CHANNEL_ID: "C1" } as NodeJS.ProcessEnv);
    expect(slackEnvReady(env)).toBe(false);
  });
});

describe("readSlackChatMeta", () => {
  it("source=slack を読む", () => {
    expect(readSlackChatMeta(JSON.stringify({ source: "slack", slack_user_id: "U1" }))).toEqual({
      source: "slack",
      slack_user_id: "U1",
    });
  });
  it("null / 壊れた JSON は空", () => {
    expect(readSlackChatMeta(null)).toEqual({});
    expect(readSlackChatMeta("{bad")).toEqual({});
  });
});
