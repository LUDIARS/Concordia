import { describe, expect, it } from "vitest";
import {
  ASTRA_WITH_SIDECAR_PROFILE,
  checkTemplateMatchesSpec,
  isSidecarParentMetadata,
} from "./profile.js";

const child = ASTRA_WITH_SIDECAR_PROFILE.child;
const matching = {
  call_name: "sol-mid",
  is_active: 1,
  target_provider: "codex",
  model: "gpt-6-sol",
  runtime_options_json: JSON.stringify({ model_reasoning_effort: "medium" }),
};

describe("Astra With Sidecar profile", () => {
  it("pins the parent to Astra medium and the child to Sol medium with one concurrent child", () => {
    expect(ASTRA_WITH_SIDECAR_PROFILE.parent).toMatchObject({ provider: "codex", model: "gpt-6-astra", effort: "medium" });
    expect(ASTRA_WITH_SIDECAR_PROFILE.child).toMatchObject({ call_name: "sol-mid", model: "gpt-6-sol", effort: "medium" });
    expect(ASTRA_WITH_SIDECAR_PROFILE.maxConcurrentChildren).toBe(1);
  });

  it("accepts a template whose provider, model and effort match", () => {
    expect(checkTemplateMatchesSpec(child, matching)).toEqual({ ok: true });
  });

  it.each([
    [null, "sidecar_template_missing"],
    [{ ...matching, is_active: 0 }, "sidecar_template_inactive"],
    [{ ...matching, target_provider: "claude" }, "sidecar_provider_mismatch"],
    [{ ...matching, model: "gpt-6-astra" }, "sidecar_model_mismatch"],
    [{ ...matching, runtime_options_json: JSON.stringify({ model_reasoning_effort: "xhigh" }) }, "sidecar_effort_mismatch"],
    [{ ...matching, runtime_options_json: "not json" }, "sidecar_effort_mismatch"],
  ])("returns an explicit stop reason instead of substituting (%#)", (template, code) => {
    const result = checkTemplateMatchesSpec(child, template);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("recognises the parent only from delegation_call_name metadata", () => {
    expect(isSidecarParentMetadata(JSON.stringify({ delegation_call_name: "astra-with-sidecar" }))).toBe(true);
    expect(isSidecarParentMetadata(JSON.stringify({ delegation_call_name: "astra-mid" }))).toBe(false);
    expect(isSidecarParentMetadata(null)).toBe(false);
    expect(isSidecarParentMetadata("{broken")).toBe(false);
  });
});
