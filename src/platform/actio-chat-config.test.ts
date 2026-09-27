import { describe, expect, it } from "vitest";
import { readActioChatSecret } from "./actio-chat-config.js";

describe("Actio chat encrypted runtime configuration", () => {
  it("supports missing config and preserves other runtime settings", () => {
    expect(readActioChatSecret({})).toBe("");
    expect(readActioChatSecret({ EXCUBITOR_SERVICE_CONFIG_JSON: '{"actioTaskBindings":[]}' })).toBe("");
    expect(readActioChatSecret({ EXCUBITOR_SERVICE_CONFIG_JSON: '{"actioChatSharedSecret":"fixture","actioTaskBindings":[]}' })).toBe("fixture");
  });
  it("prioritizes explicit environment, including disable", () => {
    for (const value of ["", "override"]) expect(readActioChatSecret({ ACTIO_CHAT_SHARED_SECRET: value, EXCUBITOR_SERVICE_CONFIG_JSON: "invalid" })).toBe(value);
  });
  it.each(['{"actioChatSharedSecret":123}', '"secret-fixture"', 'null', '[]', '{secret-fixture'])
  ("rejects invalid configuration without exposing values", raw => {
    expect(() => readActioChatSecret({ EXCUBITOR_SERVICE_CONFIG_JSON: raw })).toThrow("Invalid Actio chat runtime configuration");
  });
});
