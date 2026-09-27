import { describe, expect, it } from "vitest";
import { EXPLICIT_CONTEXT_BINDING_KEY, HUMAN_CONVERSATION_KEY, hasConfirmedContextPresence } from "./inject-context-presence.js";

const current = { repo_path: "E:/Document/Ars/.wt-Concordia-feature", repo_origin: "LUDIARS/Concordia", branch: "feat/work", metadata: null };
const binding = { repoPath: current.repo_path, repoOrigin: current.repo_origin, branch: current.branch, projectCode: "Cc" };

describe("context presence", () => {
  it("requires both a real conversation and an explicit binding", () => {
    expect(hasConfirmedContextPresence(current, "Cc")).toBe(false);
    expect(hasConfirmedContextPresence({ ...current, metadata: JSON.stringify({ [HUMAN_CONVERSATION_KEY]: true }) }, "Cc")).toBe(false);
    expect(hasConfirmedContextPresence({ ...current, metadata: JSON.stringify({ [EXPLICIT_CONTEXT_BINDING_KEY]: binding }) }, "Cc")).toBe(false);
    expect(hasConfirmedContextPresence({ ...current, metadata: JSON.stringify({ [HUMAN_CONVERSATION_KEY]: true, [EXPLICIT_CONTEXT_BINDING_KEY]: binding }) }, "Cc")).toBe(true);
  });

  it("withdraws qualification after any target binding changes", () => {
    const session = { ...current, metadata: JSON.stringify({ [HUMAN_CONVERSATION_KEY]: true, [EXPLICIT_CONTEXT_BINDING_KEY]: binding }) };
    expect(hasConfirmedContextPresence({ ...session, branch: "feat/other" }, "Cc")).toBe(false);
    expect(hasConfirmedContextPresence({ ...session, repo_path: "E:/Document/Ars/.wt-Other" }, "Cc")).toBe(false);
    expect(hasConfirmedContextPresence({ ...session, repo_origin: "LUDIARS/Other" }, "Cc")).toBe(false);
    expect(hasConfirmedContextPresence(session, "Other")).toBe(false);
  });
});
