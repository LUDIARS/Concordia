import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import type {
  RevisorRepositoryAdmin,
  RevisorRepositoryRecord,
} from "../pr/revisor-repository-client.js";

// @implements spec/feature/project-code-registry.md — 管理 UI / Revisor workflow
// プロジェクトコードの行から Revisor の登録を引く共有部品 (Rv モードと登録テストの両 API が使う)。

/**
 * Revisor の登録一覧。 未注入は list: null (unknown)、 到達失敗も null。
 * @implements spec/feature/project-code-registry.md — 管理 UI / Revisor workflow
 */
export async function listRevisorRepositories(
  revisor: Pick<RevisorRepositoryAdmin, "listRepositories"> | undefined,
): Promise<{ list: RevisorRepositoryRecord[] | null }> {
  if (!revisor) return { list: null };
  try {
    return { list: await revisor.listRepositories() };
  } catch {
    return { list: null };
  }
}

/**
 * repo_origin (owner/name) → rootPath の順で Revisor 登録を引く。
 * @implements spec/feature/project-code-registry.md — 管理 UI / Revisor workflow
 */
export function findRevisorRecord(
  list: RevisorRepositoryRecord[],
  row: ProjectCodeRow,
): RevisorRepositoryRecord | null {
  const ownerRepo = ownerRepoFromOrigin(row.repo_origin);
  if (ownerRepo) {
    const byName = list.find((record) => record.repository.toLowerCase() === ownerRepo.toLowerCase());
    if (byName) return byName;
  }
  const normalizedPath = normalizePath(row.repo_path);
  return list.find((record) => normalizePath(record.rootPath) === normalizedPath) ?? null;
}

/**
 * `https://github.com/OWNER/NAME(.git)` / `git@github.com:OWNER/NAME.git` → `OWNER/NAME`
 * @implements spec/feature/project-code-registry.md — 管理 UI / Revisor workflow
 */
export function ownerRepoFromOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
    .exec(origin.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** @implements spec/feature/project-code-registry.md — 管理 UI / Revisor workflow */
function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
