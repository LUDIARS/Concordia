import { describe, expect, it } from "vitest";
import { routeMerge, routePost, type WorkProject } from "./project-work-actions.js";

const project: WorkProject = { repository: "acme/game", base: "main", bindings: [
  { action: "task", provider: "notion", discordRoles: ["9"], minimumRole: "staff", guild: "1", channel: "2", prefix: "依頼 ", dataSource: "tasks", initial: "open", done: "done" },
  { action: "proposal", provider: "notion", discordRoles: ["9"], minimumRole: "staff", guild: "1", channel: "3", prefix: "", dataSource: "specs", initial: "draft" },
] };
const message = { guild: "1", channel: "2", id: "42", text: "依頼 セーブを直す" };

describe("project work actions", () => {
  it("routes the request and proposal independently and ignores unrelated conversation", () => {
    expect(routePost([project], message)?.text).toBe("セーブを直す");
    expect(routePost([project], { ...message, channel: "3" })?.binding.action).toBe("proposal");
    expect(routePost([project], { ...message, text: "雑談" })).toBeUndefined();
    expect(routePost([project], { ...message, guild: "7" })).toBeUndefined();
    expect(() => routePost([project, project], message)).toThrow("ambiguous");
  });
  it("requires matching repository, base, reserved work reference and completion setting", () => {
    const routes = routeMerge([project], "ACME/game", "main", "feature/cc-task-42");
    expect(routes.map(r => r.source)).toEqual(["https://discord.com/channels/1/2/42"]);
    expect(routeMerge([project], "other/game", "main", "cc-task-42")).toEqual([]);
    expect(routeMerge([project], "acme/game", "dev", "cc-task-42")).toEqual([]);
    expect(routeMerge([project], "acme/game", "main", "cc-task-42-other")).toEqual([]);
    expect(routeMerge([{ ...project, bindings: project.bindings.map(b => ({ ...b, done: undefined })) }],
      "acme/game", "main", "cc-task-42")).toEqual([]);
  });
});
