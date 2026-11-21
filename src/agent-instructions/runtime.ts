/**
 * 指令ブリッジの組み立て (spec/feature/agent-instructions-bridge.md)。 bootstrap から 1 回だけ呼ぶ。
 * DB・env・CF Access の公開鍵取得をここで結線し、 ルートと sweeper へ渡す口を返す。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 結線
 */

import type Database from "better-sqlite3";
import type { AgentInstructionsDeps } from "../api/agent-instructions.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { CfAccessVerifier, type JwksFetcher } from "../management/cf-access.js";
import { createChildLogger } from "../shared/logger.js";
import { readInstructionAccessConfig } from "./access-config.js";
import { InstructionService } from "./instruction-service.js";
import { createInstructionAccessGate } from "./public-access.js";

export interface AgentInstructionsRuntime {
  routes: AgentInstructionsDeps;
  sweep: () => void;
}

export function createAgentInstructionsRuntime(
  db: Database.Database,
  env: Readonly<Record<string, string | undefined>>,
  options: { fetchJwks?: JwksFetcher } = {},
): AgentInstructionsRuntime {
  const log = createChildLogger("agent-instructions");
  const config = readInstructionAccessConfig(env);
  if (config.problem) log.warn({ problem: config.problem }, "agent-instructions public access is disabled; public requests are rejected");
  else if (!config.access) log.info("agent-instructions public access is not configured; public requests are rejected");
  else log.info({ publicHost: config.publicHost }, "agent-instructions public requests require a Cloudflare Access token");
  const verifier = config.access ? new CfAccessVerifier(config.access, options.fetchJwks) : null;
  const service = new InstructionService({ store: new SqliteAgentInstructionStore(db) });
  return {
    routes: {
      service,
      access: createInstructionAccessGate({ publicHost: config.publicHost, verifier }),
      log: { info: (detail, message) => log.info(detail, message), warn: (detail, message) => log.warn(detail, message) },
    },
    sweep: () => {
      const { requeued, purged } = service.sweep();
      if (requeued > 0 || purged > 0) log.info({ requeued, purged }, "agent instructions swept");
    },
  };
}
