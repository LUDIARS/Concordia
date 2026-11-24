import type { InstructionRecord } from "../../agent-instructions/instruction-service.js";
import { neutralizeLine } from "../../agent-instructions/instruction-posts.js";
import { publicCloudError } from "../../cloud-work/public-error.js";
import { startSupervisedInterval } from "../../shared/loop-bulkhead.js";
import { applyKaizenResult, type KaizenApplierPorts } from "./kaizen-applier.js";
import type { KaizenCloud } from "./kaizen-cloud.js";
import { isClosedByConcordia } from "../agent-dispatch-policy.js";
import type { KaizenAttempt, KaizenStore } from "./kaizen-store.js";

const INTERVAL_MS = 60_000;
const INTERRUPTED_MS = 30 * 60_000;
const RETENTION_MS = 90 * 86_400_000;

export function createKaizenRuntime(deps: {
  store: KaizenStore;
  instruction(id: string): InstructionRecord | null;
  cloud: () => KaizenCloud | undefined;
  enabled(): boolean;
  ports: KaizenApplierPorts;
  post(text: string): Promise<boolean>;
  now(): number;
  warn(message: string): void;
}) {
  let running: Promise<void> | undefined;

  async function collect(attempt: KaizenAttempt): Promise<void> {
    const scope = { repositoryKey: attempt.repository_key, subsidiaryId: null };
    let reason: string;
    try {
      const cloud = deps.cloud();
      if (!cloud) throw new Error("cloud_target_not_ready");
      const journal = await cloud.runtime.attemptJournal(scope, attempt.id);
      if (!journal.intent) {
        deps.store.finishAttempt(attempt.id, deps.now());
        return; // The applier reports pre-intent failures.
      }
      try {
        const receipt = await cloud.runtime.collect(scope, attempt.id) as { state?: string };
        if (receipt.state === "review_submitted") {
          deps.store.finishAttempt(attempt.id, deps.now());
          return;
        }
        reason = "Revisor の受付を確認できません。再提出前に照合してください";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || publicCloudError(error) === "cloud_git_result_not_received") {
          if (deps.now() < attempt.expires_at) return;
          reason = "期限までに Git 返送を確認できません";
        } else {
          reason = `Git 回収に失敗 (${publicCloudError(error)})`;
        }
      }
    } catch (error) {
      reason = `Cloud の記録を確認できません (${publicCloudError(error)})`;
    }
    deps.ports.card({ key: attempt.id, project: attempt.project,
      summary: `${reason} ／ ${attempt.task_reference} ／ ${neutralizeLine(attempt.title, 100)}` });
    deps.store.finishAttempt(attempt.id, deps.now());
  }

  async function tick(active: () => boolean): Promise<void> {
    deps.store.prune(deps.now() - RETENTION_MS);
    for (const row of deps.store.ready()) {
      if (!active()) return;
      let report = row.report;
      if (report === null) {
        const record = deps.instruction(row.id);
        if (!record || record.status !== "done" || record.agent !== "dots" || record.type !== "run_task"
          || isClosedByConcordia(record.resultDetail)) {
          deps.store.markPosted(row.id, deps.now());
          continue;
        }
        if (row.started_at !== null) {
          if (row.started_at > deps.now() - INTERRUPTED_MS) continue;
          report = `日次カイゼン ${row.id} — 処理が中断しました。Actio のタスクと Cloud 受付を照合してください。`;
          deps.ports.card({ key: row.id, project: null, summary: report });
        } else {
          if (!deps.store.claim(row.id, deps.now())) continue;
          report = await applyKaizenResult(record, deps.ports, () => active() && deps.enabled());
        }
        deps.store.recordReport(row.id, report);
      }
      if (active() && await deps.post(report)) deps.store.markPosted(row.id, deps.now());
    }
    for (const attempt of deps.store.pendingAttempts()) {
      if (!active()) return;
      await collect(attempt);
    }
  }

  return {
    start() {
      let active = true;
      const loop = startSupervisedInterval("kaizen-cloud-dispatch", async () => {
        if (running) return;
        running = tick(() => active).finally(() => { running = undefined; });
        await running;
      }, { intervalMs: INTERVAL_MS, initialDelayMs: 0, log: { warn: deps.warn } });
      return () => { active = false; loop.stop(); };
    },
    async waitForIdle(): Promise<void> { await running; },
  };
}
