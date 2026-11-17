import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { isUnderWorkspaceRoot, relaxWorkspaceRootCommand, WORKSPACE_ROOT_RELAXABLE_RULES } from "../../src/harness/reliability/workspace-root-command-relax.js";
import type { GateVerdict } from "../../src/harness/session-gate.js";

/** TB-ROOT-CMD: 2026-11-17 neco 指示。グローバルルート配下のコマンドは作業境界のずれでは止めない。 */
const root = resolve("fixture/ars");
const inside = resolve("fixture/ars/Concordia");
const outside = resolve("fixture/other");

function verdict(hits: GateVerdict["hits"]): GateVerdict {
  const decision = hits.some((h) => h.decision === "deny") ? "deny" : hits.some((h) => h.decision === "warn") ? "warn" : "allow";
  return { decision, hits, blocked: decision === "deny", reason: hits.map((h) => h.reason).join(" / ") };
}

describe("isUnderWorkspaceRoot", () => {
  it("matches the root itself and descendants, not siblings sharing a prefix", () => {
    expect(isUnderWorkspaceRoot(root, [root])).toBe(true);
    expect(isUnderWorkspaceRoot(inside, [root])).toBe(true);
    expect(isUnderWorkspaceRoot(resolve("fixture/ars-other"), [root])).toBe(false);
    expect(isUnderWorkspaceRoot(outside, [root])).toBe(false);
  });

  it("does not match empty cwd or empty roots", () => {
    expect(isUnderWorkspaceRoot(undefined, [root])).toBe(false);
    expect(isUnderWorkspaceRoot("", [root])).toBe(false);
    expect(isUnderWorkspaceRoot(inside, ["", "  "])).toBe(false);
  });
});

describe("relaxWorkspaceRootCommand (TB-ROOT-CMD)", () => {
  it("downgrades every work-boundary deny to warn for a command under the root", () => {
    for (const rule of WORKSPACE_ROOT_RELAXABLE_RULES) {
      const out = relaxWorkspaceRootCommand(verdict([{ rule, decision: "deny", reason: "mismatch" }]),
        { tool: "Bash", cwd: inside }, [root]);
      expect(out.blocked).toBe(false);
      expect(out.decision).toBe("warn");
      expect(out.hits[0]!.decision).toBe("warn");
      expect(out.reason).toContain("TB-ROOT-CMD");
    }
  });

  it("applies to PowerShell as well as Bash", () => {
    const out = relaxWorkspaceRootCommand(verdict([{ rule: "task-branch", decision: "deny", reason: "x" }]),
      { tool: "PowerShell", cwd: inside }, [root]);
    expect(out.blocked).toBe(false);
  });

  it("keeps safety denies (main push, hazards, service start, read-only, budget, acceptance) blocking", () => {
    for (const rule of ["no-main-push", "bash-known-hazards", "no-service-start-in-session", "inquiry-read-only",
      "use-case-read-only", "usage-budget", "code-acceptance", "ddd-evidence", "consultation-secret"]) {
      const out = relaxWorkspaceRootCommand(verdict([
        { rule: "task-branch", decision: "deny", reason: "mismatch" },
        { rule, decision: "deny", reason: "safety" },
      ]), { tool: "Bash", cwd: inside }, [root]);
      expect(out.blocked).toBe(true);
      expect(out.decision).toBe("deny");
      expect(out.hits.find((h) => h.rule === rule)!.decision).toBe("deny");
      expect(out.hits.find((h) => h.rule === "task-branch")!.decision).toBe("warn");
    }
  });

  it("does not relax edit tools (TB-REGISTERED stays)", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      const input = verdict([{ rule: "task-branch", decision: "deny", reason: "x" }]);
      expect(relaxWorkspaceRootCommand(input, { tool, cwd: inside }, [root])).toBe(input);
    }
  });

  it("does not relax commands outside every root, or when no root is configured", () => {
    const input = verdict([{ rule: "task-branch", decision: "deny", reason: "x" }]);
    expect(relaxWorkspaceRootCommand(input, { tool: "Bash", cwd: outside }, [root])).toBe(input);
    expect(relaxWorkspaceRootCommand(input, { tool: "Bash", cwd: inside }, [])).toBe(input);
    expect(relaxWorkspaceRootCommand(input, { tool: "Bash" }, [root])).toBe(input);
  });

  it("returns the same verdict when nothing was relaxed", () => {
    const input = verdict([{ rule: "max-repos", decision: "warn", reason: "x" }]);
    expect(relaxWorkspaceRootCommand(input, { tool: "Bash", cwd: inside }, [root])).toBe(input);
  });
});
