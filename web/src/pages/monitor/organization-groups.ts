/**
 * 組織セッション画面の、 会社カード内の部署ごとの段を組み立てる純関数
 * (spec/feature/departments.md §8)。
 *
 * - 稼働中の部署はセッションが 0 本でも段を出す (その段から起動できるように)。
 * - 廃止済みの部署は、 まだ稼働セッションが残っているときだけ「(廃止)」付きで出す。
 * - 部署に属さない / 見えない部署に属するセッションは最後の「未配属」段にまとめる。
 * @implements SPEC-DEPT-WEBUI
 */

export interface GroupableSession {
  id: string;
  department_id?: string | null;
}

export interface GroupableDepartment {
  id: string;
  name: string;
  sort_order: number;
  archived: boolean;
  is_default: boolean;
}

export interface DepartmentGroup<S extends GroupableSession, D extends GroupableDepartment> {
  key: string;
  department: D | null;
  label: string;
  sessions: S[];
}

export const UNASSIGNED_LABEL = "未配属";

export function groupSessionsByDepartment<S extends GroupableSession, D extends GroupableDepartment>(
  sessions: readonly S[],
  departments: readonly D[],
): Array<DepartmentGroup<S, D>> {
  const byId = new Map(departments.map((department) => [department.id, department]));
  const buckets = new Map<string, S[]>();
  const unassigned: S[] = [];
  for (const session of sessions) {
    const department = session.department_id ? byId.get(session.department_id) : undefined;
    if (!department) {
      unassigned.push(session);
      continue;
    }
    const rows = buckets.get(department.id) ?? [];
    rows.push(session);
    buckets.set(department.id, rows);
  }
  const ordered = [...departments].sort((a, b) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const groups: Array<DepartmentGroup<S, D>> = [];
  for (const department of ordered) {
    const rows = buckets.get(department.id) ?? [];
    if (department.archived && rows.length === 0) continue;
    groups.push({
      key: department.id,
      department,
      label: department.archived ? `${department.name} (廃止)` : department.name,
      sessions: rows,
    });
  }
  if (unassigned.length > 0 || groups.length === 0) {
    groups.push({ key: "unassigned", department: null, label: UNASSIGNED_LABEL, sessions: unassigned });
  }
  return groups;
}
