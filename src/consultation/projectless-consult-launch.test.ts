import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { DepartmentRow } from "../db/departments-repo.js";
import { PROJECTLESS_CONSULT_CLAUDE_ARGS } from "./projectless-consult.js";
import { resolveProjectlessConsultLaunch } from "./projectless-consult-launch.js";

function department(overrides: Partial<DepartmentRow> = {}): DepartmentRow {
  return {
    id: "dept_1",
    subsidiary_id: "glab",
    name: "技術相談課",
    slug: "tech-consulting",
    description: "",
    settings_json: "{}",
    rules_text: "",
    sort_order: 0,
    use_case_id: "uc_qa",
    is_default: 0,
    discord_forum_id: null,
    archived_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  } as DepartmentRow;
}

function ports(workMode = "read-only") {
  return {
    useCase: vi.fn(() => ({ work_mode: workMode, archived_at: null })),
    workspaceRoot: "/srv/cw",
    ensureDir: vi.fn(async () => undefined),
  };
}

describe("resolveProjectlessConsultLaunch", () => {
  it("子会社の読み取り専用・プロジェクト無しの部署は相談用ディレクトリに閉じ込める", async () => {
    const p = ports();
    const result = await resolveProjectlessConsultLaunch({ subsidiaryId: "glab", department: department(), specifiedScope: [] }, p);
    expect(result).toEqual({
      kind: "consult-workspace",
      cwd: join("/srv/cw", "glab"),
      claudeArgs: PROJECTLESS_CONSULT_CLAUDE_ARGS,
      restriction: expect.stringContaining("プロジェクトを持たない相談"),
    });
    expect(p.ensureDir).toHaveBeenCalledWith(join("/srv/cw", "glab"));
  });

  it("本社の相談部署は本社の相談用ディレクトリで、 ツールを制限せずに起動する", async () => {
    const p = ports();
    expect(await resolveProjectlessConsultLaunch(
      { subsidiaryId: null, department: department({ subsidiary_id: null }), specifiedScope: [] }, p,
    )).toEqual({ kind: "consult-workspace", cwd: join("/srv/cw", "head-office"), claudeArgs: [], restriction: null });
    expect(p.ensureDir).toHaveBeenCalledWith(join("/srv/cw", "head-office"));
  });

  it("本社で作業領域を明示した起動はその指定に従う", async () => {
    expect(await resolveProjectlessConsultLaunch(
      { subsidiaryId: null, department: department({ subsidiary_id: null }), specifiedScope: ["project"] }, ports(),
    )).toEqual({ kind: "none" });
  });

  it("部署なし・プロジェクトを持つ部署・編集可のユースケースは対象外", async () => {
    expect(await resolveProjectlessConsultLaunch({ subsidiaryId: "glab", department: null, specifiedScope: [] }, ports()))
      .toEqual({ kind: "none" });
    expect(await resolveProjectlessConsultLaunch({
      subsidiaryId: "glab", department: department({ settings_json: JSON.stringify({ projects: ["KonbiniDominant"] }) }), specifiedScope: [],
    }, ports())).toEqual({ kind: "none" });
    expect(await resolveProjectlessConsultLaunch({ subsidiaryId: "glab", department: department(), specifiedScope: [] }, ports("edit")))
      .toEqual({ kind: "none" });
  });

  it("作業領域を指定した起動要求は拒否する (CC-CONSULT-INV-07)", async () => {
    const p = ports();
    expect(await resolveProjectlessConsultLaunch({ subsidiaryId: "glab", department: department(), specifiedScope: ["cwd", "project"] }, p))
      .toEqual({ kind: "error", status: 400, error: "projectless_consult_scope_fixed: cwd,project" });
    expect(p.ensureDir).not.toHaveBeenCalled();
  });

  it("置き場所が未設定なら起動しない", async () => {
    expect(await resolveProjectlessConsultLaunch(
      { subsidiaryId: "glab", department: department(), specifiedScope: [] },
      { ...ports(), workspaceRoot: undefined },
    )).toEqual({ kind: "error", status: 503, error: "projectless_consult_workspace_unavailable" });
  });
});
