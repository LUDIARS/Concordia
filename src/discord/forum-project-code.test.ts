import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createForumProjectResolver } from "./forum-project-code.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "concordia-project-codes-"));
  roots.push(root);
  mkdirSync(join(root, "LUDIARS"), { recursive: true });
  mkdirSync(join(root, "Concordia"), { recursive: true });
  writeFileSync(join(root, "LUDIARS", "PROJECT-CODES.md"), [
    "## Services",
    "| Code | Repository |",
    "| --- | --- |",
    "| Cc | Concordia |",
  ].join("\n"), "utf8");
  return root;
}

describe("forum project resolver", () => {
  it("recognizes canonical, conventional, and .wt-prefixed repository paths", () => {
    const root = fixtureRoot();
    const resolver = createForumProjectResolver([root], { warn: vi.fn() });
    expect(resolver.codeForRepo(join(root, "Concordia"))).toBe("Cc");
    expect(resolver.codeForRepo(join(root, "Concordia-feature"))).toBe("Cc");
    expect(resolver.codeForRepo(join(root, ".wt-Concordia-feature"))).toBe("Cc");
  });

  it("recognizes a bare case-sensitive project code and repository name", () => {
    const root = fixtureRoot();
    const resolver = createForumProjectResolver([root], { warn: vi.fn() });
    expect(resolver.targetFromPost("Cc spawn fix", "")?.project).toBe("Concordia");
    expect(resolver.targetFromPost("fix/Cc-spawn-context", "")?.project).toBe("Concordia");
    expect(resolver.targetFromPost("[Cc] spawn fix", "")?.project).toBe("Concordia");
    expect(resolver.targetFromPost("spawn fix", "Concordia を直す")?.project).toBe("Concordia");
    expect(resolver.targetFromPost("cc spawn fix", "")).toBeNull();
    expect(resolver.targetFromPost("CCache fix", "")).toBeNull();
  });
});
