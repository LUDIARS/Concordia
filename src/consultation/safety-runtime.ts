import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DepartmentsRepo } from "../db/departments-repo.js";
import type { UseCasesRepo } from "../db/use-cases-repo.js";
import type { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { parseDepartmentSettings } from "../departments/settings.js";
import { runClaude } from "../rules/claude-runner.js";
import { isProjectlessConsultDepartment } from "./projectless-consult.js";
import { ConsultationSafetyService } from "./safety-service.js";
import { eventBus } from "../events.js";

export function createConsultationSafety(deps: {
  sessions: Pick<SessionsRepo, "findSession">;
  departments?: Pick<DepartmentsRepo, "find">;
  useCases?: Pick<UseCasesRepo, "find">;
  audit: Pick<HarnessAuditRepo, "record">;
  roots(): string[];
}): ConsultationSafetyService {
  const departmentOf = (id: string) => {
    const departmentId = id.startsWith("department:") ? id.slice(11) : deps.sessions.findSession(id)?.department_id;
    return { departmentId, department: departmentId ? deps.departments?.find(departmentId) ?? null : null };
  };
  return new ConsultationSafetyService({
    // 壊れた設定・見つからない部署は制限側に倒す (例外は呼び出し側で guard_unavailable になる)。
    toolsUnrestricted: id => {
      const { department } = departmentOf(id);
      return department ? parseDepartmentSettings(department.settings_json).consult_tools === "all" : false;
    },
    isConsultation: id => {
      const { departmentId, department } = departmentOf(id);
      if (departmentId && !department) throw new Error("consultation_department_unavailable");
      if (!department?.use_case_id) return false;
      // A broken assigned department must not silently disable the safety boundary.
      const projects = parseDepartmentSettings(department.settings_json).projects;
      const useCase = deps.useCases?.find(department.use_case_id) ?? null;
      if (!useCase) throw new Error("consultation_use_case_unavailable");
      return useCase?.format === "qa" || useCase?.format === "sparring"
        || isProjectlessConsultDepartment({ projects, useCase });
    },
    confidentialTerms: async () => {
      const terms: string[] = [];
      for (const root of deps.roots()) {
        let raw: string;
        try { raw = await readFile(join(root, ".claude/state/confidential-terms.json"), "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const parsed = JSON.parse(raw) as { keywords: { value: string }[] };
        terms.push(...parsed.keywords.map(row => row.value).filter(Boolean));
      }
      return terms;
    },
    classify: async prompt => {
      const result = await runClaude(prompt, { model: "sonnet", conversationOnly: true, timeoutMs: 30_000 });
      if (!result.ok) throw new Error("consultation_classifier_unavailable");
      return result.stdout;
    },
    record: (input, verdict) => deps.audit.record({ session_id: input.sessionId,
      event: "block", hook: `consultation:${input.phase}`, tool: input.tool ?? "", decision: "deny",
      rule: `consultation-${verdict.reason}`, reason: "相談の情報保護境界で操作をブロックしました。",
      detail: { penalty_eligible: verdict.penaltyEligible, penalty_status: verdict.penaltyEligible ? "pending_review" : "not_applicable",
        notification: "pending", phase: input.phase },
    }).id,
    notify: auditId => eventBus.emit({ type: "consultation.safety_blocked", audit_id: auditId, ts: Math.floor(Date.now() / 1000) }),
  });
}
