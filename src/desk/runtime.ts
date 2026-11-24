/**
 * 依頼窓口の組み立て (composition)。spawn と session 照合の adapter を結び、払い出し timer の寿命を持つ。
 * 部署「AI総合 / 雑用」は設定 desk.department_id、cwd は Castra root (実装メモ 3)。
 *
 * @implements spec/feature/request-desk.md — 結線
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { interactiveSpawnEnvironment } from "../control/interactive-spawn-env.js";
import { forgetPendingDelegationSpawnBySpawnId, recordPendingDelegationSpawn } from "../control/pending-delegation-spawns.js";
import { spawnSession } from "../control/spawner.js";
import { createChildLogger } from "../shared/logger.js";
import { buildDeskStartupPrompt, type DeskRequest } from "./desk-request-policy.js";
import { DeskDispatcher, type DeskLaunchResult } from "./dispatcher.js";
import { DeskRepository } from "./repository.js";
import { DeskService } from "./service.js";

export const DESK_TICK_MS = 2_000;
const ENDED_STATUSES = new Set(["ended", "lost"]);

export interface DeskRuntimeDeps {
  db: Database.Database;
  concordiaUrl: string;
  isEnabled: () => boolean;
  isCostBlocked: () => boolean;
  workspaceRoot: () => string;
  /** 空なら部署なし。存在しない部署は渡さない。 */
  departmentId: () => string | null;
  writePrompt: (text: string) => Promise<string>;
  /** 起動の差し替え (テスト用)。既定は spawnSession。 */
  spawn?: typeof spawnSession;
}

export interface DeskRuntime {
  service: DeskService;
  dispatcher: DeskDispatcher;
  /** 依頼の状態が変わったときの受け手 (Discord のスレッド)。null で外す。 */
  attachListener: (listener: ((request: DeskRequest) => void) | null) => void;
  stop: () => Promise<void>;
}

export function createDeskRuntime(deps: DeskRuntimeDeps): DeskRuntime {
  const log = createChildLogger("desk");
  const repo = new DeskRepository(deps.db);
  const service = new DeskService(repo, { now: Date.now, id: randomUUID, isEnabled: deps.isEnabled });
  const findBySpawn = deps.db.prepare("SELECT id FROM sessions WHERE json_extract(metadata, '$.concordia_spawn_id') = ? LIMIT 1");
  const sessionStatus = deps.db.prepare("SELECT status FROM sessions WHERE id = ?");
  const spawn = deps.spawn ?? spawnSession;
  let listener: ((request: DeskRequest) => void) | null = null;

  const launch = async (request: DeskRequest, spawnId: string): Promise<DeskLaunchResult> => {
    const cwd = deps.workspaceRoot();
    if (!cwd) return { ok: false, error: "Castra root (workspace root) が設定されていません" };
    const prompt = buildDeskStartupPrompt(request, deps.concordiaUrl);
    const promptFile = await deps.writePrompt(prompt);
    recordPendingDelegationSpawn({
      cwd, spawnId, callName: "desk", departmentId: deps.departmentId(), startupInjectText: prompt,
    });
    const result = await spawn({
      provider: request.provider, cwd, cwdProvided: true, spawnId,
      title: `依頼 ${request.id.slice(0, 8)}`, env: interactiveSpawnEnvironment(request.provider, promptFile),
    });
    if (!result.ok) {
      forgetPendingDelegationSpawnBySpawnId(spawnId);
      return { ok: false, error: result.error };
    }
    return { ok: true };
  };

  const dispatcher = new DeskDispatcher(repo, {
    now: Date.now,
    id: randomUUID,
    isEnabled: deps.isEnabled,
    isCostBlocked: deps.isCostBlocked,
    launch,
    findSessionBySpawnId: (spawnId) => (findBySpawn.get(spawnId) as { id: string } | undefined)?.id ?? null,
    isSessionEnded: (sessionId) => {
      const row = sessionStatus.get(sessionId) as { status: string } | undefined;
      return row ? ENDED_STATUSES.has(row.status) : null;
    },
    onChange: (request) => listener?.(request),
    logError: (error) => log.error({ err: error }, "desk dispatch failed"),
  });

  const timer = setInterval(() => {
    try { dispatcher.tick(); } catch (error) { log.error({ err: error }, "desk tick failed"); }
  }, DESK_TICK_MS);
  timer.unref();

  return {
    service,
    dispatcher,
    attachListener: (next) => { listener = next; },
    stop: async () => {
      clearInterval(timer);
      await dispatcher.stop();
    },
  };
}
