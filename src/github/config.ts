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
   * ラベルを付けてよい GitHub login。 **空配列は「誰も居ない」**であって
   * 「全員許可」ではない (fail-closed)。
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

/** 区切りは カンマ / 改行 / 空白 / `;`。 既存 allowlist と同じ寛容さで受ける。 */
export function parseActorList(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const entry of raw.split(/[\s,;]+/)) {
    const login = entry.trim();
    // `*` は「全員許可」に相当し、 実行者の判定を無意味にするので受け付けない。
    if (!login || login === "*") continue;
    seen.add(login.toLowerCase());
  }
  return [...seen];
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
