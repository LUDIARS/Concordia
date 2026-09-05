/**
 * RWF の「スキル割り当て」設定 API (設計 §10.2 C-10 / §11.2 の 2)。
 *
 *   GET    /v1/admin/reaction-skill-workflows        割り当て一覧 + スキル一覧 (プルダウン用)
 *   PUT    /v1/admin/reaction-skill-workflows        1 件の登録 / 上書き
 *   DELETE /v1/admin/reaction-skill-workflows/:emoji 1 件の削除
 *   POST   /v1/reaction-workflow/migrate-builtin     組み込み写像 → スキルエントリの移行
 *
 * 保存先は既存の customWorkflows JSON。 Runner と同じパス解決を通す
 * (`resolveCustomWorkflowsPath`) — 書いた先と読む先がずれると発火しない。
 *
 * SRP: HTTP shaping と検証のみ。 写像は platform/reaction-workflow-skill.ts、
 * 永続化は platform/reaction-workflow-store.ts。
 *
 * @implements SPEC-RWF-SKILL-CATALOG
 * @implements SPEC-RWF-SKILL-ENTRY
 */

import { Hono } from "hono";
import { z } from "zod";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import {
  readCustomWorkflows,
  resolveCustomWorkflowsPath,
  updateCustomWorkflows,
} from "../platform/reaction-workflow-store.js";
import { isSkillWorkflowEntry, normalizeWorkflowEmoji } from "../platform/reaction-workflow-plan.js";
import type { CustomSkillWorkflowEntry } from "../platform/reaction-workflow-plan.js";
import type { SkillCatalogStore } from "../skills/catalog-store.js";

const UpsertSchema = z.object({
  emoji: z.string().trim().min(1).max(32),
  skill: z.string().trim().min(1).max(64),
  args: z.string().trim().max(200).refine((value) => !/[\r\n\0]/u.test(value), {
    message: "args must be a single line",
  }).optional(),
  mode: z.enum(["inject", "headless"]),
  model: z.string().trim().max(64).optional(),
  cwd: z.string().trim().max(400).optional(),
  action: z.string().trim().max(64).optional(),
  label: z.string().trim().max(80).optional(),
}).strict();

export interface ReactionSkillWorkflowDeps {
  /** Castra ルート (customWorkflows JSON と スキル走査の基点)。 */
  resolveWorkspaceRoot: () => string;
  /** スキル一覧 (プルダウンとヘルプ description の出所)。 */
  catalog: SkillCatalogStore;
  /** 組み込み → スキル の移行 (Runner が持つ実体)。 未注入なら 503。 */
  migrateBuiltin?: () => Promise<{
    entries: CustomSkillWorkflowEntry[];
    uncovered: string[];
    added: string[];
    notes: string[];
    path: string;
  }>;
}

export function reactionSkillWorkflowRouter(deps: ReactionSkillWorkflowDeps): Hono {
  const app = new Hono();
  const path = () => resolveCustomWorkflowsPath(deps.resolveWorkspaceRoot());

  app.get("/", async (c) => {
    const entries = (await readCustomWorkflows(path())).filter(isSkillWorkflowEntry);
    const catalog = deps.catalog.current();
    return c.json({
      path: path(),
      entries,
      skills: catalog.entries.map((entry) => ({
        name: entry.name,
        description: entry.description,
        source: entry.source,
        rwf: entry.rwf,
      })),
      scanned_at: catalog.scannedAt,
      notes: catalog.notes,
    });
  });

  app.put("/", async (c) => {
    const parsed = UpsertSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const input = parsed.data;
    const rwf = getRwf();
    if (rwf.isReservedNonActionEmoji(input.emoji)) {
      return c.json({ error: "body.emoji is reserved as non-actionable" }, 400);
    }
    if (input.action !== undefined && !rwf.isWorkflowAction(input.action)) {
      return c.json({ error: `body.action must be one of ${rwf.WORKFLOW_ACTIONS.join(", ")}` }, 400);
    }
    const builtinAction = rwf.classifyReactionWorkflow(input.emoji);
    if (builtinAction && input.action && input.action !== builtinAction) {
      return c.json({
        error: `body.action must be ${builtinAction} for builtin emoji ${input.emoji}`,
      }, 400);
    }
    // 一覧に無いスキル名は受けない — headless では SKILL.md 本文が要るので、
    // 登録できても発火しない割り当てを作らない。
    if (!deps.catalog.find(input.skill)) {
      return c.json({ error: `unknown skill: ${input.skill}` }, 400);
    }
    const entry: CustomSkillWorkflowEntry = {
      kind: "skill",
      emoji: input.emoji,
      skill: input.skill,
      mode: input.mode,
      ...(input.args ? { args: input.args } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(builtinAction
        ? { action: builtinAction }
        : input.action && rwf.isWorkflowAction(input.action) ? { action: input.action } : {}),
      ...(input.label ? { label: input.label } : {}),
    };
    const target = normalizeWorkflowEmoji(entry.emoji);
    const updated = await updateCustomWorkflows(path(), (existing) => {
      const kept = existing.filter(
        (e) => !isSkillWorkflowEntry(e) || normalizeWorkflowEmoji(e.emoji) !== target,
      );
      return [...kept, entry];
    });
    return c.json({ entries: updated.filter(isSkillWorkflowEntry) });
  });

  app.delete("/:emoji", async (c) => {
    const target = normalizeWorkflowEmoji(decodeURIComponent(c.req.param("emoji")));
    const updated = await updateCustomWorkflows(path(), (existing) => existing.filter(
      (e) => !isSkillWorkflowEntry(e) || normalizeWorkflowEmoji(e.emoji) !== target,
    ));
    return c.json({ entries: updated.filter(isSkillWorkflowEntry) });
  });

  return app;
}

/** `POST /v1/skills/refresh` と `POST /v1/reaction-workflow/migrate-builtin`。 */
export function reactionWorkflowMigrationRouter(deps: ReactionSkillWorkflowDeps): Hono {
  const app = new Hono();
  app.post("/migrate-builtin", async (c) => {
    if (!deps.migrateBuiltin) {
      return c.json({ error: "reaction workflow runner is not available in this runtime" }, 503);
    }
    const result = await deps.migrateBuiltin();
    return c.json({
      path: result.path,
      migrated: result.entries.length,
      entries: result.entries,
      // 組み込みにあるのにスキル割り当てが無い絵文字 = 取りこぼし。 空であることが移行完了の条件。
      uncovered: result.uncovered,
      added: result.added,
      notes: result.notes,
    });
  });
  return app;
}
