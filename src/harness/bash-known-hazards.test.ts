import { describe, expect, it } from "vitest";
import { evaluateAction } from "./session-gate.js";
describe("Castra Bash hazards in the Cc gate", () => {
  it.each(["git reset --hard", "cp database.sqlite copy.sqlite", "rm -rf backup/", "git reset --hard # harness-guard:ok"])("blocks %s", command => {
    expect(evaluateAction({ tool: "Bash", command, branch: "feat/tools" }).decision).toBe("deny");
  });
  it("does not execute or block an ordinary read", () => {
    expect(evaluateAction({ tool: "Bash", command: "git status --short", branch: "feat/tools" }).decision).toBe("allow");
  });
});
