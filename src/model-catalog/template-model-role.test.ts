import { describe, expect, it } from "vitest";
import { parseModelRole, resolveTemplateModel } from "./template-model-role.js";

const roles = {
  claude: { opus: "claude-opus-next", sonnet: "claude-sonnet-next", haiku: "claude-haiku-next", fable: "claude-fable-next" },
  codex: { sol: "gpt-next-sol", astra: "gpt-next-astra", luna: "gpt-next-luna" },
  gemini: { neon: "gemini-next-neon", argon: "gemini-next-argon" },
  grok: { grok: "grok-5.1" },
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
  it("uses the configured Grok model for the explicit or default role", () => {
    for (const model of [null, "  ", "Grok"]) {
      expect(resolveTemplateModel({ provider: "grok", model, roles })).toEqual({
        ok: true, model: "grok-5.1", role: "grok",
      });
    }
    expect(resolveTemplateModel({ provider: "grok", model: "grok-4.7", roles }))
      .toEqual({ ok: true, model: "grok-4.7", role: null });
  });

  it("rejects Grok roles with a mismatched provider, suffix or missing model", () => {
    expect(resolveTemplateModel({ provider: "agy", model: "grok", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "grok", model: "grok[1m]", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "grok", model: null, roles: { ...roles, grok: {} } }))
      .toMatchObject({ ok: false });
  });

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

  it("resolves the Gemini neon role and rejects cross-family or [1m] use (MRM-GEM-02)", () => {
    expect(parseModelRole("neon")).toEqual({ role: "neon", suffix: "" });
    expect(resolveTemplateModel({ provider: "gemini", model: "neon", roles }))
      .toEqual({ ok: true, model: "gemini-next-neon", role: "neon" });
    expect(resolveTemplateModel({ provider: "gemini", model: "neon[1m]", roles }))
      .toMatchObject({ ok: false, error: expect.stringContaining("delegation_model_role_unresolved:neon[1m]") });
    expect(resolveTemplateModel({ provider: "claude", model: "neon", roles }))
      .toMatchObject({ ok: false, error: expect.stringContaining("delegation_model_role_unresolved:neon") });
    expect(resolveTemplateModel({ provider: "codex", model: "neon", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "gemini", model: "sol", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "gemini", model: "neon", roles: { ...roles, gemini: {} } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("role map has no gemini entry") });
    expect(resolveTemplateModel({ provider: "gemini", model: "gemini-2.5-pro", roles }))
      .toEqual({ ok: true, model: "gemini-2.5-pro", role: null });
  });

  it("resolves neon / argon for agy and only for the Gemini family (MRM-GEM-04)", () => {
    expect(parseModelRole("argon")).toEqual({ role: "argon", suffix: "" });
    expect(resolveTemplateModel({ provider: "agy", model: "neon", roles }))
      .toEqual({ ok: true, model: "gemini-next-neon", role: "neon" });
    expect(resolveTemplateModel({ provider: "agy", model: "argon", roles }))
      .toEqual({ ok: true, model: "gemini-next-argon", role: "argon" });
    expect(resolveTemplateModel({ provider: "gemini", model: "argon", roles }))
      .toEqual({ ok: true, model: "gemini-next-argon", role: "argon" });
    expect(resolveTemplateModel({ provider: "agy", model: "argon[1m]", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "claude", model: "argon", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "codex", model: "argon", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "agy", model: "sonnet", roles })).toMatchObject({ ok: false });
    expect(resolveTemplateModel({ provider: "agy", model: "gemini-4-argon-high", roles }))
      .toEqual({ ok: true, model: "gemini-4-argon-high", role: null });
  });

  it("starts agy with the neon role when the model is empty; argon only when named (MRM-GEM-05)", () => {
    for (const model of [null, undefined, "", "  "]) {
      expect(resolveTemplateModel({ provider: "agy", model, roles }))
        .toEqual({ ok: true, model: "gemini-next-neon", role: "neon" });
    }
    expect(resolveTemplateModel({ provider: "agy", model: null, roles: { ...roles, gemini: {} } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("role map has no gemini entry") });
    // gemini (Gemini CLI) と他 provider の空 model は従来どおり CLI 既定に任せる。
    expect(resolveTemplateModel({ provider: "gemini", model: null, roles })).toEqual({ ok: true, model: null, role: null });
    expect(resolveTemplateModel({ provider: "claude", model: "", roles })).toEqual({ ok: true, model: "", role: null });
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
