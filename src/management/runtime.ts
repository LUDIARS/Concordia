import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { spawnSession } from "../control/spawner.js";
import { forgetPendingDelegationSpawnBySpawnId, recordPendingDelegationSpawn } from "../control/pending-delegation-spawns.js";
import { interactiveSpawnEnvironment } from "../control/interactive-spawn-env.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { ManagementDispatcher, type LaunchResult } from "./dispatcher.js";
import type { ManagementRequest, Mission } from "./domain.js";
import { buildLaunchPrompt } from "./prompt.js";
import { ManagementRepository } from "./repository.js";
import { ManagementService } from "./service.js";

/**
 * CDGD マネジメント層の composition。 spawn / inject / session 照合の adapter を組み立て、
 * 払い出し timer の寿命を所有する。
 */

export interface ManagementRuntimeDeps {
  db: Database;
  concordiaUrl: string;
  isBlocked: () => boolean;
  /** project code → 登録済みの本体 checkout。 未登録は null。 */
  projectByCode: (code: string) => { project: string; repo_path: string | null } | null;
  departmentExists: (id: string) => boolean;
  writePrompt: (text: string) => Promise<string>;
}

export interface ManagementRuntime {
  service: ManagementService;
  dispatcher: ManagementDispatcher;
  stop: () => Promise<void>;
}

const ENDED_STATUSES = new Set(["ended", "lost"]);

export function hashManagementToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createManagementRuntime(deps: ManagementRuntimeDeps): ManagementRuntime {
  const log = createChildLogger("management");
  const repo = new ManagementRepository(deps.db);
  const findSessionBySpawnId = deps.db.prepare(
    "SELECT id FROM sessions WHERE json_extract(metadata, '$.concordia_spawn_id') = ? LIMIT 1",
  );
  const sessionStatus = deps.db.prepare("SELECT status FROM sessions WHERE id = ?");
  const liveSessions = deps.db.prepare(
    `SELECT id, target_project AS project, branch, current_task FROM sessions
      WHERE status = 'active' AND (repo_path = @path OR repo_path LIKE @inside) ORDER BY last_seen_at DESC LIMIT 20`,
  );

  const service = new ManagementService(repo, {
    now: Date.now,
    id: randomUUID,
    newToken: () => `ccm_${randomBytes(32).toString("base64url")}`,
    hashToken: hashManagementToken,
    inject: (sessionId, text) => {
      eventBus.emit({
        type: "session.inject",
        target_session_id: sessionId,
        text,
        source: "management",
        author_label: null,
        ts: Math.floor(Date.now() / 1000),
      });
    },
    liveSessions: (projects) => projects.flatMap((code) => {
      const path = deps.projectByCode(code)?.repo_path?.replace(/\\/g, "/");
      if (!path) return [];
      return (liveSessions.all({ path, inside: `${path}/%` }) as Array<{ id: string; project: string | null; branch: string | null; current_task: string | null }>)
        .map((row) => ({ ...row, project: row.project ?? code, current_task: row.current_task?.slice(0, 300) ?? null }));
    }),
    departmentExists: deps.departmentExists,
  });

  const launch = async (request: ManagementRequest, mission: Mission, spawnId: string): Promise<LaunchResult> => {
    const project = deps.projectByCode(request.project_code);
    if (!project?.repo_path) return { ok: false, error: `プロジェクト ${request.project_code} の checkout が登録されていません` };
    // 準備の失敗は起動していないことが確定している。
    const prompt = buildLaunchPrompt(request, mission, deps.concordiaUrl);
    const promptFile = await deps.writePrompt(prompt);
    recordPendingDelegationSpawn({
      cwd: project.repo_path,
      spawnId,
      callName: "management",
      project: project.project,
      departmentId: mission.department_id,
      startupInjectText: prompt,
    });
    const result = spawnSession({
      provider: "claude",
      cwd: project.repo_path,
      cwdProvided: true,
      spawnId,
      title: `CDGD ${request.kind}`,
      env: interactiveSpawnEnvironment("claude", promptFile),
    });
    if (!result.ok) {
      forgetPendingDelegationSpawnBySpawnId(spawnId);
      return { ok: false, error: result.error };
    }
    return { ok: true };
  };

  const dispatcher = new ManagementDispatcher(service, {
    now: Date.now,
    id: randomUUID,
    isBlocked: deps.isBlocked,
    launch,
    findSessionBySpawnId: (spawnId) => (findSessionBySpawnId.get(spawnId) as { id: string } | undefined) ?? null,
    isSessionEnded: (sessionId) => {
      const row = sessionStatus.get(sessionId) as { status: string } | undefined;
      return row ? ENDED_STATUSES.has(row.status) : null;
    },
    logError: (error) => log.error({ err: error }, "management dispatch failed"),
  });

  const timer = setInterval(() => {
    try { dispatcher.tick(); } catch (error) { log.error({ err: error }, "management tick failed"); }
  }, 2_000);
  timer.unref();

  return {
    service,
    dispatcher,
    stop: async () => {
      clearInterval(timer);
      await dispatcher.stop();
    },
  };
}
