/**
 * ワークフロー有効化フラグの値解決。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W1-1 / W6
 *
 * 解決順は DB (schema_meta) → env → 既定 (有効)。 **起動時にスナップショットを取らず、
 * 呼ばれるたびに解決する**。 これは Revisor token の `toTokenResolver` と同じ形で、
 * Web UI から設定を変えたときに再起動なしで次のリクエストから効かせるため。
 *
 * 既定は全ワークフロー有効。 無効化は明示的に設定したときだけ効く (既存環境の
 * 挙動を変えない)。
 */

import type { SettingsStore } from "../admin/settings-store.js";
import { createChildLogger } from "../shared/logger.js";
import {
  WORKFLOW_KEYS,
  workflowEnvName,
  workflowSettingKey,
  type WorkflowKey,
} from "./keys.js";

/** 値がどこから来たか (設定 UI で「env 由来」等を示すため)。 */
export type WorkflowFlagSource = "db" | "env" | "default";

export interface WorkflowFlagState {
  enabled: boolean;
  source: WorkflowFlagSource;
}

export interface WorkflowTogglesDeps {
  store: SettingsStore;
  env?: NodeJS.ProcessEnv;
  /** env に解釈できない値が入っていたら黙って既定に落とさず警告する。 */
  log?: { warn: (message: string) => void };
}

const TRUE_PATTERN = /^(1|true|yes|on)$/i;
const FALSE_PATTERN = /^(0|false|no|off)$/i;
const log = createChildLogger("workflow-toggles");

export class WorkflowToggles {
  private readonly store: SettingsStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: { warn: (message: string) => void } | undefined;

  constructor(deps: WorkflowTogglesDeps) {
    this.store = deps.store;
    this.env = deps.env ?? process.env;
    this.log = deps.log;
  }

  isEnabled(key: WorkflowKey): boolean {
    return this.state(key).enabled;
  }

  setEnabled(key: WorkflowKey, value: boolean): void {
    this.store.setBoolean(workflowSettingKey(key), value);
  }

  /**
   * 都度解決する resolver を返す。 呼び出し側は値ではなくこの関数を保持することで、
   * 起動時スナップショットを持たずに済む。
   */
  resolver(key: WorkflowKey): () => boolean {
    return () => this.isEnabled(key);
  }

  state(key: WorkflowKey): WorkflowFlagState {
    const stored = this.store.get(workflowSettingKey(key));
    if (stored !== null) {
      const parsed = parseFlag(stored);
      if (parsed !== null) return { enabled: parsed, source: "db" };
      this.warnUnparsable(workflowSettingKey(key), stored);
    }

    const envName = workflowEnvName(key);
    const raw = this.env[envName];
    if (raw !== undefined && raw.trim() !== "") {
      const parsed = parseFlag(raw);
      if (parsed !== null) return { enabled: parsed, source: "env" };
      this.warnUnparsable(envName, raw);
    }

    return { enabled: true, source: "default" };
  }

  snapshot(): Record<WorkflowKey, WorkflowFlagState> {
    const out = {} as Record<WorkflowKey, WorkflowFlagState>;
    for (const key of WORKFLOW_KEYS) out[key] = this.state(key);
    return out;
  }

  /** 全ワークフローが無効 = セッションコントロールのみ構成。 */
  isSessionControlOnly(): boolean {
    return WORKFLOW_KEYS.every((key) => !this.isEnabled(key));
  }

  private warnUnparsable(name: string, _raw: string): void {
    const message =
      `workflow flag ${name} は真偽値として解釈できません。 ` +
      "この設定は無視して次の解決元へ進みます (1/true/yes/on または 0/false/no/off を指定してください)";
    if (this.log) this.log.warn(message);
    else log.warn(message);
  }
}

function parseFlag(raw: string): boolean | null {
  const value = raw.trim();
  if (TRUE_PATTERN.test(value)) return true;
  if (FALSE_PATTERN.test(value)) return false;
  return null;
}
