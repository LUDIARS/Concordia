import type Database from "better-sqlite3";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { seedDomainReview } from "./domain-review-seed.js";

export interface ProjectCodeRow {
  code: string;
  project: string;
  repo_path: string;
  repo_origin: string | null;
  /** ドメインレビュー (Discord へのドメイン情報投稿) の対象か。 0 / 1。 */
  domain_review: number;
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
      // 新規登録も migration と同じ規則で初期値を入れる。 さもないと
      // 列追加後に登録された LUDIARS プロダクトだけが OFF で取り残される。
      const domainReview = seedDomainReview({ project: input.project, repoOrigin: input.repoOrigin }) ? 1 : 0;
      this.db.prepare(`
        INSERT INTO project_codes(
          code, project, repo_path, repo_origin, domain_review, added_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.code, input.project, repoPath, input.repoOrigin, domainReview, input.addedBy, now, now);
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
    domainReview?: boolean;
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
      const nextDomainReview = patch.domainReview === undefined
        ? existing.domain_review
        : (patch.domainReview ? 1 : 0);

      if (nextCode !== existing.code && this.findByCode(nextCode)) {
        throw new ProjectCodeConflictError("code");
      }
      this.assertUnclaimed("project", nextProject, existing.code);
      this.assertUnclaimed("repo_path", nextRepoPath, existing.code);
      if (nextRepoOrigin) this.assertUnclaimed("repo_origin", nextRepoOrigin, existing.code);

      this.db.prepare(`
        UPDATE project_codes
        SET code = ?, project = ?, repo_path = ?, repo_origin = ?, domain_review = ?, updated_at = ?
        WHERE code = ? COLLATE BINARY
      `).run(
        nextCode, nextProject, nextRepoPath, nextRepoOrigin, nextDomainReview, Date.now(), existing.code,
      );
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

  /**
   * 作業ディレクトリから登録を引く。 セッションの cwd は worktree
   * (`<root>/Concordia-feat-x`) であることが多いので、 完全一致 → 配下 →
   * 「同じ親ディレクトリで basename が `<project>-` で始まる」 の順に緩めて探す。
   * どれにも当たらなければ null (呼び出し側は「不明」として扱う)。
   */
  findByRepoPath(repoPath: string): ProjectCodeRow | null {
    const target = normalizePath(repoPath ?? "");
    if (!target) return null;
    const rows = this.list();
    const exact = rows.find((row) => normalizePath(row.repo_path) === target);
    if (exact) return exact;
    const inside = rows.find((row) => target.startsWith(`${normalizePath(row.repo_path)}/`));
    if (inside) return inside;
    const parent = target.slice(0, target.lastIndexOf("/"));
    const base = target.slice(target.lastIndexOf("/") + 1);
    return rows.find((row) => {
      const rowPath = normalizePath(row.repo_path);
      const rowParent = rowPath.slice(0, rowPath.lastIndexOf("/"));
      const rowBase = rowPath.slice(rowPath.lastIndexOf("/") + 1);
      return rowParent === parent && rowBase !== "" && base.startsWith(`${rowBase}-`);
    }) ?? null;
  }

  /**
   * `project_codes.domain_review` (ドメインレビューの opt-in、 設計 §8.2 C-3)。
   *
   * 列は別 PR で入る。 **列がまだ無い / 登録が引けない場合は null** を返し、
   * 呼び出し側は「判定できない = 止めない」として扱う — マージ順に依存させないため。
   */
  domainReviewFor(repoPath: string): boolean | null {
    if (!this.hasDomainReviewColumn()) return null;
    const row = this.findByRepoPath(repoPath);
    if (!row) return null;
    const value = this.db.prepare(
      "SELECT domain_review AS v FROM project_codes WHERE code = ? COLLATE BINARY",
    ).get(row.code) as { v: unknown } | undefined;
    if (!value || value.v === null || value.v === undefined) return null;
    return Number(value.v) !== 0;
  }

  /** domain_review 列の有無 (1 度だけ調べて覚える)。 */
  private hasDomainReviewColumn(): boolean {
    if (this.domainReviewColumn === null) {
      try {
        const columns = this.db.prepare("PRAGMA table_info(project_codes)").all() as { name: string }[];
        this.domainReviewColumn = columns.some((column) => column.name === "domain_review");
      } catch {
        this.domainReviewColumn = false;
      }
    }
    return this.domainReviewColumn;
  }

  private domainReviewColumn: boolean | null = null;

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
