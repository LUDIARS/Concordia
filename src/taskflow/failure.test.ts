import { describe, expect, it } from "vitest";
import { describeTaskflowFailure, RevisorLookupUnavailable } from "./failure.js";

describe("safe taskflow failure descriptions", () => {
  it.each([
    ["CONCORDIA_ACTIO_TASK_BINDINGS is required and must be JSON", "actio_configuration_invalid", 503],
    ["Actio task project binding missing or ambiguous", "actio_binding_invalid", 503],
    ["Actio project registration is ambiguous", "actio_project_ambiguous", 503],
    ["Invalid Actio project list response", "actio_response_invalid", 502],
    ["Actio task ownership mismatch", "actio_scope_denied", 403],
    ["Actio task request identity reused with different content", "task_identity_conflict", 409],
    ["Actio task request outcome unknown; reconcile using the same task identity", "actio_outcome_unknown", 503],
    ["Actio task request rejected (422)", "actio_request_rejected", 502],
    ["Invalid Actio task response", "actio_response_invalid", 502],
  ])("classifies %s", (message, code, status) => {
    expect(describeTaskflowFailure(new Error(message))).toMatchObject({ code, status });
  });

  it("does not attribute Revisor failures to Actio", () => {
    expect(describeTaskflowFailure(new RevisorLookupUnavailable())).toMatchObject({ code: "revisor_lookup_unavailable", status: 503 });
  });

  it.each([new Error("secret-token task body"), "secret-token", { message: "secret-token" }, null])(
    "never includes arbitrary exceptions or values", (error) => {
      const result = describeTaskflowFailure(error);
      expect(result).toMatchObject({ code: "taskflow_internal_error", status: 500 });
      expect(JSON.stringify(result)).not.toContain("secret-token");
    },
  );
});
