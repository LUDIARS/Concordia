import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { deliverProjectRules, projectRulesTargets } from "./project-rules-delivery.js";

const WORKSPACE = "E:/Document/Ars";
const CC = "E:/Document/Ars/Concordia";
const ACTIO = "E:/Document/Ars/Actio";

function row(code: string, project: string, repoPath: string): ProjectCodeRow {
  return { code, project, repo_path: repoPath, repo_origin: `https://github.com/LUDIARS/${project}.git`,
    domain_review: 0, github_issue_workflow: 0, added_by: "test" } as ProjectCodeRow;
}

const PROJECTS = [row("Cc", "Concordia", CC), row("A", "Actio", ACTIO)];
const FILES: Record<string, string> = {
  [join(CC, "AGENTS.md")]: "# Concordia の開発\nDDD で進める。",
  [join(ACTIO, "AGENTS.md")]: "# Actio の開発",
};

let sessions: SessionsRepo;
let injects: Array<Extract<ConcordiaEvent, { type: "session.inject" }>>;
let unsubscribe: () => void;

function insert(repoPath: string, activeRepos: string[] = []): void {
  sessions.insertSession({ id: "s1", provider: "claude-code", repo_path: repoPath, repo_origin: null, branch: "feat/x",
    host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null, active_repos: activeRepos });
}

function deps(files = FILES) {
  return {
    repo: sessions,
    projects: () => PROJECTS,
    workspaceRoots: () => [WORKSPACE],
    readText: async (path: string) => files[path] ?? null,
    now: () => 1_000_000,
  };
}

beforeEach(() => {
  sessions = new SessionsRepo(makeTestDb());
  injects = [];
  unsubscribe = eventBus.subscribe((event) => {
    if (event.type === "session.inject") injects.push(event);
  });
});

afterEach(() => unsubscribe());

describe("projectRulesTargets", () => {
  it("does not treat the workspace root as a registered project", () => {
    expect(projectRulesTargets(PROJECTS, { repo_path: WORKSPACE, repo_origin: null }, [WORKSPACE])).toEqual([]);
  });

  it("includes the registered project and other projects the session touched, once each", () => {
    const targets = projectRulesTargets(PROJECTS, {
      repo_path: `${CC}-feat-x`, repo_origin: "https://github.com/LUDIARS/Concordia.git",
      active_repos: JSON.stringify([ACTIO, `${CC}-feat-x`, WORKSPACE]),
    }, [WORKSPACE]);
    expect(targets.map((target) => target.code)).toEqual(["Cc", "A"]);
  });
});

describe("deliverProjectRules", () => {
  it("injects the rules of a newly registered project once", async () => {
    insert(CC);
    expect(await deliverProjectRules(deps(), "s1")).toEqual(["Cc"]);
    expect(injects).toHaveLength(1);
    expect(injects[0]!.text).toContain("[Cc project rules] Cc");
    expect(injects[0]!.text).toContain("DDD で進める。");
    expect(await deliverProjectRules(deps(), "s1")).toEqual([]);
    expect(injects).toHaveLength(1);
  });

  it("sends each additional project when the session spans several", async () => {
    insert(CC);
    await deliverProjectRules(deps(), "s1");
    sessions.patchSession("s1", { active_repos: [ACTIO] });
    expect(await deliverProjectRules(deps(), "s1")).toEqual(["A"]);
    expect(injects.map((event) => event.text.split("\n")[0])).toEqual([
      `[Cc project rules] Cc (${CC})`,
      `[Cc project rules] A (${ACTIO})`,
    ]);
  });

  it("re-sends a project when its rules change", async () => {
    insert(CC);
    await deliverProjectRules(deps(), "s1");
    expect(await deliverProjectRules(deps({ ...FILES, [join(CC, "AGENTS.md")]: "# 改訂" }), "s1")).toEqual(["Cc"]);
    expect(injects.at(-1)!.text).toContain("更新されました");
  });

  it("does nothing for inactive or unknown sessions", async () => {
    expect(await deliverProjectRules(deps(), "missing")).toEqual([]);
    insert(CC);
    sessions.setStatus("s1", "ended", 2, 2);
    expect(await deliverProjectRules(deps(), "s1")).toEqual([]);
  });
});
