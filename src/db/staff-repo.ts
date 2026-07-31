/**
 * 社員名簿 (staff_members) repository。
 *
 * LLM にアクセスした platform ユーザを「記録時にサーバーでのプロファイル名を取得して」
 * 1 行ずつ残し、 役職 (staff / manager / executive) を WebUI から設定する。 役職は
 * 人間が設定するものなので、 自動記録 (touch) では絶対に上書きしない。
 *
 * 将来 Cernere の個人データと連携する可能性があるが、 今は切り離して Concordia 単独で運用する
 * (spec/feature/staff-roster.md §7 残課題)。
 */

import type Database from "better-sqlite3";

import {
  STAFF_ROLES,
  capabilityAllowed,
  isStaffRole,
  type StaffCapability,
  type StaffRole,
} from "../staff/roles.js";

export type StaffPlatform = "discord" | "slack";

export interface StaffMemberRow {
  platform: StaffPlatform;
  platform_user_id: string;
  /** platform 全体の表示名 (Discord global name / username)。 */
  display_name: string;
  /** サーバー (guild / workspace) でのプロファイル名。 空なら未取得。 */
  profile_name: string;
  role: StaffRole;
  note: string;
  first_seen_at: number;
  last_seen_at: number;
  /** 役職・メモを人間が更新した時刻。 */
  updated_at: number;
}

export interface TouchStaffMemberInput {
  platform: StaffPlatform;
  platformUserId: string;
  displayName?: string;
  profileName?: string;
}

export interface UpdateStaffMemberInput {
  role?: StaffRole;
  note?: string;
}

function toRow(raw: Record<string, unknown> | undefined): StaffMemberRow | null {
  if (!raw) return null;
  // 役職列に想定外の値が入っていても権限を与えないよう staff に丸める。
  const role = isStaffRole(raw.role) ? raw.role : "staff";
  return { ...(raw as unknown as StaffMemberRow), role };
}

export class StaffRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * LLM アクセスを検知したときの記録。 初回は role=staff (ヒラ社員) で作り、 以降は
   * 表示名・プロファイル名・最終アクセス時刻だけを更新する。 プロファイル名は取得できた
   * ときだけ上書きし、 空文字で既存の名前を潰さない。
   */
  touch(input: TouchStaffMemberInput): StaffMemberRow | null {
    const userId = input.platformUserId.trim();
    if (!userId) return null;
    const now = Date.now();
    const displayName = (input.displayName ?? "").trim();
    const profileName = (input.profileName ?? "").trim();
    this.db.prepare(`
      INSERT INTO staff_members(
        platform, platform_user_id, display_name, profile_name,
        role, note, first_seen_at, last_seen_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'staff', '', ?, ?, ?)
      ON CONFLICT(platform, platform_user_id) DO UPDATE SET
        display_name  = CASE WHEN excluded.display_name  <> '' THEN excluded.display_name  ELSE display_name  END,
        profile_name  = CASE WHEN excluded.profile_name  <> '' THEN excluded.profile_name  ELSE profile_name  END,
        last_seen_at  = excluded.last_seen_at
    `).run(input.platform, userId, displayName, profileName, now, now, now);
    return this.find(input.platform, userId);
  }

  find(platform: StaffPlatform, platformUserId: string): StaffMemberRow | null {
    const userId = platformUserId.trim();
    if (!userId) return null;
    return toRow(this.db.prepare(
      `SELECT * FROM staff_members WHERE platform = ? AND platform_user_id = ?`,
    ).get(platform, userId) as Record<string, unknown> | undefined);
  }

  /** 権限判定の唯一の入口。 未登録は null (= ヒラ社員相当) を返す。 */
  roleOf(platform: StaffPlatform, platformUserId: string): StaffRole | null {
    return this.find(platform, platformUserId)?.role ?? null;
  }

  list(options: { platform?: StaffPlatform } = {}): StaffMemberRow[] {
    const rows = options.platform
      ? this.db.prepare(
        `SELECT * FROM staff_members WHERE platform = ? ORDER BY last_seen_at DESC`,
      ).all(options.platform)
      : this.db.prepare(`SELECT * FROM staff_members ORDER BY last_seen_at DESC`).all();
    return (rows as Record<string, unknown>[]).map((raw) => toRow(raw)!);
  }

  /** 役職 / メモの更新 (人間の操作)。 存在しない行は作らない。 */
  update(
    platform: StaffPlatform,
    platformUserId: string,
    patch: UpdateStaffMemberInput,
  ): StaffMemberRow | null {
    const current = this.find(platform, platformUserId);
    if (!current) return null;
    this.db.prepare(`
      UPDATE staff_members SET role = ?, note = ?, updated_at = ?
      WHERE platform = ? AND platform_user_id = ?
    `).run(
      patch.role ?? current.role,
      patch.note ?? current.note,
      Date.now(),
      platform,
      current.platform_user_id,
    );
    return this.find(platform, current.platform_user_id);
  }

  /**
   * 名簿への手動追加。 まだ発言していないユーザに先に役職を与えるための入口
   * (Discord user ID を直接入力する)。 既存行があれば役職だけ更新する。
   */
  upsertManual(input: TouchStaffMemberInput & { role: StaffRole; note?: string }): StaffMemberRow | null {
    const created = this.touch(input);
    if (!created) return null;
    return this.update(input.platform, created.platform_user_id, {
      role: input.role,
      note: input.note ?? created.note,
    });
  }

  remove(platform: StaffPlatform, platformUserId: string): boolean {
    const userId = platformUserId.trim();
    if (!userId) return false;
    const result = this.db.prepare(
      `DELETE FROM staff_members WHERE platform = ? AND platform_user_id = ?`,
    ).run(platform, userId);
    return result.changes > 0;
  }

  /**
   * ある操作を実行できる社員の人数 (platform 別)。 リアクションワークフローの
   * 「実行可能ユーザーなし」判定に使う。
   */
  countByCapability(platform: StaffPlatform, capability: StaffCapability): number {
    const byRole = this.counts()[platform];
    return STAFF_ROLES.reduce(
      (total, role) => total + (capabilityAllowed(role, capability) ? byRole[role] : 0),
      0,
    );
  }

  /** platform / 役職ごとの件数 (WebUI のサマリと「執行役員が未登録」警告に使う)。 */
  counts(): Record<StaffPlatform, Record<StaffRole, number>> {
    const empty = (): Record<StaffRole, number> => ({ staff: 0, manager: 0, executive: 0 });
    const out: Record<StaffPlatform, Record<StaffRole, number>> = {
      discord: empty(),
      slack: empty(),
    };
    const rows = this.db.prepare(
      `SELECT platform, role, COUNT(*) AS n FROM staff_members GROUP BY platform, role`,
    ).all() as Array<{ platform: string; role: string; n: number }>;
    for (const row of rows) {
      if (row.platform !== "discord" && row.platform !== "slack") continue;
      if (!isStaffRole(row.role)) continue;
      out[row.platform][row.role] = row.n;
    }
    return out;
  }
}
