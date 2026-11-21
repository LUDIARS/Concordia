/**
 * 指令ブリッジの組み立て (spec/feature/agent-instructions-bridge.md)。 bootstrap から 1 回だけ呼ぶ。
 * DB・env・公開経由の鍵の読み出しをここで結線し、 ルートと sweeper へ渡す口を返す。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 結線
 */

import type Database from "better-sqlite3";
import type { AgentInstructionsDeps } from "../api/agent-instructions.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { readInstructionAccessConfig } from "./access-config.js";
import { InstructionService } from "./instruction-service.js";
import { readInstructionIntakeToken } from "./instruction-token.js";
import { createInstructionAccessGate } from "./public-access.js";

export interface AgentInstructionsRuntime {
  routes: AgentInstructionsDeps;
  sweep: () => void;
  museEvidence: () => ReturnType<SqliteAgentInstructionStore["evidence"]> & { configured: boolean };
}

export function createAgentInstructionsRuntime(
  db: Database.Database,
  env: Readonly<Record<string, string | undefined>>,
  /** 設定 `agent_instructions.intake_token` の復号済みの値を返す。 復号できなければ throw してよい (全部断る)。 */
  readIntakeToken: () => string | null,
): AgentInstructionsRuntime {
  const log = createChildLogger("agent-instructions");
  const config = readInstructionAccessConfig(env);
  if (config.problem) log.warn({ problem: config.problem }, "agent-instructions public host is ignored; tunnel headers still mark public requests");
  log.info({ publicHost: config.publicHost }, "agent-instructions public requests require the x-excubitor-token intake key");
  const store = new SqliteAgentInstructionStore(db);
  const service = new InstructionService({ store });
  const token = () => readInstructionIntakeToken(readIntakeToken);
  return {
    routes: {
      service,
      access: createInstructionAccessGate({ publicHost: config.publicHost, readToken: token }),
      log: { info: (detail, message) => log.info(detail, message), warn: (detail, message) => log.warn(detail, message) },
    },
    museEvidence: () => ({ configured: token().kind === "set", ...store.evidence("muse") }),
    sweep: () => {
      const { requeued, purged } = service.sweep();
      if (requeued > 0 || purged > 0) log.info({ requeued, purged }, "agent instructions swept");
    },
  };
}
