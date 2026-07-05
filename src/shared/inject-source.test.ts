import { describe, expect, it } from "vitest";
import { parseInjectSource } from "./inject-source.js";

describe("parseInjectSource", () => {
  it("extracts human platform sources", () => {
    expect(parseInjectSource("discord:123:456:789")).toEqual({
      raw: "discord:123:456:789",
      platform: "discord",
      userId: "123",
    });
    expect(parseInjectSource("slack:U42:C1:1700")).toEqual({
      raw: "slack:U42:C1:1700",
      platform: "slack",
      userId: "U42",
    });
  });

  it("ignores control and malformed sources", () => {
    expect(parseInjectSource("discord-enter")).toEqual({ raw: "discord-enter", platform: null, userId: null });
    expect(parseInjectSource("discord:")).toEqual({ raw: "discord:", platform: null, userId: null });
    expect(parseInjectSource(null)).toEqual({ raw: "", platform: null, userId: null });
  });
});
