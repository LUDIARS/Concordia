/**
 * チャット描画設定の解決.
 *
 * 既定は Haiku 固定運用. renderer は明示指定が無ければ APIキーの有無で決める
 * (キーあり→直 API Haiku / キー無し→サブスク CLI Haiku). どちらも Haiku なので
 * これは「能力差による選択」 であり、 スタブへの無言降格ではない
 * (memory: no-silent-fallback). template は明示指定したときのみ.
 */

import type { ChatRenderer, RenderConfig } from "./render.js";

export interface RenderConfigInput {
  /** env 由来の明示 renderer ("cli" | "haiku-api" | "template" | "" )。 空なら自動. */
  renderer: string;
  /** env 由来の明示 model。 空なら renderer から既定. */
  model: string;
  /** report 用 Haiku モデル id (haiku-api の既定 model に流用). */
  reportModel: string;
  /** Anthropic API キー (haiku-api 用). */
  apiKey: string;
}

const VALID_RENDERERS: ChatRenderer[] = ["cli", "haiku-api", "template"];

export function resolveRenderConfig(input: RenderConfigInput): RenderConfig {
  const explicit = input.renderer.trim();
  let renderer: ChatRenderer;
  if (explicit && (VALID_RENDERERS as string[]).includes(explicit)) {
    renderer = explicit as ChatRenderer;
  } else {
    renderer = input.apiKey ? "haiku-api" : "cli";
  }

  const model =
    input.model.trim() ||
    (renderer === "haiku-api" ? input.reportModel || "claude-haiku-4-5" : "haiku");

  return {
    renderer,
    model,
    apiKey: input.apiKey || undefined,
  };
}
