import { describe, expect, it } from "vitest";
import { parseModelRole, resolveTemplateModel } from "./template-model-role.js";

const roles = {
  claude: { opus: "claude-opus-next", sonnet: "claude-sonnet-next", haiku: "claude-haiku-next", fable: "claude-fable-next" },
  codex: { sol: "gpt-next-sol", astra: "gpt-next-astra", luna: "gpt-next-luna" },
};

describe("parseModelRole", () => {
  it("recognises role names with an optional [1m] suffix", () => {
    expect(parseModelRole("sonnet")).toEqual({ role: "sonnet", suffix: "" });
    expect(parseModelRole(" Opus[1m] ")).toEqual({ role: "opus", suffix: "[1m]" });
    expect(parseModelRole("claude-opus-5-5")).toBeNull();
    expect(parseModelRole("auto")).toBeNull();
    expect(parseModelRole(null)).toBeNull();
  });
});

describe("resolveTemplateModel", () => {
  it("resolves a Claude role through the role map and keeps the [1m] suffix", () => {
    expect(resolveTemplateModel({ provider: "claude", model: "sonnet", roles }))
      .toEqual({ ok: true, model: "claude-sonnet-next", role: "sonnet" });
    expect(resolveTemplateModel({ provider: "claude", model: "opus[1m]", roles }))
      .toEqual({ ok: true, model: "claude-opus-next[1m]", role: "opus" });
  });

  it("resolves a Codex role for codex and codex-sdk", () => {
    expect(resolveTemplateModel({ provider: "codex", model: "sol", roles })).toMatchObject({ ok: true, model: "gpt-next-sol" });
    expect(resolveTemplateModel({ provider: "codex-sdk", model: "luna", roles })).toMatchObject({ ok: true, model: "gpt-next-luna" });
  });

  it("passes explicit model IDs, auto and empty values through unchanged", () => {
    expect(resolveTemplateModel({ provider: "claude", model: "claude-explicit-1", roles }))
      .toEqual({ ok: true, model: "claude-explicit-1", role: null });
    expect(resolveTemplateModel({ provider: "gemma4-12", model: "auto", roles })).toEqual({ ok: true, model: "auto", role: null });
    expect(resolveTemplateModel({ provider: "codex", model: null, roles })).toEqual({ ok: true, model: null, role: null });
  });

  it("stops when the role does not belong to the provider or is missing from the map", () => {
    expect(resolveTemplateModel({ provider: "claude", model: "sol", roles }))
      .toMatchObject({ ok: false, error: expect.stringContaining("delegation_model_role_unresolved:sol") });
    expect(resolveTemplateModel({ provider: "codex", model: "astra[1m]", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "gemini", model: "opus", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "claude", model: "fable", roles: { ...roles, claude: {} } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("role map has no claude entry") });
  });
});
