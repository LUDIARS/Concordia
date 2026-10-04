import type { Department, SessionRow } from "../../api.js";

export interface SessionCategory {
  id: string;
  label: string;
  defaultOpen: boolean;
  sessions: SessionRow[];
}

/** Group only the sessions returned by the authorized API; never widen their visibility. */
export function sessionCategories(
  sessions: SessionRow[], departments: Department[], companies: Array<{ id: string; display_name: string; name: string }>,
): SessionCategory[] {
  const groups = new Map<string, SessionCategory>();
  for (const session of sessions) {
    const department = departments.find((item) => item.id === session.department_id);
    const subsidiaryId = typeof session.metadata?.subsidiary_id === "string" ? session.metadata.subsidiary_id : department?.subsidiary_id;
    const company = companies.find((item) => item.id === subsidiaryId);
    const organization = subsidiaryId ? company?.display_name || company?.name || subsidiaryId : "本社";
    const workflow = session.category === "taskflow";
    const id = workflow ? "taskflow" : `${subsidiaryId ?? "hq"}:${department?.id ?? "unassigned"}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        id, label: workflow ? "タスクワークフロー" : `${organization} · ${department?.name ?? "未配属"}`,
        defaultOpen: !workflow, sessions: [],
      };
      groups.set(id, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()].sort((left, right) =>
    Number(!left.defaultOpen) - Number(!right.defaultOpen) || left.label.localeCompare(right.label, "ja"));
}
