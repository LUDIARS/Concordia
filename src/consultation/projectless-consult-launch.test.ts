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
    prepareWorkspace: vi.fn(async () => undefined),
    prepareClaudeConfig: vi.fn(async () => true),
    prepareCodexHome: vi.fn(async () => true),
  };
}

describe("resolveProjectlessConsultLaunch", () => {
  it("子会社の読み取り専用・プロジェクト無しの部署は役職のディレクトリに閉じ込め、 相談者のデータフォルダを作る", async () => {
    const p = ports();
    const result = await resolveProjectlessConsultLaunch({
      subsidiaryId: "glab", department: department(), specifiedScope: [],
      roleTitle: "サウンドクリエイター", requesterDiscordUserId: "123456789012345678",
    }, p);
    const cwd = join("/srv/cw", "sound");
    const dataDir = join(cwd, "123456789012345678");
    expect(result).toEqual({
      kind: "consult-workspace",
      cwd,
      dataDir,
      claudeArgs: PROJECTLESS_CONSULT_CLAUDE_ARGS,
      restriction: expect.stringContaining("プロジェクトを持たない相談"),
      claudeConfigReady: true,
      codexHomeReady: true,
      // フックの信頼を確かめられない (port 無し) ので、 Astra にはシェルを許さない。
      codexFetchLinkReady: false,
      env: {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CONFIG_DIR: join("/srv/cw", ".claude-config"),
        CODEX_HOME: join("/srv/cw", ".codex-home"),
        CONCORDIA_CONSULT_FETCH_LINK_SCRIPT: "/srv/cw/_source/tools/fetch-link/fetch-link.mjs",
        CONCORDIA_CONSULT_DATA_DIR: dataDir,
      },
    });
    // Astra (codex) の相談専用の CODEX_HOME を用意する (利用者の ~/.codex を読ませない)。
    expect(p.prepareCodexHome).toHaveBeenCalledWith(join("/srv/cw", ".codex-home"));
    // 相談専用の設定フォルダを用意し、 役職フォルダの信頼を書く (利用者の ~/.claude を読ませない)。
    expect(p.prepareClaudeConfig).toHaveBeenCalledWith(join("/srv/cw", ".claude-config"), cwd);
    // 上位の CLAUDE.md と自動メモリを読ませない設定を書く (CC-CONSULT-INV-08)。
    expect(p.prepareWorkspace).toHaveBeenCalledWith(cwd, expect.objectContaining({
      claudeMdExcludes: expect.arrayContaining(["/srv/cw/CLAUDE.md", "/srv/cw/AGENTS.md"]),
      autoMemoryEnabled: false,
    }), dataDir);
  });

  it("本社の相談部署も子会社と同じく閉じ込めて起動する。 Discord 以外の起動はデータフォルダを作らない", async () => {
    // 2026-10-02 neco 指示「本社の相談も同じで」。
    const p = { ...ports(), prepareClaudeConfig: vi.fn(async () => false), prepareCodexHome: vi.fn(async () => false) };
    expect(await resolveProjectlessConsultLaunch(
      { subsidiaryId: null, department: department({ subsidiary_id: null }), specifiedScope: [], roleTitle: "エンジニア" }, p,
    )).toEqual({
      kind: "consult-workspace", cwd: join("/srv/cw", "engineer"), dataDir: null,
      claudeArgs: PROJECTLESS_CONSULT_CLAUDE_ARGS, restriction: expect.stringContaining("プロジェクトを持たない相談"),
      claudeConfigReady: false,
      codexHomeReady: false,
      codexFetchLinkReady: false,
      env: {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CONFIG_DIR: join("/srv/cw", ".claude-config"),
        CODEX_HOME: join("/srv/cw", ".codex-home"),
        CONCORDIA_CONSULT_FETCH_LINK_SCRIPT: "/srv/cw/_source/tools/fetch-link/fetch-link.mjs",
      },
    });
    expect(p.prepareWorkspace).toHaveBeenCalledWith(join("/srv/cw", "engineer"), expect.objectContaining({ autoMemoryEnabled: false }), null);
  });

  it("Astra のフックが信頼済みでログイン済みのときだけ、 公開リンクの取得コマンドを許す", async () => {
    const request = { subsidiaryId: "glab", department: department(), specifiedScope: [], roleTitle: "デザイナー" };
    const trusted = vi.fn(async () => true);
    const ready = await resolveProjectlessConsultLaunch(request, { ...ports(), codexPreToolHookTrusted: trusted });
    expect(ready).toMatchObject({ kind: "consult-workspace", codexFetchLinkReady: true });
    expect(trusted).toHaveBeenCalledWith(join("/srv/cw", ".codex-home"));
    expect(await resolveProjectlessConsultLaunch(request, { ...ports(), codexPreToolHookTrusted: async () => false }))
      .toMatchObject({ codexFetchLinkReady: false });
    expect(await resolveProjectlessConsultLaunch(request, {
      ...ports(), prepareCodexHome: vi.fn(async () => false), codexPreToolHookTrusted: trusted,
    })).toMatchObject({ codexFetchLinkReady: false });
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
    expect(p.prepareWorkspace).not.toHaveBeenCalled();
  });

  it("置き場所が未設定なら起動しない", async () => {
    expect(await resolveProjectlessConsultLaunch(
      { subsidiaryId: "glab", department: department(), specifiedScope: [] },
      { ...ports(), workspaceRoot: undefined },
    )).toEqual({ kind: "error", status: 503, error: "projectless_consult_workspace_unavailable" });
  });
});
