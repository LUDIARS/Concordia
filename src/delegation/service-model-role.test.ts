import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { DelegationService } from "./service.js";
import { INITIAL_CLAUDE_ROLE_MODELS } from "../model-catalog/role-policy.js";

const roles = {
  claude: { opus: "claude-opus-next", sonnet: "claude-sonnet-next", haiku: "claude-haiku-next", fable: "claude-fable-next" },
  codex: { sol: "gpt-next-sol", astra: "gpt-next-astra", luna: "gpt-next-luna" },
};

describe("DelegationService role-named templates", () => {
  let repo: DelegationRepo;
  let promptsDir: string;
  const spawnCalls: Array<{ provider: string; args?: string[] }> = [];
  const service = (withMap = true) => new DelegationService({
    repo, promptsDir, ...(withMap ? { roleMap: () => roles } : {}),
    spawn: (req) => { spawnCalls.push(req); return { ok: true, pid: 1, command: ["stub"] }; },
  });

  beforeEach(() => {
    repo = new DelegationRepo(makeTestDb());
    promptsDir = mkdtempSync(join(tmpdir(), "deleg-role-"));
    spawnCalls.length = 0;
  });
  afterEach(() => rmSync(promptsDir, { recursive: true, force: true }));

  const create = (call_name: string, target_provider: "claude" | "codex", model: string) =>
    repo.createTemplate({ call_name, title: call_name, target_provider, model, prompt_template: "go", input_schema: [] });

  it("resolves the role name to the role map ID and records it as effective_model", async () => {
    create("role-sonnet", "claude", "sonnet");
    const result = await service().invoke({ call_name: "role-sonnet", args: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.effective_model).toBe("claude-sonnet-next");
    expect(spawnCalls[0]?.args?.slice(0, 2)).toEqual(["--model", "claude-sonnet-next"]);
  });

  it("resolves a role given as a one-shot override as well", async () => {
    create("role-codex", "codex", "gpt-explicit-sol");
    const result = await service().invoke({ call_name: "role-codex", args: {}, overrides: { model: "luna" } });
    expect(result.ok && result.run.effective_model).toBe("gpt-next-luna");
  });

  it("keeps an explicit model ID unchanged", async () => {
    create("explicit", "claude", "claude-pinned-1");
    const result = await service().invoke({ call_name: "explicit", args: {} });
    expect(result.ok && result.run.effective_model).toBe("claude-pinned-1");
  });

  it("refuses to spawn when the role cannot be resolved for the provider", async () => {
    create("wrong-family", "claude", "sol");
    const result = await service().invoke({ call_name: "wrong-family", args: {} });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("delegation_model_role_unresolved:sol") });
    expect(spawnCalls).toHaveLength(0);
  });

  it("falls back to the role-policy initial values when no role map is injected", async () => {
    create("no-map", "claude", "opus");
    const result = await service(false).invoke({ call_name: "no-map", args: {} });
    expect(result.ok && result.run.effective_model).toBe(INITIAL_CLAUDE_ROLE_MODELS.opus);
  });
});
