import { describe, expect, it } from "vitest";
import { privateConsultChannelName } from "./consult-channel.js";

describe("privateConsultChannelName", () => {
  it("names channels without any content of the consultation", () => {
    expect(privateConsultChannelName(new Date("2026-09-30T10:00:00Z"), "pc_abcdef123456")).toBe("相談-20260930-abcdef");
  });
});
