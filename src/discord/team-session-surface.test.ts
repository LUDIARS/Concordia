import { describe, expect, it } from "vitest";
import { resolveTeamSessionForumId } from "./team-session-surface.js";

describe("resolveTeamSessionForumId", () => {
  const source = {
    surfaceChannelId: (_teamId: string, surface: string) =>
      surface === "セッション" ? "team-session" : surface === "タスク" ? "team-task" : null,
  };

  it("routes direct sessions and delegation runs to their team forums", () => {
    expect(resolveTeamSessionForumId(source, "team-1", "session", "global")).toBe("team-session");
    expect(resolveTeamSessionForumId(source, "team-1", "task", "global")).toBe("team-task");
  });

  it("retains the global forum for unscoped or unprovisioned teams", () => {
    expect(resolveTeamSessionForumId(source, null, "session", "global")).toBe("global");
    expect(resolveTeamSessionForumId({ surfaceChannelId: () => null }, "team-1", "session", "global"))
      .toBe("global");
  });
});
