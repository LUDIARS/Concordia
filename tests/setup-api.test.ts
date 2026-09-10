import { describe, it, expect } from "vitest";
import { setupRouter } from "../src/api/setup.js";

function makeApp() {
  return setupRouter({
    toolPath: "/abs/tools/concordia-hook.mjs",
    url: "http://127.0.0.1:11111",
  });
}

describe("/v1/setup", () => {
  it("returns skill content and hook config", async () => {
    const app = makeApp();
    const r = await app.request("/");
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;

    expect(j.service).toBe("concordia");
    expect(j.url).toBe("http://127.0.0.1:11111");
    expect(j.provider).toBe("claude-code");
    expect(j.skill_version).toMatch(/\d+\.\d+\.\d+/);

    expect(j.install.skills).toHaveLength(4);
    expect(j.install.skills[0].target_path).toBe("~/.claude/skills/concordia/SKILL.md");
    expect(j.install.skills[0].content).toContain("name: concordia");
    expect(j.install.skills[0].content).toContain("Concordia 連携スキル");

    const hooks = j.install.settings_merge.hooks;
    expect(hooks.SessionStart[0].hooks[0].command).toContain("session-start");
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain("prompt");
    expect(hooks.PostToolUse.some((entry: { matcher: string }) => entry.matcher === "Edit|Write|MultiEdit")).toBe(true);
    expect(hooks.SessionEnd[0].hooks[0].command).toContain("session-end");
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.PreCompact[0].hooks[0].command).toContain("compact");
    expect(hooks.PostToolUseFailure).toBeDefined();
  });

  it("respects ?provider= query", async () => {
    const app = makeApp();
    const r = await app.request("/?provider=gemini-cli");
    const j = (await r.json()) as any;
    expect(j.provider).toBe("gemini-cli");
  });
  it("uses Codex skill placement and only supported failure hooks without granting trust", async () => {
    const j = await (await makeApp().request("/?provider=codex-cli&repo_path=E:/repo")).json() as any;
    expect(j.install.skills.every((skill: { target_path: string }) => skill.target_path.startsWith("E:/repo/.agents/skills/"))).toBe(true);
    expect(j.install.settings_merge.hooks.PostToolUseFailure).toBeUndefined();
    expect(j.install.settings_merge.hooks.PostToolUse[0].hooks[0].command).toContain("--provider=codex-cli");
    expect(j.hook_trust).toContain("does not grant hook trust");
  });
});
