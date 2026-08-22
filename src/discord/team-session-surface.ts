export interface TeamSessionSurfaceSource {
  surfaceChannelId(teamId: string, surface: string): string | null;
}

/** Pick the team's matching forum, retaining the global forum as a safe fallback. */
export function resolveTeamSessionForumId(
  source: TeamSessionSurfaceSource,
  teamId: string | null | undefined,
  kind: "session" | "task",
  fallbackForumId: string,
): string {
  if (!teamId) return fallbackForumId;
  return source.surfaceChannelId(teamId, kind === "task" ? "タスク" : "セッション")
    ?? fallbackForumId;
}
