import { describe, it, expect } from "vitest";
import { readChatDestinations, destinationMatches } from "./actio-chat-destination.js";
const row = { teamId: "KD", subsidiaryId: "glab", workspaceId: "123456" };
const target = { enabled: true, platform: "discord", mode: "subsidiary", guild_id: "123456" };
describe("explicit Discord destination", () => {
  it("defaults to ownership routing and accepts only the explicit config", () => {
    expect(readChatDestinations({})).toEqual([]);
    expect(readChatDestinations({ EXCUBITOR_SERVICE_CONFIG_JSON: JSON.stringify({ actioChatDestinations: [row] }) })).toEqual([row]);
    expect(readChatDestinations({ CONCORDIA_ACTIO_CHAT_DESTINATIONS: "[]", EXCUBITOR_SERVICE_CONFIG_JSON: "invalid" })).toEqual([]);
  });
  it("rejects duplicates and malformed input with a fixed error", () => {
    for (const value of [[row, row], [{ ...row, workspaceId: "bad" }], null])
      expect(() => readChatDestinations({ CONCORDIA_ACTIO_CHAT_DESTINATIONS: JSON.stringify(value) })).toThrow("Invalid Actio chat destination configuration");
  });
  it("requires an explicit headquarters credential source and still checks destination scope", () => {
    const explicit = { ...row, credentialSource: "headquarters" as const };
    expect(readChatDestinations({ CONCORDIA_ACTIO_CHAT_DESTINATIONS: JSON.stringify([explicit]) })).toEqual([explicit]);
    expect(readChatDestinations({ CONCORDIA_ACTIO_CHAT_DESTINATIONS: JSON.stringify([row]) })[0].credentialSource).toBeUndefined();
    expect(() => readChatDestinations({ CONCORDIA_ACTIO_CHAT_DESTINATIONS: JSON.stringify([{ ...row, credentialSource: "arbitrary" }]) })).toThrow();
    expect(destinationMatches(explicit, { platform: "discord", workspaceId: "999999" }, target)).toBe(false);
    expect(destinationMatches(explicit, { platform: "discord", workspaceId: row.workspaceId }, { ...target, enabled: false })).toBe(false);
  });
  it("fails closed for wrong, absent or disabled destinations", () => {
    const input = { platform: "discord", workspaceId: "123456" };
    expect(destinationMatches(row, input, target)).toBe(true);
    for (const invalid of [null, { ...target, enabled: false }, { ...target, guild_id: "999999" }, { ...target, mode: "desk" }, { ...target, platform: "slack" }])
      expect(destinationMatches(row, input, invalid)).toBe(false);
    expect(destinationMatches(row, { ...input, workspaceId: "999999" }, target)).toBe(false);
  });
});
