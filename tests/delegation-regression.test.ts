import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { makeTestApp } from "./helpers/test-app.js";
import type { SpawnRequest } from "../src/control/spawner.js";

const EXPECTED_SEED_CALLS = [
  "claude-fable-5-impl",
  "codex-5-6-sol",
  "codex-5-6-sol-ultra",
  "claude-opus-5-impl",
  "claude-sonnet-5-impl",
  "codex-5-6-terra",
  "claude-haiku-4-5-impl",
  "codex-5-6-luna",
  "forum-claude-session",
  "forum-codex-session",
  "impl-from-design",
  "review-duo",
  "fix-bug",
  "refactor",
  "task-process",
  "morning-tasks",
  "gemma4-12-impl",
  "test-qa",
  // レビュー・脆弱性対応・カイゼン + タスク種別別 Caller (sort_order 未指定 → 既定 1000、 call_name ASC 順)
  "daily-review-autofix",
  "deps-sweep-daily",
  "design-analysis-opus",
  "design-hard-fable5",
  "genius-ingest-daily",
  "kaizen-daily",
  "ludiars-review-daily-dual",
  "ludiars-review-weekly",
  "steam-persona-daily",
  // チーム朝礼 / 定例 (2026-08-17 neco 指示、 チームごとに fanout する parttimer)
  "team-review-regular",
  "team-standup-daily",
  "vulnerability-response-daily",
  "vultus-catalog-refresh-daily",
  // review-sonnet5 は review-duo へ一本化して無効化 (2026-07-17)
  // ludiars-review-daily は 2026-08-08 neco 指示で毎日 → 週次 (ludiars-review-weekly) へ改名し deactivate
] as const;

interface Template {
  id: string;
  call_name: string;
  target_provider: string;
  emoji: string;
  sort_order: number;
  forum_tag: boolean;
  default_cwd: string | null;
  input_schema: Array<{ name: string; type: "string" | "number" | "boolean"; required: boolean }>;
}

describe("delegation seed regression", () => {
  it("keeps the active seed delegation set explicit", async () => {
    const env = makeTestApp();
    const res = await env.app.request("/v1/delegation/templates");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { templates: Template[] };
    expect(json.templates.map((t) => t.call_name)).toEqual(EXPECTED_SEED_CALLS);
    expect(json.templates.map((t) => t.sort_order)).toEqual([10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 105, 110, 120, 130, 140, 150, 160, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(json.templates.find((t) => t.call_name === "codex-5-6-sol")?.emoji).toBe("☀️");
    expect(json.templates.find((t) => t.call_name === "codex-5-6-terra")?.emoji).toBe("🌏");
    expect(json.templates.find((t) => t.call_name === "codex-5-6-luna")?.emoji).toBe("🌙");
    expect(json.templates.filter((t) => t.forum_tag).map((t) => t.call_name)).toEqual([
      "forum-claude-session",
      "forum-codex-session",
    ]);
  });

  it("invokes every active seed delegation through the public API", async () => {
    const spawnCalls: SpawnRequest[] = [];
    const env = makeTestApp({
      delegationSpawn: (req) => {
        spawnCalls.push(req);
        return { ok: true, pid: 10_000 + spawnCalls.length, command: ["stub-spawn", req.provider] };
      },
    });
    const withNoExternalAutoModel = await withFastFamulusFallback(async () => {
      const list = await env.app.request("/v1/delegation/templates");
      const { templates } = (await list.json()) as { templates: Template[] };

      for (const template of templates) {
        const args = argsFor(template);
        const invoke = await env.app.request("/v1/delegation/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            call_name: template.call_name,
            args,
            triggered_by: "regression-test",
            spawn: true,
            options: template.target_provider === "codex" ? { model_reasoning_effort: "high" } : undefined,
          }),
        });
        expect(invoke.status, template.call_name).toBe(200);
        const json = (await invoke.json()) as {
          ok: boolean;
          run: { id: string; call_name: string; target_provider: string; status: string; args: Record<string, unknown> };
          rendered_prompt: string;
          prompt_file_path: string;
        };
        expect(json.ok, template.call_name).toBe(true);
        expect(json.run.call_name).toBe(template.call_name);
        expect(json.run.target_provider).toBe(template.target_provider);
        expect(json.run.status).toBe("spawned");
        expect(json.run.args).toEqual(args);
        expect(json.rendered_prompt.trim().length).toBeGreaterThan(0);
        expect(existsSync(json.prompt_file_path)).toBe(true);

        const promptFile = readFileSync(json.prompt_file_path, "utf8");
        expect(promptFile).toContain(`# Delegation: ${template.call_name}`);
        // 段階注入は廃止済み (spec/feature/delegation-implementation-inject.md)。
        // どの kind でもタスク本文は初回 prompt file に載る (伏せない)。
        expect(promptFile).toContain(json.rendered_prompt.trim().split(/\r?\n/)[0]);
        expect(promptFile).not.toContain("## 第 1 段階: 調査ブリーフ");

        const req = spawnCalls.at(-1);
        expect(req, template.call_name).toBeDefined();
        expect(req?.mode).toBe("window");
        expect(req?.title).toBe(`delegation:${template.call_name}`);
        expect(req?.env?.CONCORDIA_DELEGATION_RUN_ID).toBe(json.run.id);
        expect(req?.env?.CONCORDIA_DELEGATION_CALL_NAME).toBe(template.call_name);
        expect(req?.env?.CONCORDIA_DELEGATION_PROMPT_FILE).toBe(json.prompt_file_path);
        expect(req?.cwd).toBe(expectedCwd(template, args));
      }
    });

    expect(withNoExternalAutoModel).toBeUndefined();
    expect(spawnCalls).toHaveLength(EXPECTED_SEED_CALLS.length);
  });
});

function argsFor(template: Template): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const item of template.input_schema) {
    args[item.name] = valueFor(item.name, item.type);
  }
  return args;
}

function valueFor(name: string, type: "string" | "number" | "boolean"): unknown {
  if (type === "number") return 7;
  if (type === "boolean") return true;
  switch (name) {
    case "context_extra": return "Regression context";
    case "date": return "2026-07-04";
    case "description": return "Regression bug description";
    case "design_path": return "spec/design.md";
    case "goal": return "reduce coupling";
    case "reproduce_steps": return "run the regression command";
    case "target": return "src/example.ts";
    case "target_repo": return "E:\\Document\\Ars\\Concordia";
    case "task": return "Implement the regression exercise";
    case "task_list": return "- #1 [Concordia] regression delegation task";
    default: return `regression-${name}`;
  }
}

function expectedCwd(template: Template, args: Record<string, unknown>): string | undefined {
  if (!template.default_cwd) return undefined;
  return template.default_cwd.replace(/\$\{target_repo\}/g, String(args.target_repo ?? ""));
}

async function withFastFamulusFallback<T>(fn: () => Promise<T>): Promise<T> {
  const prevComSpec = process.env.ComSpec;
  const prevPath = process.env.PATH;
  process.env.ComSpec = "Z:\\concordia-test\\missing-cmd.exe";
  process.env.PATH = "";
  try {
    return await fn();
  } finally {
    if (prevComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = prevComSpec;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
}
