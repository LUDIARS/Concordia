/**
 * GitHub Issue に関わった login の名簿 (github_actors)。
 *
 * 権限の正本ではない — 判定は今までどおり設定 `github.trusted_actors` が持つ。
 * ここは「誰がラベルを押した / 起票した」の観測記録で、 承認待ちで止まった相手を
 * 後追いで信頼実行者へ足すときに login を手入力させないためにある
 * (Discord の社員名簿 staff_members と同じ発想: 自動記録 → 権限は人が付ける)。
 *
 * @implements spec/feature/github-issue-workflow.md — 信頼実行者
 */

import type Database from "better-sqlite3";

/** ラベルを付けた人か、 Issue を立てた人か。 権限の意味は持たない。 */
export type GithubActorKind = "labeler" | "author";

export interface GithubActorRow {
  /** 突き合わせ用の小文字 login。 */
  login: string;
  /** GitHub 上の表記 (大文字小文字を保つ)。 */
  display_login: string;
  last_kind: GithubActorKind;
  last_repo: string;
  last_issue_number: number;
  seen_count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface TouchGithubActorInput {
  login: string;
  kind: GithubActorKind;
  repoOrigin: string;
  issueNumber: number;
}

export class GithubActorsRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * 観測した login を 1 件記録する。 空 login は記録しない (bot 経路や取りこぼし
   * ポーリングで actor を確定できなかったときに空文字が来る)。
   */
  touch(input: TouchGithubActorInput): GithubActorRow | null {
    const display = input.login.trim();
    if (display === "") return null;
    const login = display.toLowerCase();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO github_actors(
        login, display_login, last_kind, last_repo, last_issue_number,
        seen_count, first_seen_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(login) DO UPDATE SET
        display_login     = excluded.display_login,
        last_kind         = excluded.last_kind,
        last_repo         = excluded.last_repo,
        last_issue_number = excluded.last_issue_number,
        seen_count        = seen_count + 1,
        last_seen_at      = excluded.last_seen_at
    `).run(login, display, input.kind, input.repoOrigin, input.issueNumber, now, now);
    return this.find(login);
  }

  find(login: string): GithubActorRow | null {
    const key = login.trim().toLowerCase();
    if (key === "") return null;
    return (this.db.prepare(`SELECT * FROM github_actors WHERE login = ?`)
      .get(key) as GithubActorRow | undefined) ?? null;
  }

  /** 直近に見かけた順。 設定画面の候補一覧はこの順で出す。 */
  list(limit = 50): GithubActorRow[] {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
    return this.db.prepare(
      `SELECT * FROM github_actors ORDER BY last_seen_at DESC LIMIT ?`,
    ).all(capped) as GithubActorRow[];
  }
}
