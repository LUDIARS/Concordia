import { readChatMode } from "../bootstrap/chat.js";
import { readCostMode } from "../bootstrap/cost.js";
import { readWorkflowMode } from "../bootstrap/workflow.js";
import type { ModuleManifestEntry, ModuleMode } from "./manifest.js";

/**
 * 台帳のモジュールを、 **既存のモード読み取り関数**へ橋渡しする。
 *
 * 台帳側でモードを読み直さないのが要点。 `CONCORDIA_CHAT_MODE` の解釈は
 * `readChatMode` が正本で、 ここで同じ規則を書き写すと片方だけ変わったときに
 * 台帳が嘘をつく。
 *
 * @implements spec/feature/module-manifest.md §2
 */
export function resolveModuleMode(
  entry: ModuleManifestEntry,
  env: NodeJS.ProcessEnv = process.env,
): ModuleMode {
  switch (entry.name) {
    case "chat": return readChatMode(env);
    case "cost": return readCostMode(env);
    case "workflow": return readWorkflowMode(env);
    // modeEnv を持たないモジュール (core / control-jobs) は台帳の先頭モード固定。
    default: return entry.modes[0];
  }
}
