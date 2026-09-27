import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ActioTaskStore } from "../taskflow/actio-store.js";
import type { ActioTransport } from "../taskflow/actio-transport.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { repositoryKey } from "../taskflow/actio-binding.js";
import { inspectImplementationRepo, isWithinWorkspace } from "../implementation-tools/repo-context.js";
import { worktreeGit } from "../implementation-tools/worktree-git.js";
import { failure, unavailable, type ToolInput } from "./contracts.js";
import type { ResearchTools } from "./research.js";
import type { AugurTools } from "./augur.js";
import type { ToolTestJobs } from "./test-jobs.js";
import { checkVulnerabilities } from "./vulnerabilities.js";
import { assertStaticBundle } from "./test-scope.js";
import { criticalPath } from "./critical-path.js";

export interface DeveloperToolDeps {
  sessions: Pick<SessionsRepo, "findSession">;
  roots: () => string[];
  tasks: Pick<ActioTaskStore, "binding" | "findForProject" | "read" | "updateStatus" | "create">;
  actio: Pick<ActioTransport, "request">;
  research: Pick<ResearchTools, "anatomyProject" | "specifications" | "context" | "impact">;
  augur: Pick<AugurTools, "cli" | "list" | "run">;
  jobs: Pick<ToolTestJobs, "read" | "start">;
  inspect?: typeof inspectImplementationRepo;
  within?: typeof isWithinWorkspace;
  git?: typeof worktreeGit;
  vulnerability?: typeof checkVulnerabilities;
}

/** Application boundary: derive scope once, then call the authoritative owner. */
export class DeveloperToolsService {
  constructor(private readonly deps: DeveloperToolDeps) {}
  async execute(sessionId: string, input: ToolInput): Promise<unknown> {
    const session = this.deps.sessions.findSession(sessionId);
    if (!session || session.status !== "active") unavailable("active_session_required", "Lictor の現在 session を接続してください。");
    if (input.operation === "test_result") return this.deps.jobs.read(session.id, input.request_id);
    if (!await (this.deps.within ?? isWithinWorkspace)(session.repo_path, this.deps.roots())) {
      unavailable("workspace_binding_required", "Cc の bind ツールで workspace 内の checkout を登録してください。");
    }
    const context = await (this.deps.inspect ?? inspectImplementationRepo)(session.repo_path);
    if (context.branch !== session.branch || repositoryKey(context.repoPath) !== repositoryKey(session.repo_path)
      || context.repoOrigin !== session.repo_origin) unavailable("checkout_binding_stale", "Cc bind ツールで実際の repo・origin・branch を再登録してください。");
    const subsidiary = readSubsidiaryId(session.metadata);
    const repo = context.repoPath;
    switch (input.operation) {
      case "tasks_list": return this.deps.tasks.findForProject(repo, undefined, subsidiary);
      case "task_create": return this.deps.tasks.create({ repoPath: repo, subsidiaryId: subsidiary,
        sourceRef: `session:${session.id}:${input.request_id}`, title: input.title, body: input.body, kind: "実装", memoryLinks: [] });
      case "task_get": return this.deps.tasks.read(repo, input.reference, subsidiary);
      case "task_update": {
        await this.deps.tasks.read(repo, input.reference, subsidiary);
        await this.deps.tasks.updateStatus(repo, input.reference, input.status, subsidiary);
        return this.deps.tasks.read(repo, input.reference, subsidiary);
      }
      case "critical_path": {
        const binding = await this.deps.tasks.binding(repo, subsidiary);
        return criticalPath(this.deps.actio, binding, context.repoOrigin, input.pm_project_id);
      }
      case "specifications": return this.deps.research.specifications(context.repoOrigin, input.project_id, repo);
      case "implementation_context": return this.deps.research.context(repo, input.task);
      case "impact_analysis": return this.deps.research.impact(repo, input.task);
      case "tests_list": return this.deps.augur.list(repo);
      case "tests_run": {
        this.deps.augur.cli();
        assertStaticBundle(await this.deps.augur.list(repo), input.bundle);
        const head = (await (this.deps.git ?? worktreeGit)(repo, ["rev-parse", "HEAD"])).trim();
        if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("invalid Git head");
        // Freeze a clean revision; the recorded identity cannot silently point at later edits.
        if ((await (this.deps.git ?? worktreeGit)(repo, ["status", "--porcelain"])).trim()) {
          unavailable("clean_checkout_required", "変更を commit し、登録テストの対象 revision を固定してください。");
        }
        return this.deps.jobs.start(session.id, input.request_id, { repo, head, bundle: input.bundle, approval_reference: input.approval_reference },
          () => this.deps.augur.run(repo, input.bundle, head));
      }
      case "vulnerability_check": return (this.deps.vulnerability ?? checkVulnerabilities)(repo);
      case "readiness": return this.readiness(repo, context.repoOrigin, subsidiary);
    }
  }

  private async readiness(repo: string, origin: string | null, subsidiary: string | null) {
    const checks = [
      ["Actio", async () => { await this.deps.tasks.findForProject(repo, undefined, subsidiary); }],
      ["Anatomia", async () => { await this.deps.research.context(repo, "readiness"); }],
      ["Pf", async () => { await this.deps.research.specifications(origin, undefined, repo); }],
      ["Augur", async () => {
        const tests = z.array(z.unknown()).parse(await this.deps.augur.list(repo));
        if (!tests.length) unavailable("test_registry_empty", "対象 repo のテストを Augur に登録してください。");
      }],
    ] as const;
    const items = await Promise.all(checks.map(async ([name, check]) => {
      try { await check(); return { name, ready: true }; }
      catch (error) { return { name, ready: false, ...failure(error) }; }
    }));
    return { ready: items.every(item => item.ready), items,
      mcp: "Cc HTTP/CLI adapters are available without provider MCP connections; client MCP installation must be checked in that client." };
  }
}
