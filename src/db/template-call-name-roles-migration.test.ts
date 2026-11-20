import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "./delegation-repo.js";
import { migrateTemplateCallNamesToRoles, TEMPLATE_CALL_NAME_RENAMES_V149 } from "./template-call-name-roles-migration.js";
import { TEMPLATE_CALL_NAME_RENAMES } from "../delegation/template-call-names.js";

function template(repo: DelegationRepo, call_name: string) {
  return repo.createTemplate({ call_name, title: call_name, target_provider: "claude", model: "opus", prompt_template: "x" });
}

describe("migrateTemplateCallNamesToRoles (migration 149)", () => {
  it("renames versioned rows in place and keeps their id", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const ids = new Map(TEMPLATE_CALL_NAME_RENAMES_V149.map(([previous]) => [previous, template(repo, previous).id]));
    expect(migrateTemplateCallNamesToRoles(db)).toBe(TEMPLATE_CALL_NAME_RENAMES_V149.length);
    for (const [previous, next] of TEMPLATE_CALL_NAME_RENAMES_V149) {
      const row = db.prepare("SELECT id FROM delegation_templates WHERE call_name = ?").get(next) as { id: string } | undefined;
      expect(row?.id).toBe(ids.get(previous));
      expect(db.prepare("SELECT 1 FROM delegation_templates WHERE call_name = ?").get(previous)).toBeUndefined();
    }
    // 旧名の invoke は解決表で新名の行に届く。
    expect(repo.findTemplateByCallName("opus-5-5")?.id).toBe(ids.get("opus-5-5"));
    expect(repo.findTemplateByCallName("terra-xhigh")?.call_name).toBe("luna-xhigh");
  });

  it("skips a rename whose new name is already taken and leaves run records alone", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const old = template(repo, "sonnet-5-5");
    const taken = template(repo, "sonnet");
    const run = repo.createRun({
      template_id: old.id, call_name: "sonnet-5-5", target_provider: "claude", args: {},
      rendered_prompt: "p", prompt_file_path: "/p.md", spawn_pid: null, spawn_command: null,
      triggered_by: null, status: "completed",
    });
    migrateTemplateCallNamesToRoles(db);
    expect(repo.findTemplate(old.id)?.call_name).toBe("sonnet-5-5");
    expect(repo.findTemplate(taken.id)?.call_name).toBe("sonnet");
    expect(repo.findRun(run.id)?.call_name).toBe("sonnet-5-5");
  });

  it("is covered by the runtime alias table", () => {
    const aliases = new Map<string, string>(TEMPLATE_CALL_NAME_RENAMES);
    for (const [previous, next] of TEMPLATE_CALL_NAME_RENAMES_V149) expect(aliases.get(previous)).toBe(next);
  });
});
