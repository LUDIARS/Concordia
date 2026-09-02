import { describe, expect, it } from "vitest";
import type { SettingsStore } from "./settings-store.js";
import { WorkflowSettingsStore } from "./workflow-settings.js";

function makeStore(initial: Record<string, string> = {}): SettingsStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
    transaction: (update) => update(),
    getBoolean: (key, fallback) => values.has(key) ? values.get(key) === "1" : fallback,
    setBoolean: (key, value) => { values.set(key, value ? "1" : "0"); },
  };
}

describe("WorkflowSettingsStore action policies", () => {
  it("reads only supported field shapes from persisted JSON", () => {
    const settings = new WorkflowSettingsStore(makeStore({
      "admin.reaction_action_policies": JSON.stringify({
        "memoria-note": { subsidiary: true, capability: "session_spawn", ignored: "value" },
        context: { subsidiary: "yes", capability: "" },
        "status-check": { capability: "unknown_capability" },
        broken: null,
      }),
    }), {});

    expect(settings.getActionPolicies()).toEqual({
      "memoria-note": { subsidiary: true, capability: "session_spawn" },
    });
  });

  it("partially updates policies and removes fields reset to defaults", () => {
    const store = makeStore();
    const settings = new WorkflowSettingsStore(store, {});

    settings.setActionPolicy("merge-pr", { subsidiary: false, capability: "none" });
    settings.setActionPolicy("merge-pr", { subsidiary: null });
    expect(settings.getActionPolicies()).toEqual({ "merge-pr": { capability: "none" } });

    settings.setActionPolicy("merge-pr", { capability: null });
    expect(settings.getActionPolicies()).toEqual({});
  });
});
