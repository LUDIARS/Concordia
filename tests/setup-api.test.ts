import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function makeApp() {
  return makeTestApp({ rng: () => 0.99 }).app;
}

describe("/v1/setup", () => {
  it("returns skill content and hook config", async () => {
    const app = makeApp();
    const r = await app.request("/v1/setup");
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;

    expect(j.service).toBe("concordia");
    expect(j.url).toBe("http://127.0.0.1:17330");
    expect(j.provider).toBe("claude-code");
    expect(j.skill_version).toMatch(/\d+\.\d+\.\d+/);

    expect(j.install.skills).toHaveLength(1);
    expect(j.install.skills[0].target_path).toBe("~/.claude/skills/concordia/SKILL.md");
    expect(j.install.skills[0].content).toContain("name: concordia");
    expect(j.install.skills[0].content).toContain("Concordia 連携スキル");

    const hooks = j.install.settings_merge.hooks;
    expect(hooks.SessionStart[0].hooks[0].command).toContain("session-start");
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain("prompt");
    expect(hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit");
    expect(hooks.Stop[0].hooks[0].command).toContain("session-end");
  });

  it("respects ?provider= query", async () => {
    const app = makeApp();
    const r = await app.request("/v1/setup?provider=gemini-cli");
    const j = (await r.json()) as any;
    expect(j.provider).toBe("gemini-cli");
  });
});
