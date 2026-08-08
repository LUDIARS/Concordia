/**
 * 無効なワークフローに属する API のゲート。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W1-4
 *
 * 「設定で無効」 を無言で 404 にすると、 呼び出し側は経路そのものが存在しないのか
 * 設定で止まっているのか区別できない。 409 + 理由を返して、 何を戻せば動くかを示す。
 *
 * 判定は毎リクエスト resolver 経由なので、 設定変更が再起動なしで次のリクエストから効く。
 */

import type { MiddlewareHandler } from "hono";
import {
  WORKFLOW_LABELS,
  workflowEnvName,
  workflowSettingKey,
  type WorkflowKey,
} from "./keys.js";

export const WORKFLOW_DISABLED_STATUS = 409;
export const WORKFLOW_DISABLED_ERROR = "workflow_disabled";

export interface WorkflowDisabledBody {
  error: typeof WORKFLOW_DISABLED_ERROR;
  workflow: WorkflowKey;
  reason: string;
  setting_key: string;
  env_name: string;
}

export function workflowDisabledBody(key: WorkflowKey): WorkflowDisabledBody {
  const settingKey = workflowSettingKey(key);
  const envName = workflowEnvName(key);
  return {
    error: WORKFLOW_DISABLED_ERROR,
    workflow: key,
    reason:
      `ワークフロー "${WORKFLOW_LABELS[key]}" は設定で無効です。 ` +
      `有効化するには ${settingKey} (または env ${envName}) を有効にしてください。`,
    setting_key: settingKey,
    env_name: envName,
  };
}

/**
 * 無効なら 409 を返して以降のハンドラへ進ませない middleware。
 * ルートをそもそも生やさない (= 404) のではなく、 生やしたうえでここで止める。
 */
export function workflowGate(key: WorkflowKey, isEnabled: () => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (!isEnabled()) return c.json(workflowDisabledBody(key), WORKFLOW_DISABLED_STATUS);
    await next();
  };
}
