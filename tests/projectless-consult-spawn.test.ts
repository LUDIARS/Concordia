/**
 * 子会社のプロジェクトを持たない相談部署からの起動 (spec/feature/tech-consultation.md §6) の結合確認。
 * admin spawn が相談用ディレクトリを cwd にし、 claude のツール制限を付け、 作業領域の指定を拒否する。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../src/control/spawner.js";
import { PROJECTLESS_CONSULT_CLAUDE_ARGS } from "../src/consultation/projectless-consult.js";
import { ConsultationPublicationsRepo } from "../src/db/consultation-publications-repo.js";
import { makeTestDir } from "./helpers/db.js";
import { makeTestApp } from "./helpers/test-app.js";

type Env = ReturnType<typeof makeTestApp>;

function spawnSession(env: Env, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(env.app.request("/v1/admin/spawn-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("projectless consultation spawn in a subsidiary", () => {
  let env: Env;
  let spawnCalls: SpawnRequest[];
  let workspaceRoot: string;
  let subsidiaryId: string;
  let consultDepartmentId: string;
  let editDepartmentId: string;
  let headOfficeConsultId: string;

  beforeEach(() => {
    spawnCalls = [];
    workspaceRoot = makeTestDir("concordia-consult-ws-");
    // 相談専用の Claude 設定フォルダにログイン済みの状態 (claude の相談の前提)。
    mkdirSync(join(workspaceRoot, ".claude-config"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".claude-config", ".credentials.json"), "{}");
    writeFileSync(join(workspaceRoot, ".claude-config", ".claude.json"), JSON.stringify({ projects: {} }));
    env = makeTestApp({
      consultWorkspaceRoot: workspaceRoot,
      sessionSpawn: (request) => {
        spawnCalls.push(request);
        return { ok: true, pid: 99, command: ["wt.exe", request.provider] };
      },
    });
    env.adminState.setWorkspaceRoot(env.logsDir);
    subsidiaryId = env.subsidiary.create({ name: "glab", platform: "discord" }).id;
    const qa = env.useCases.create({
      name: "技術相談", slug: "tech-qa", format: "qa", summary: "", work_mode: "read-only", pre_data: "",
      use_requester_profile: false, intake_enabled: false,
    });
    const chores = env.useCases.create({
      name: "雑用", slug: "chores", format: "chores", summary: "", work_mode: "edit", pre_data: "",
      use_requester_profile: false, intake_enabled: false,
    });
    const consult = env.departmentService.create({
      subsidiary_id: subsidiaryId, name: "技術相談課", slug: "tech-consulting", settings: {}, use_case_id: qa.id,
    });
    const edit = env.departmentService.create({
      subsidiary_id: subsidiaryId, name: "総務", slug: "general", settings: {}, use_case_id: chores.id,
    });
    const headOffice = env.departmentService.create({
      subsidiary_id: null, name: "技術相談課", slug: "tech-consulting", settings: {}, use_case_id: qa.id,
    });
    if (!consult.ok || !edit.ok || !headOffice.ok) throw new Error("department setup failed");
    consultDepartmentId = consult.department.id;
    editDepartmentId = edit.department.id;
    headOfficeConsultId = headOffice.department.id;
  }, 30_000);

  it("spawns claude in the role workspace with the tool restriction and a per-requester data folder", async () => {
    const response = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "claude", prompt: "DDD の利点は?",
      requester_discord_user_id: "123456789012345678",
      consultation_intake: { topic: "設計", skill_level: "中級", role_title: "エンジニア", purpose: "", source: "modal" },
    });
    expect(response.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    // 役職ごとのフォルダ (2026-10-02 neco 指示「作業ディレクトリは E:/Document/Consult/役職ごとのフォルダ」)。
    const expectedCwd = join(workspaceRoot, "engineer");
    expect(spawnCalls[0]?.cwd).toBe(expectedCwd);
    expect(existsSync(expectedCwd)).toBe(true);
    const dataDir = join(expectedCwd, "123456789012345678");
    expect(existsSync(dataDir)).toBe(true);
    expect(spawnCalls[0]?.env).toMatchObject({ CONCORDIA_CONSULT_DATA_DIR: dataDir });
    expect(spawnCalls[0]?.args?.slice(-PROJECTLESS_CONSULT_CLAUDE_ARGS.length)).toEqual([...PROJECTLESS_CONSULT_CLAUDE_ARGS]);
  });

  it("chooses the model from the requester's role: Astra (codex, confined) for sound, Opus for engineers, effort medium", async () => {
    const intake = (role: string) => ({ topic: "音の質感", skill_level: "中級", role_title: role, purpose: "", source: "modal" });

    const sound = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, prompt: "Q", consultation_intake: intake("サウンドクリエイター"),
    });
    expect(sound.status).toBe(200);
    expect(spawnCalls[0]?.provider).toBe("codex");
    // GLab でも Astra。 シェル・プラグイン・AGENTS.md・MCP を外して閉じ込める (2026-10-02 neco 指示「GLab も Astra」)。
    expect(spawnCalls[0]?.args).toEqual(expect.arrayContaining(["shell_tool", "plugins", "project_doc_max_bytes=0"]));
    expect(spawnCalls[0]?.args?.join(" ")).toContain("medium");

    const engineer = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, prompt: "Q", consultation_intake: intake("エンジニア"),
    });
    expect(engineer.status).toBe(200);
    expect(spawnCalls[1]?.provider).toBe("claude");
    expect(spawnCalls[1]?.args).toEqual(expect.arrayContaining([...PROJECTLESS_CONSULT_CLAUDE_ARGS]));
  });

  it("puts the role folder's CLAUDE.md and skills into the first prompt only for providers that cannot read them (CC-CONSULT-INV-11)", async () => {
    const intake = (role: string) => ({ topic: "音の質感", skill_level: "初級", role_title: role, purpose: "", source: "modal" });
    for (const role of ["sound", "engineer"]) {
      mkdirSync(join(workspaceRoot, role, ".claude", "skills", "level-match"), { recursive: true });
      writeFileSync(join(workspaceRoot, role, "CLAUDE.md"), `${role} の前提`);
      writeFileSync(join(workspaceRoot, role, ".claude", "skills", "level-match", "SKILL.md"), "---\nname: level-match\n---\nレベルに合わせる手順");
    }
    // 相談者のデータフォルダの中は読まない。
    mkdirSync(join(workspaceRoot, "sound", "123456789012345678"), { recursive: true });
    writeFileSync(join(workspaceRoot, "sound", "123456789012345678", "CLAUDE.md"), "相談者のメモ");
    const startupOf = (request: SpawnRequest | undefined): string =>
      readFileSync(request!.env!.CONCORDIA_DELEGATION_PROMPT_FILE!, "utf8");

    // Astra (codex): テンプレート経路。 制限の直後、 依頼本文の前に載る。
    const sound = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, prompt: "残響の作り方は?",
      requester_discord_user_id: "123456789012345678", consultation_intake: intake("サウンドクリエイター"),
    });
    expect(sound.status).toBe(200);
    expect(spawnCalls[0]?.provider).toBe("codex");
    const soundStartup = startupOf(spawnCalls[0]);
    expect(soundStartup).toContain("## 相談窓口の前提と手順");
    expect(soundStartup).toContain("sound の前提");
    expect(soundStartup).toContain("### 手順: level-match");
    expect(soundStartup).toContain("レベルに合わせる手順");
    expect(soundStartup).not.toContain("name: level-match");
    expect(soundStartup).not.toContain("相談者のメモ");
    expect(soundStartup.indexOf("## 作業範囲の制限")).toBeLessThan(soundStartup.indexOf("## 相談窓口の前提と手順"));
    expect(soundStartup.indexOf("## 相談窓口の前提と手順")).toBeLessThan(soundStartup.indexOf("残響の作り方は?"));

    // codex を provider 直指定した素の経路でも載る。
    const direct = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "codex", prompt: "Q",
      consultation_intake: intake("サウンドクリエイター"),
    });
    expect(direct.status).toBe(200);
    expect(startupOf(spawnCalls[1])).toContain("sound の前提");

    // claude は自分で読むので載せない。
    const engineer = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, prompt: "Q", consultation_intake: intake("エンジニア"),
    });
    expect(engineer.status).toBe(200);
    expect(spawnCalls[2]?.provider).toBe("claude");
    expect(startupOf(spawnCalls[2])).not.toContain("## 相談窓口の前提と手順");

    // 相談以外の部署の起動では載せない。
    const other = await spawnSession(env, {
      department: editDepartmentId, subsidiary_id: subsidiaryId, provider: "codex", cwd: env.logsDir, prompt: "Q",
    });
    expect(other.status).toBe(200);
    expect(startupOf(spawnCalls[3])).not.toContain("## 相談窓口の前提と手順");
  });

  it("starts an Astra consultation without the block when the role folder has no CLAUDE.md or skills", async () => {
    const response = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "codex", prompt: "Q",
    });
    expect(response.status).toBe(200);
    const startup = readFileSync(spawnCalls[0]!.env!.CONCORDIA_DELEGATION_PROMPT_FILE!, "utf8");
    expect(startup).toContain("## 作業範囲の制限");
    expect(startup).not.toContain("## 相談窓口の前提と手順");
  });

  it("starts the session even for a duplicate and adds the published answer as a shortcut", async () => {
    // 2026-10-02 neco 指示「重複の場合もセッションは起動して回答をショートカットするだけ」。
    const publications = new ConsultationPublicationsRepo(env.db);
    const row = publications.create({ consultation_id: "c-old", title: "Unity の当たり判定がすり抜ける", summary: "高速な弾が壁をすり抜ける原因と対策" });
    publications.markPublished(row.id, {
      published_text: "連続衝突判定 (CCD) を使う。", tabula_page_id: "p1", tabula_url: "https://tabula.example/p/1", decided_by: "u1",
    });

    const response = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "claude",
      prompt: "Unity で弾が壁をすり抜けます。当たり判定の対策は?",
    });
    expect(response.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    const promptFile = spawnCalls[0]?.env?.CONCORDIA_DELEGATION_PROMPT_FILE;
    expect(promptFile).toBeTruthy();
    const startup = readFileSync(promptFile!, "utf8");
    expect(startup).toContain("過去の公開回答");
    expect(startup).toContain("https://tabula.example/p/1");
    expect(startup).toContain("連続衝突判定 (CCD) を使う。");
  });

  it("rejects a project, cwd, extra args or an unconfinable provider (CC-CONSULT-INV-07)", async () => {
    const withCwd = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "claude", cwd: env.logsDir,
    });
    expect(withCwd.status).toBe(400);
    expect(await withCwd.json()).toEqual({ error: "projectless_consult_scope_fixed: cwd" });

    const withArgs = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "claude", args: ["--tools=default"],
    });
    expect(await withArgs.json()).toEqual({ error: "projectless_consult_scope_fixed: args" });

    const gemini = await spawnSession(env, { department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "gemini" });
    expect(await gemini.json()).toEqual({ error: "projectless_consult_requires_confinable_provider" });
    expect(spawnCalls).toEqual([]);
  });

  it("spawns a head-office consultation the same way as a subsidiary one (role workspace, tool restriction, own config dir)", async () => {
    // 2026-10-02 neco 指示「本社の相談も同じで」。
    // 2026-10-02: 本社の相談部署はプロジェクトが無く、 cwd を決められずに起動に失敗していた。
    const response = await spawnSession(env, { department: headOfficeConsultId, provider: "claude", prompt: "DDD の利点は?" });
    expect(response.status).toBe(200);
    expect(spawnCalls[0]?.cwd).toBe(join(workspaceRoot, "general"));
    // 上位の CLAUDE.md と自動メモリを読まない (2026-10-02 の流出対策、 CC-CONSULT-INV-08)。
    const settings = JSON.parse(readFileSync(join(workspaceRoot, "general", ".claude", "settings.local.json"), "utf8")) as Record<string, unknown>;
    expect(settings).toMatchObject({ autoMemoryEnabled: false, claudeMdExcludes: expect.arrayContaining([`${workspaceRoot.replace(/\\/g, "/")}/CLAUDE.md`]) });
    expect(spawnCalls[0]?.env).toMatchObject({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CONFIG_DIR: join(workspaceRoot, ".claude-config"),
    });
    expect(spawnCalls[0]?.args).toEqual(expect.arrayContaining([...PROJECTLESS_CONSULT_CLAUDE_ARGS]));
    // 役職フォルダの信頼を相談専用の claude.json に書く (trust picker で止まらない)。
    const claudeJson = JSON.parse(readFileSync(join(workspaceRoot, ".claude-config", ".claude.json"), "utf8")) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(claudeJson.projects[join(workspaceRoot, "general").replace(/\\/g, "/")]?.hasTrustDialogAccepted).toBe(true);
  });

  it("refuses a claude consultation until the consult config dir is logged in", async () => {
    rmSync(join(workspaceRoot, ".claude-config", ".credentials.json"));
    const response = await spawnSession(env, { department: headOfficeConsultId, provider: "claude", prompt: "Q" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "projectless_consult_claude_login_required" });
    expect(spawnCalls).toEqual([]);
  });

  it("leaves a head-office consultation with an explicit cwd on that cwd", async () => {
    const response = await spawnSession(env, { department: headOfficeConsultId, provider: "claude", cwd: env.logsDir });
    expect(response.status).toBe(200);
    expect(spawnCalls[0]?.cwd).toBe(env.logsDir);
  });

  it("leaves other departments untouched", async () => {
    const response = await spawnSession(env, {
      department: editDepartmentId, subsidiary_id: subsidiaryId, provider: "claude", cwd: env.logsDir,
    });
    expect(response.status).toBe(200);
    expect(spawnCalls[0]?.cwd).toBe(env.logsDir);
    expect(spawnCalls[0]?.args ?? []).not.toEqual(expect.arrayContaining(["--strict-mcp-config"]));
  });
});
