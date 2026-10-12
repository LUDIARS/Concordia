/**
 * actio-sync-migration の引数 (spec/feature/task-workflow-v3.md §移行手順)。
 * 既定は dry-run。更新は `--apply <steps> --plan <dry-run の出力>` を両方渡したときだけ行う。
 * 接続先は各サービスの catalog (excubitor.catalog.yaml) を正本とし、コードに埋め込まず引数で渡す。
 * Cc の URL と DB だけは Cc 自身の設定 (CONCORDIA_URL / CONCORDIA_DB_PATH) を既定に使える。
 */
import { parseApplySteps, type ApplyStep } from "../../taskflow/sync-migration-apply.js";
import { DEFAULT_LEGACY_RECENT_DAYS } from "../../taskflow/sync-migration-legacy-recency.js";

export interface SyncMigrationArgs {
  actioUrl: string;
  ccUrl: string;
  dbPath: string;
  out: string;
  renames: string[];
  apply: Set<ApplyStep> | null;
  plan: string | null;
  /** M5 で直近とみなす日数 (実行日から)。 */
  legacyRecentDays: number;
}

function take(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveDays(value: string): number {
  const days = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(days) || days < 1) throw new Error("--legacy-recent-days must be a positive integer");
  return days;
}

export function parseSyncMigrationArgs(argv: string[], env: Record<string, string | undefined>, defaults: { dbPath: string; out: string }): SyncMigrationArgs {
  const args: SyncMigrationArgs = {
    actioUrl: "", ccUrl: env.CONCORDIA_URL ?? "", dbPath: env.CONCORDIA_DB_PATH ?? defaults.dbPath,
    out: defaults.out, renames: [], apply: null, plan: null, legacyRecentDays: DEFAULT_LEGACY_RECENT_DAYS,
  };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!;
    switch (name) {
      case "--actio-url": args.actioUrl = take(argv, index++, name); break;
      case "--cc-url": args.ccUrl = take(argv, index++, name); break;
      case "--db": args.dbPath = take(argv, index++, name); break;
      case "--out": args.out = take(argv, index++, name); break;
      case "--rename": args.renames.push(take(argv, index++, name)); break;
      case "--apply": args.apply = parseApplySteps(take(argv, index++, name)); break;
      case "--plan": args.plan = take(argv, index++, name); break;
      case "--legacy-recent-days": args.legacyRecentDays = positiveDays(take(argv, index++, name)); break;
      default: throw new Error(`unknown argument: ${name}`);
    }
  }
  if (!args.actioUrl || !args.ccUrl) throw new Error("--actio-url and --cc-url (or CONCORDIA_URL) are required; read the ports from excubitor.catalog.yaml");
  if ((args.apply === null) !== (args.plan === null)) throw new Error("--apply and --plan must be given together (apply only a reviewed dry-run plan)");
  return args;
}
