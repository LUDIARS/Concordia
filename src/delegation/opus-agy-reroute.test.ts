import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { DelegationService } from "./service.js";
import { seedDelegationTemplates } from "./seed.js";

describe("DelegationService Opus → agy Claude quota reroute (DMT-07/08)", () => {
  let repo: DelegationRepo;
  let promptsDir: string;
  let remaining: number | null;
  let quotaCalls: number;
  const spawnCalls: Array<{ provider: string; args?: string[] }> = [];
  const service = () => new DelegationService({
    repo, promptsDir,
    agyClaudeRemainingPct: async () => { quotaCalls += 1; return remaining; },
    spawn: (req) => { spawnCalls.push(req); return { ok: true, pid: 1, command: ["stub"] }; },
  });
  const args = () => ({ task: "do it", target_repo: promptsDir });

  beforeEach(() => {
    repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);
    promptsDir = mkdtempSync(join(tmpdir(), "deleg-opus-agy-"));
    spawnCalls.length = 0;
    remaining = 50;
    quotaCalls = 0;
  });
  afterEach(() => rmSync(promptsDir, { recursive: true, force: true }));

  it("launches the separate agy template (its call_name / emoji) while Claude quota remains", async () => {
    const result = await service().invoke({ call_name: "opus", args: args() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const agyTemplate = repo.findTemplateByCallName("opus-gemini")!;
    expect(result.run).toMatchObject({ call_name: "opus-gemini", template_id: agyTemplate.id, effective_model: "claude-opus-5-5-medium" });
    expect(spawnCalls[0]).toMatchObject({ provider: "agy" });
    expect(spawnCalls[0]?.args?.slice(0, 2)).toEqual(["--model", "claude-opus-5-5-medium"]);
  });

  it("maps a requested effort onto the agy model", async () => {
    const result = await service().invoke({ call_name: "opus", args: args(), overrides: { reasoning_effort: "high" } });
    expect(result.ok && result.run.effective_model).toBe("claude-opus-5-5-high");
  });

  it.each([
    ["quota exhausted", { remaining: 0 }],
    ["quota unknown", { remaining: null }],
  ])("keeps the Opus template when %s", async (_label, state) => {
    remaining = state.remaining;
    const result = await service().invoke({ call_name: "opus", args: args() });
    expect(result.ok && result.run.call_name).toBe("opus");
    expect(spawnCalls[0]).toMatchObject({ provider: "claude" });
  });

  it.each(["xhigh", "max"])("keeps Opus for effort %s without asking agy", async (effort) => {
    const result = await service().invoke({ call_name: "opus", args: args(), options: { effort } });
    expect(result.ok && result.run.call_name).toBe("opus");
    expect(quotaCalls).toBe(0);
  });

  it("does not reroute explicit provider/model choices or other templates", async () => {
    await service().invoke({ call_name: "opus", args: args(), overrides: { model: "claude-opus-5-5" } });
    await service().invoke({ call_name: "sonnet", args: args() });
    expect(spawnCalls.every((c) => c.provider === "claude")).toBe(true);
    expect(quotaCalls).toBe(0);
  });

  it("keeps Opus when the agy template is disabled", async () => {
    repo.updateTemplate(repo.findTemplateByCallName("opus-gemini")!.id, { is_active: false });
    const result = await service().invoke({ call_name: "opus", args: args() });
    expect(result.ok && result.run.call_name).toBe("opus");
  });
});
