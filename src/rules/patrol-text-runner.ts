/** Patrol-only provider selection; shared quota readers retain their bounded caches. */
import { collectForumModelUsage } from "../delegation/forum-model-usage.js";
import { createChildLogger } from "../shared/logger.js";
import { choosePatrolProvider } from "./patrol-model-policy.js";
import { runClaude } from "./claude-runner.js";
import { runPatrolCodex } from "./patrol-codex-runner.js";
import type { OneShotRunner } from "./render-patrol.js";

const log = createChildLogger("patrol-text");
export const runPatrolText: OneShotRunner = async (prompt, opts) => {
  const usage = await collectForumModelUsage({ log: { warn: (message) => log.warn(message) } });
  const remaining = {
    claude: usage.claudeWeekly?.usedPct == null ? null : 100 - usage.claudeWeekly.usedPct,
    codex: usage.codexWeekly?.usedPct == null ? null : 100 - usage.codexWeekly.usedPct,
  };
  const provider = choosePatrolProvider(remaining, Math.random());
  log.info({ provider, remaining, model: provider === "codex" ? "luna" : "haiku",
    effort: provider === "codex" ? "high" : null }, "patrol model selected");
  return provider === "codex"
    ? runPatrolCodex(prompt, opts.timeoutMs)
    : runClaude(prompt, { ...opts, model: "haiku" });
};
