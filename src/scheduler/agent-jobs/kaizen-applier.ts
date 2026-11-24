import { createHash } from "node:crypto";
import { INSTRUCTION_POST_MAX_CHARS, neutralizeLine } from "../../agent-instructions/instruction-posts.js";
import type { InstructionRecord } from "../../agent-instructions/instruction-service.js";
import { assessKaizenProposal, KAIZEN_MAX_PROPOSALS, type KaizenProposal } from "./kaizen-proposal.js";
import { buildAgentJobResultPost } from "./result-post.js";

export type KaizenFix = Extract<KaizenProposal, { kind: "cloud_fix" }>;

export interface KaizenJudgment {
  key: string;
  project: string | null;
  summary: string;
}

export interface KaizenApplierPorts {
  projects(): ReadonlyMap<string, string>;
  limit(): number;
  target(repo: string): Promise<{ repositoryKey: string; targetId: string } | null>;
  submit(key: string, repo: string, proposal: KaizenFix, target: { repositoryKey: string; targetId: string },
    mayLaunch: () => boolean): Promise<{ state: string; taskReference?: string }>;
  card(input: KaizenJudgment): void;
}

export async function applyKaizenResult(record: InstructionRecord, ports: KaizenApplierPorts, mayLaunch: () => boolean): Promise<string> {
  const detail = record.resultDetail as { proposals?: unknown } | null;
  const items = Array.isArray(detail?.proposals) ? detail.proposals : [];
  const projects = ports.projects();
  const allowed = new Set(projects.keys());
  const limit = ports.limit();
  let selected = 0;
  let submitted = 0;
  let cards = 0;
  let failed = 0;
  let rejected = Array.isArray(detail?.proposals) || detail?.proposals === undefined
    ? Math.max(0, items.length - KAIZEN_MAX_PROPOSALS) : 1;
  const runKey = createHash("sha256").update(record.id).digest("hex");
  const lines: string[] = [];
  for (const [index, item] of items.slice(0, KAIZEN_MAX_PROPOSALS).entries()) {
    const proposal = assessKaizenProposal(item, allowed);
    if (proposal.kind === "rejected") { rejected++; continue; }
    const key = `kaizen-${runKey}-${index + 1}`;
    const repo = projects.get(proposal.project)!;
    let disposition = "人間の判断が必要";
    let taskReference: string | undefined;
    if (proposal.kind === "cloud_fix") {
      if (!mayLaunch()) {
        disposition = "カイゼンの自動投入が停止中";
      } else if (selected >= limit) {
        disposition = "自動投入の上限に到達";
      } else {
        const target = await ports.target(repo).catch(() => undefined);
        if (target === null) {
          disposition = "適格な Codex Cloud Git 環境が未設定または利用不可";
        } else if (target === undefined) {
          disposition = "Codex Cloud の設定を照合できません";
          failed++;
        } else if (mayLaunch()) {
          selected++;
          const result = await ports.submit(key, repo, proposal, target, mayLaunch);
          taskReference = result.taskReference;
          if (result.state === "submitted") {
            submitted++;
            lines.push(`- Cloud 受付 ${taskReference ?? key}`);
            continue;
          }
          failed++;
          disposition = result.state === "submission_unknown" ? "Cloud 受付不明。再投入前に照合が必要"
            : `自動投入できません (${result.state})`;
        } else {
          disposition = "カイゼンの自動投入が停止中";
        }
      }
    }
    const title = neutralizeLine(proposal.title, 100);
    ports.card({ key, project: proposal.project, summary: [disposition, taskReference, title, neutralizeLine(proposal.reason, 175)].filter(Boolean).join(" ／ ") });
    cards++;
    lines.push(`- カード #${index + 1} ${neutralizeLine(disposition, 65)}`);
  }
  const report = buildAgentJobResultPost("提案", {
    jobName: "kaizen-daily", title: record.title, agent: record.agent, status: "done", summary: record.resultSummary ?? "",
    detail: record.resultDetail, instructionId: record.id, application: true,
  });
  const body = [
    `日次カイゼン ${record.id} — Cloud 受付 ${submitted} 件・管制カード ${cards} 件・投入経路の失敗 ${failed} 件・不正または件数超過 ${rejected} 件`,
    ...lines.slice(0, 8),
    report,
  ].join("\n");
  return Array.from(body).slice(0, INSTRUCTION_POST_MAX_CHARS).join("");
}
