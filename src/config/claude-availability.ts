/**
 * Claude CLI 呼び出しを止める運転スイッチ (`CONCORDIA_DISABLE_CLAUDE`)。
 *
 * 日報 / セッションレポート / summary flags / library 解析 の 4 経路が同じキーを
 * 個別に読んでいたので、 「Claude を使ってよいか」 の判定をここに集約する。
 * 既定は有効 (= Claude を使う)。 `"1"` のときだけ無効。
 *
 * これは capability の劣化ではなく **明示選択された停止** なので、 呼び出し元は
 * スタブへ黙って逃げず 「生成しない / 空を返す」 と分かる形で分岐すること
 * (RULE_CODE §7.1)。
 */

import { readFlagDefaultOff } from "./env-parse.js";

/** `CONCORDIA_DISABLE_CLAUDE=1` なら true (Claude 呼び出しを行わない)。 */
export function isClaudeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readFlagDefaultOff(env.CONCORDIA_DISABLE_CLAUDE);
}
