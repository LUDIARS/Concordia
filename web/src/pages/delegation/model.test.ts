import { describe, expect, it } from "vitest";
import { catalogProviderFor, emptyModelLabel } from "./model.js";

describe("delegation model helpers (agy / Antigravity)", () => {
  it("uses the Grok catalog and displays the default role", () => {
    expect(catalogProviderFor("grok")).toBe("grok");
    expect(emptyModelLabel("grok")).toBe("(既定: Grok)");
  });

  it("agy はモデルカタログの gemini 行を共有し、 codex-sdk は codex 行を共有する", () => {
    expect(catalogProviderFor("agy")).toBe("gemini");
    expect(catalogProviderFor("codex-sdk")).toBe("codex");
    expect(catalogProviderFor("gemini")).toBe("gemini");
    expect(catalogProviderFor("claude")).toBe("claude");
  });

  it("agy の model 未指定は既定 Neon と表示する (MRM-GEM-05)", () => {
    expect(emptyModelLabel("agy")).toBe("(既定: Neon)");
    expect(emptyModelLabel("gemini")).toBe("(provider CLI 既定)");
    expect(emptyModelLabel("claude")).toBe("(provider CLI 既定)");
  });
});
