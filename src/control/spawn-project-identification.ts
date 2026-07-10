/**
 * Initial Cc inject used to make a newly spawned session establish its target
 * project before doing work. Lictor returns the spawn identity env as session
 * metadata, so this decision does not depend on cwd/time heuristics.
 */

export const SPAWN_PROJECT_IDENTIFICATION_SOURCE = "cc-spawn-project-identification";

export const SPAWN_WITH_CWD_INJECT = "ルートディレクトリのスキルを確認しに行って";

export const SPAWN_WITHOUT_CWD_INJECT =
  "次のユーザプロンプトでプロジェクトを特定できない場合は、プロジェクトを特定する質問をユーザに行う";

export function pickSpawnProjectIdentificationInject(
  metadata: Record<string, unknown>,
): string | null {
  const spawnId = typeof metadata.concordia_spawn_id === "string"
    ? metadata.concordia_spawn_id.trim()
    : "";
  if (!spawnId) return null;

  if (metadata.concordia_spawn_cwd_mode === "provided") return SPAWN_WITH_CWD_INJECT;
  if (metadata.concordia_spawn_cwd_mode === "omitted") return SPAWN_WITHOUT_CWD_INJECT;
  return null;
}
