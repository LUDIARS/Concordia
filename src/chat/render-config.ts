/**
 * チャット描画設定の解決.
 *
 * 既定は Haiku 固定運用. renderer は明示指定が無ければ常に "cli"
 * (`claude -p` サブスク Haiku). LUDIARS は API キーを使わないため
 * Anthropic API 直叩き ("haiku-api") は廃止した. template は明示指定したときのみ
 * (= LLM 非使用のオプトアウト. スタブへの無言降格はしない / memory: no-silent-fallback).
 */

import type { ChatRenderer, RenderConfig } from "./render.js";

export interface RenderConfigInput {
  /** env 由来の明示 renderer ("cli" | "template" | "" )。 空なら "cli" 自動. */
  renderer: string;
  /** env 由来の明示 model。 空なら "haiku". */
  model: string;
}

const VALID_RENDERERS: ChatRenderer[] = ["cli", "template"];

export function resolveRenderConfig(input: RenderConfigInput): RenderConfig {
  const explicit = input.renderer.trim();
  const renderer: ChatRenderer =
    explicit && (VALID_RENDERERS as string[]).includes(explicit)
      ? (explicit as ChatRenderer)
      : "cli";

  const model = input.model.trim() || "haiku";

  return { renderer, model };
}
