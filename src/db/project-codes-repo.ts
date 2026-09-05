import type Database from "better-sqlite3";
import { normalizeRepoOrigin } from "../pr/normalize.js";

export interface ProjectCodeRow {
  code: string;
  project: string;
  repo_path: string;
  repo_origin: string | null;
  /**
   * GitHub Issue ワークフロー (Cc ラベル起点の修正 → PR) の opt-in。
   * 既定 0 — 登録しただけの repository では発火しない。
   * @implements spec/feature/github-issue-workflow.md — 契約
   */
  github_issue_workflow: number;
  added_by: string;
  created_at: number;
  updated_at: number;
}

export interface ProjectCodeRegistration {
  code: string;
  project: string;
  repoPath: string;
  repoOrigin: string | null;
  addedBy: string;
}

export class ProjectCodeConflictError extends Error {
  constructor(readonly field: "code" | "project" | "repo_path" | "repo_origin") {
    super(`project code registration conflicts on ${field}`);
    this.name = "ProjectCodeConflictError";
  }
}

/** Cc 所有の project-code registry。初期 seed は持たず、明示登録だけを保存する。 */
export class ProjectCodesRepo {
  constructor(private readonly db: Database.Database) {}

  list(): ProjectCodeRow[] {
    return this.db.prepare("SELECT * FROM project_codes ORDER BY code COLLATE BINARY")
      .all() as ProjectCodeRow[];
  }

  /**
   * @implements spec/feature/local-pr-merge-authorization.md — project_codes lookup
   *
   * repo_origin (owner/repo) から登録を引く。 local PR のマージ認可が
   * 「その repository が Cc の管理下にあるか」を確かめるために使う
   * (spec/feature/local-pr-merge-authorization.md)。
   *
   * 保存値は `https://github.com/LUDIARS/Concordia.git` と `LUDIARS/Concordia` の
   * どちらの表記もありうるので、 突き合わせは PR 側と同じ normalizeRepoOrigin で
   * 揃えてから大小文字を畳む。 表記差を「別プロジェクト」と誤判定すると、 直したい
   * ときに限ってマージできない、 という置き換え前と同じ不安定さに戻る。
   */
  findByRepoOrigin(repoOrigin: string): ProjectCodeRow | null {
    const target = normalizeRepoOrigin(repoOrigin).toLowerCase();
    if (!target) return null;
    return this.list().find(
      (row) => normalizeRepoOrigin(row.repo_origin ?? "").toLowerCase() === target,
    ) ?? null;
  }

  findByCode(code: string): ProjectCodeRow | null {
    return (this.db.prepare("SELECT * FROM project_codes WHERE code = ? COLLATE BINARY")
      .get(code) as ProjectCodeRow | undefined) ?? null;
  }

  /**
   * 検査と INSERT は 1 transaction に閉じる。 別々の statement のままだと、 同時に走った
   * 2 つの登録が両方 assertUnclaimed を通過し、 片方が UNIQUE 制約の生エラー (= API 500) に
   * なる。 transaction 内なら後発は必ず ProjectCodeConflictError として返る。
   */
  register(input: ProjectCodeRegistration): { row: ProjectCodeRow; created: boolean } {
    // repo_path の UNIQUE は COLLATE NOCASE、 つまり大小文字しか畳まない。 `E:\...` と
    // `E:/...` は SQLite から見ると別文字列なので、 生のまま入れると同じ repository が
    // 別 code で二重登録できてしまう。 区切りだけ正規化してから保存し、 DB の制約が
    // そのまま「1 repository = 1 code」を保証するようにする。
    // 小文字化はしない — repo_path は spawn の cwd と表示にそのまま使う実パス。
    const repoPath = canonicalSeparators(input.repoPath);
    const run = this.db.transaction((): { row: ProjectCodeRow; created: boolean } => {
      const existing = this.findByCode(input.code);
      if (existing) {
        if (sameRegistration(existing, input)) return { row: existing, created: false };
        throw new ProjectCodeConflictError("code");
      }
      this.assertUnclaimed("project", input.project);
      this.assertUnclaimed("repo_path", repoPath);
      if (input.repoOrigin) this.assertUnclaimed("repo_origin", input.repoOrigin);

      const now = Date.now();
      this.db.prepare(`
        INSERT INTO project_codes(code, project, repo_path, repo_origin, added_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.code, input.project, repoPath, input.repoOrigin, input.addedBy, now, now);
      return { row: this.findByCode(input.code)!, created: true };
    });
    return run.immediate();
  }

  /**
   * 登録済み行の部分更新。 code の付け替え (rename) も受ける。 検査と UPDATE は
   * register と同じく 1 transaction に閉じ、 衝突は ProjectCodeConflictError で返す。
   */
  update(code: string, patch: {
    code?: string;
    project?: string;
    repoPath?: string;
    repoOrigin?: string | null;
  }): ProjectCodeRow | null {
    const run = this.db.transaction((): ProjectCodeRow | null => {
      const existing = this.findByCode(code);
      if (!existing) return null;
      const nextCode = patch.code ?? existing.code;
      const nextProject = patch.project ?? existing.project;
      const nextRepoPath = patch.repoPath === undefined
        ? existing.repo_path
        : canonicalSeparators(patch.repoPath);
      const nextRepoOrigin = patch.repoOrigin === undefined ? existing.repo_origin : patch.repoOrigin;

      if (nextCode !== existing.code && this.findByCode(nextCode)) {
        throw new ProjectCodeConflictError("code");
      }
      this.assertUnclaimed("project", nextProject, existing.code);
      this.assertUnclaimed("repo_path", nextRepoPath, existing.code);
      if (nextRepoOrigin) this.assertUnclaimed("repo_origin", nextRepoOrigin, existing.code);

      this.db.prepare(`
        UPDATE project_codes
        SET code = ?, project = ?, repo_path = ?, repo_origin = ?, updated_at = ?
        WHERE code = ? COLLATE BINARY
      `).run(nextCode, nextProject, nextRepoPath, nextRepoOrigin, Date.now(), existing.code);
      return this.findByCode(nextCode);
    });
    return run.immediate();
  }

  /** GitHub Issue ワークフローの opt-in を切り替える。 @implements spec/feature/github-issue-workflow.md */
  setGithubIssueWorkflow(code: string, enabled: boolean): ProjectCodeRow | null {
    const info = this.db.prepare(
      "UPDATE project_codes SET github_issue_workflow = ?, updated_at = ? WHERE code = ? COLLATE BINARY",
    ).run(enabled ? 1 : 0, Date.now(), code);
    return info.changes === 0 ? null : this.findByCode(code);
  }

  /** opt-in 済みだけを返す (ポーリングの対象集合)。 */
  listGithubIssueWorkflow(): ProjectCodeRow[] {
    return this.db.prepare(
      "SELECT * FROM project_codes WHERE github_issue_workflow = 1 ORDER BY code COLLATE BINARY",
    ).all() as ProjectCodeRow[];
  }

  remove(code: string): boolean {
    return this.db.prepare("DELETE FROM project_codes WHERE code = ? COLLATE BINARY").run(code).changes > 0;
  }

  private assertUnclaimed(
    field: "project" | "repo_path" | "repo_origin",
    value: string,
    excludeCode?: string,
  ): void {
    // field は閉じた union のみ。 値は常に bind parameter で渡す。
    const found = this.db.prepare(
      `SELECT code FROM project_codes WHERE ${field} = ? COLLATE NOCASE `
      + `AND code != ? COLLATE BINARY LIMIT 1`,
    ).get(value, excludeCode ?? "") as { code: string } | undefined;
    if (found) throw new ProjectCodeConflictError(field);
  }
}

function sameRegistration(row: ProjectCodeRow, input: ProjectCodeRegistration): boolean {
  return row.project.toLowerCase() === input.project.toLowerCase()
    && normalizePath(row.repo_path) === normalizePath(input.repoPath)
    && normalizeOptional(row.repo_origin) === normalizeOptional(input.repoOrigin);
}

/** 区切りと末尾スラッシュだけ揃える。 大小文字は DB の COLLATE NOCASE に任せる。 */
function canonicalSeparators(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizePath(value: string): string {
  return canonicalSeparators(value).toLowerCase();
}

function normalizeOptional(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}
