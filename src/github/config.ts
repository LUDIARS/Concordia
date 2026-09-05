/**
 * GitHub Issue ワークフローの設定解決。
 *
 * 値は schema_meta (SettingsStore) が正本で、 env は既存設定と同じくフォールバック。
 * webhook secret だけは平文で置けないので github_config + secret-box に分ける。
 *
 * @implements spec/feature/github-issue-workflow.md — 設定
 */

import type { SettingsStore } from "../admin/settings-store.js";
import type { GithubConfigRepo } from "../db/github-config-repo.js";
import type { SecretBox } from "../shared/secret-box.js";
import { isEncrypted } from "../shared/secret-box.js";

export const GITHUB_WEBHOOK_SECRET_KEY = "webhook_secret_enc";

export const GITHUB_SETTING_KEYS = {
  label: "github.issue_label",
  trustedActors: "github.trusted_actors",
  pollIntervalMin: "github.poll_interval_min",
  baseBranch: "github.base_branch",
  fixCallName: "github.fix_call_name",
} as const;

export const GITHUB_DEFAULTS = {
  label: "Cc",
  pollIntervalMin: 5,
  baseBranch: "main",
  fixCallName: "github-issue-fix",
} as const;

export interface GithubWorkflowConfig {
  /** 起動ラベル。 */
  label(): string;
  /**
   * 追加の確認なしで発火してよい GitHub login。 **空配列は「誰も居ない」**であって
   * 「全員許可」ではない。 ここに載らない相手の Issue は握り潰さず、 人間の承認待ち
   * (awaiting_approval) として止める。
   */
  trustedActors(): string[];
  pollIntervalMs(): number;
  baseBranch(): string;
  fixCallName(): string;
  /** 未設定なら null。 webhook 側は null を 503 として扱う (無署名を通さない)。 */
  webhookSecret(): string | null;
  setWebhookSecret(secret: string): void;
  clearWebhookSecret(): void;
}

export interface GithubWorkflowConfigDeps {
  store: Pick<SettingsStore, "get">;
  config: GithubConfigRepo;
  /** 未注入なら secret の読み書きを拒否する (平文で置かない)。 */
  secretBox?: SecretBox;
  env?: NodeJS.ProcessEnv;
}

function readString(deps: GithubWorkflowConfigDeps, key: string, envName: string): string | null {
  const stored = deps.store.get(key)?.trim();
  if (stored) return stored;
  const fromEnv = (deps.env ?? process.env)[envName]?.trim();
  return fromEnv ? fromEnv : null;
}

/**
 * 実行者リストの解釈。
 *
 * 保存形式が 2 通りある: 設定レジストリ (kind: string-list) は **JSON 配列**で書き、
 * env は区切り文字で並べる。 JSON を区切り文字として読むと `["nyangame"]` という
 * 1 人が登録されたことになり、 本人のラベルが承認待ちに落ちる (2026-09-05 に実発生)。
 * `[` で始まる値は JSON 配列としてだけ扱い、 壊れていれば空リストへ閉じる。
 * それ以外は区切り文字で分ける。
 */
export function parseActorList(raw: string | null): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const entries = jsonArrayEntries(trimmed) ?? trimmed.split(/[\s,;]+/);
  const seen = new Set<string>();
  for (const entry of entries) {
    const login = entry.trim();
    // `*` は「全員許可」に相当し、 実行者の判定を無意味にするので受け付けない。
    if (!login || login === "*") continue;
    seen.add(login.toLowerCase());
  }
  return [...seen];
}

/** JSON 形式でなければ null。 JSON 形式の破損・異型は空配列として fail-closed に扱う。 */
function jsonArrayEntries(raw: string): string[] | null {
  if (!raw.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    if (!parsed.every((item): item is string => typeof item === "string")) return [];
    return parsed;
  } catch {
    // 認可 allowlist なので、 壊れた構造化値から actor 名を推測しない。
    return [];
  }
}

export function createGithubWorkflowConfig(deps: GithubWorkflowConfigDeps): GithubWorkflowConfig {
  const box = (): SecretBox => {
    if (!deps.secretBox) {
      throw new Error("github webhook secret requires the secret box (CONCORDIA_SECRET_KEY)");
    }
    return deps.secretBox;
  };

  return {
    label() {
      return readString(deps, GITHUB_SETTING_KEYS.label, "CONCORDIA_GITHUB_ISSUE_LABEL")
        ?? GITHUB_DEFAULTS.label;
    },
    trustedActors() {
      return parseActorList(
        readString(deps, GITHUB_SETTING_KEYS.trustedActors, "CONCORDIA_GITHUB_TRUSTED_ACTORS"),
      );
    },
    pollIntervalMs() {
      const raw = readString(deps, GITHUB_SETTING_KEYS.pollIntervalMin, "CONCORDIA_GITHUB_POLL_MIN");
      const minutes = raw === null ? GITHUB_DEFAULTS.pollIntervalMin : Number(raw);
      // 誤設定で 0 や NaN になったとき「毎 tick 叩く」に落ちないよう既定へ戻す。
      if (!Number.isFinite(minutes) || minutes < 1) return GITHUB_DEFAULTS.pollIntervalMin * 60_000;
      return Math.min(minutes, 1_440) * 60_000;
    },
    baseBranch() {
      return readString(deps, GITHUB_SETTING_KEYS.baseBranch, "CONCORDIA_GITHUB_BASE_BRANCH")
        ?? GITHUB_DEFAULTS.baseBranch;
    },
    fixCallName() {
      return readString(deps, GITHUB_SETTING_KEYS.fixCallName, "CONCORDIA_GITHUB_FIX_CALL_NAME")
        ?? GITHUB_DEFAULTS.fixCallName;
    },
    webhookSecret() {
      const stored = deps.config.get(GITHUB_WEBHOOK_SECRET_KEY);
      if (stored === null || stored.trim() === "") return null;
      if (!isEncrypted(stored)) {
        // 旧い平文が残っていたら読んだ機会に暗号化して置き直す (discord/slack と同じ作法)。
        const secretBox = box();
        deps.config.set(GITHUB_WEBHOOK_SECRET_KEY, secretBox.encrypt(stored));
        return stored;
      }
      return box().decrypt(stored);
    },
    setWebhookSecret(secret) {
      const trimmed = secret.trim();
      if (trimmed === "") throw new Error("github webhook secret must not be empty");
      deps.config.set(GITHUB_WEBHOOK_SECRET_KEY, box().encrypt(trimmed));
    },
    clearWebhookSecret() {
      deps.config.delete(GITHUB_WEBHOOK_SECRET_KEY);
    },
  };
}
