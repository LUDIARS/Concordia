/**
 * /v1/setup — AI session が「Concordia/setup に接続して」と指示された時に叩く endpoint.
 *
 * skill markdown の本文 + hook 設定 snippet + 保存先パスを返す.
 *
 * v0.1.2 から **per-repo placement** をサポート:
 *   ?repo_path=<absolute>  を渡すと target_path を <repo_path>/.claude/skills/concordia/SKILL.md に
 *   渡さなければ ~/.claude/skills/concordia/SKILL.md (user-level fallback)
 */

import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, "..", "skills", "concordia.md");

let cachedSkill: { content: string; version: string } | null = null;

function loadSkill(): { content: string; version: string } {
  if (cachedSkill) return cachedSkill;
  const content = readFileSync(SKILL_PATH, "utf8");
  const m = /^version:\s*([\w.\-]+)\s*$/m.exec(content);
  cachedSkill = { content, version: m?.[1] ?? "0.0.0" };
  return cachedSkill;
}

export interface SetupApiDeps {
  toolPath: string;
  url: string;
}

export function setupRouter(deps: SetupApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const skill = loadSkill();
    const provider = c.req.query("provider") ?? "claude-code";
    const repoPath = c.req.query("repo_path") ?? "";
    const repoOrigin = c.req.query("repo_origin") ?? null;

    const targetPath = repoPath
      ? joinSkillPath(repoPath)
      : "~/.claude/skills/concordia/SKILL.md";

    // Windows shell 経由で backslash が消える問題を回避するため forward slash 化 + quote.
    const toolPath = deps.toolPath.replace(/\\/g, "/");
    const hookCommand = (event: string) => `node "${toolPath}" ${event}`;

    return c.json({
      service: "concordia",
      url: deps.url,
      provider,
      skill_version: skill.version,
      placement: repoPath ? "per-repo" : "user-level",
      install: {
        skills: [
          {
            target_path: targetPath,
            content: skill.content,
          },
        ],
        settings_merge: {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: hookCommand("session-start") }] },
            ],
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: hookCommand("prompt") }] },
            ],
            PostToolUse: [
              {
                matcher: "Edit|Write|MultiEdit",
                hooks: [{ type: "command", command: hookCommand("edit") }],
              },
            ],
            PreCompact: [
              { hooks: [{ type: "command", command: hookCommand("compact") }] },
            ],
            Stop: [
              { hooks: [{ type: "command", command: hookCommand("session-end") }] },
            ],
          },
        },
        skill_snapshot: {
          submit_to: "/v1/skills/snapshot",
          payload_shape: {
            repo_origin: repoOrigin,
            repo_path: repoPath,
            skill_name: "concordia",
            content: "<file content>",
            source: "setup",
          },
        },
      },
      instructions: repoPath
        ? "1) skill ファイルを target_path (per-repo) に Write. 既存があれば overwrite.\n" +
          "2) 同じ内容を POST /v1/skills/snapshot に投げて初回 snapshot を登録 (poison/growth 監視のベースライン).\n" +
          "3) ~/.claude/settings.json (もしくは <repo>/.claude/settings.local.json) を読み、 install.settings_merge.hooks をマージ (既存 hooks 維持).\n" +
          "4) skill_version をメモ. 次回 update 検知に使用.\n" +
          "5) セッション再起動で SessionStart hook が走ります."
        : "1) skill ファイルを target_path に Write (~/.claude/skills/concordia/SKILL.md).\n" +
          "2) ~/.claude/settings.json の hooks に install.settings_merge.hooks をマージ (既存維持).\n" +
          "3) Claude Code 再起動 / 新セッションで SessionStart hook が走ります.\n" +
          "4) ※per-repo 配置推奨. 次回は GET /v1/setup?repo_path=<cwd> で叩いて per-repo install してください.",
    });
  });

  return app;
}

function joinSkillPath(repoPath: string): string {
  const base = repoPath.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:/.test(base) || base.includes("\\")) {
    return base + "\\.claude\\skills\\concordia\\SKILL.md";
  }
  return base + "/.claude/skills/concordia/SKILL.md";
}
