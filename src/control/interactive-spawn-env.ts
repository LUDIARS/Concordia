import type { SpawnProvider } from "./spawner.js";

/**
 * 通常 spawn の初期入力を、対話の寿命を変えずに配送するための実行契約。
 * Lictor は prompt file だけだと Codex を一回実行にするため、既存の PTY 対話経路を
 * 明示する。真の delegation launcher からは呼ばない。
 */
export function interactiveSpawnEnvironment(
  provider: SpawnProvider,
  promptFilePath: string | null,
): Record<string, string> {
  return {
    ...(promptFilePath ? { CONCORDIA_DELEGATION_PROMPT_FILE: promptFilePath } : {}),
    ...(provider === "codex" ? { LICTOR_CODEX_TRANSPORT: "legacy" } : {}),
  };
}
