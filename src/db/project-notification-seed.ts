import type Database from "better-sqlite3";

/**
 * 2026-09-14 neco 指定のプロジェクト別通知の初期値 (spec/feature/project-notification-preferences.md)。
 *
 * migration 108 が既存登録へ一度だけ入れる。 この表は migration の source に含めて checksum で
 * 凍結するので、 後から値を編集しない — 変更は管理 UI の保存で行う。
 * 保存形式は `src/deploy/notification-target-policy.ts` の StoredNotificationPolicy と同じ。
 */
interface SeedPolicy {
  readonly enabled: boolean;
  readonly hq: boolean;
  readonly subsidiary_scope: "none" | "operating" | "all";
  readonly subsidiary_ids: readonly string[];
}

export interface ProjectNotificationSeed {
  readonly code: string;
  readonly project: string;
  readonly release: SeedPolicy;
  readonly deploy: SeedPolicy;
}

const OFF: SeedPolicy = { enabled: false, hq: false, subsidiary_scope: "none", subsidiary_ids: [] };
const HQ_ONLY: SeedPolicy = { enabled: true, hq: true, subsidiary_scope: "none", subsidiary_ids: [] };
const HQ_AND_OPERATING: SeedPolicy = { enabled: true, hq: true, subsidiary_scope: "operating", subsidiary_ids: [] };
const HQ_AND_ALL: SeedPolicy = { enabled: true, hq: true, subsidiary_scope: "all", subsidiary_ids: [] };

export const PROJECT_NOTIFICATION_SEEDS: readonly ProjectNotificationSeed[] = [
  { code: "Ex", project: "Excubitor", release: HQ_ONLY, deploy: OFF },
  { code: "Cc", project: "Concordia", release: HQ_ONLY, deploy: HQ_AND_OPERATING },
  // Pf の「本社＋子会社」は運用対象の子会社として扱う (範囲の訂正は管理 UI で保存する)。
  { code: "Pf", project: "Praeforma", release: HQ_AND_OPERATING, deploy: OFF },
  { code: "El", project: "Elegantia", release: HQ_AND_ALL, deploy: HQ_AND_ALL },
  { code: "Rv", project: "Revisor", release: HQ_AND_ALL, deploy: HQ_AND_OPERATING },
  // Di のデプロイは外部通知なし (ローカル通知化は別途扱う)。
  { code: "Di", project: "Discutere", release: HQ_AND_ALL, deploy: OFF },
];

/**
 * code と project 名の両方が一致する登録の、 まだ未設定の列にだけ初期値を書く。
 * 同じ code を別プロジェクトが使っていれば触らず、 管理 UI で保存済みの値も上書きしない。
 */
export function applyProjectNotificationSeeds(
  db: Database.Database,
  seeds: readonly ProjectNotificationSeed[] = PROJECT_NOTIFICATION_SEEDS,
): void {
  const deploy = db.prepare(
    "UPDATE project_codes SET deploy_notification = ? WHERE code = ? COLLATE BINARY AND project = ? COLLATE NOCASE AND deploy_notification IS NULL",
  );
  const release = db.prepare(
    "UPDATE project_codes SET release_notification = ? WHERE code = ? COLLATE BINARY AND project = ? COLLATE NOCASE AND release_notification IS NULL",
  );
  for (const seed of seeds) {
    deploy.run(JSON.stringify(seed.deploy), seed.code, seed.project);
    release.run(JSON.stringify(seed.release), seed.code, seed.project);
  }
}
