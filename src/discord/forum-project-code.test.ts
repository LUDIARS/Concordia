import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { createForumProjectResolver } from "./forum-project-code.js";

const root = "E:/Document/Ars";
const concordia: ProjectCodeRow = {
  code: "Cc",
  project: "Concordia",
  repo_path: join(root, "Concordia"),
  repo_origin: "https://github.com/LUDIARS/Concordia.git",
  added_by: "test",
  created_at: 1,
  updated_at: 1,
};

describe("forum project resolver", () => {
  it("recognizes canonical, conventional, and .wt-prefixed repository paths", () => {
    const resolver = createForumProjectResolver(() => [concordia]);
    expect(resolver.codeForRepo(join(root, "Concordia"))).toBe("Cc");
    expect(resolver.codeForRepo(join(root, "Concordia-feature"))).toBe("Cc");
    expect(resolver.codeForRepo(join(root, ".wt-Concordia-feature"))).toBe("Cc");
  });

  it("recognizes a bare case-sensitive project code and repository name", () => {
    const resolver = createForumProjectResolver(() => [concordia]);
    expect(resolver.targetFromPost("Cc spawn fix", "")?.project).toBe("Concordia");
    expect(resolver.targetFromPost("fix/Cc-spawn-context", "")?.project).toBe("Concordia");
    expect(resolver.targetFromPost("[Cc] spawn fix", "")?.project).toBe("Concordia");
    expect(resolver.targetFromPost("spawn fix", "Concordia を直す")?.project).toBe("Concordia");
    expect(resolver.targetFromPost("cc spawn fix", "")).toBeNull();
    expect(resolver.targetFromPost("CCache fix", "")).toBeNull();
  });

  it("observes rows registered after resolver creation", () => {
    const rows: ProjectCodeRow[] = [];
    const resolver = createForumProjectResolver(() => rows);
    expect(resolver.targetFromPost("[Cc] task", "")).toBeNull();
    rows.push(concordia);
    expect(resolver.targetFromPost("[Cc] task", "")?.project).toBe("Concordia");
  });
});
