/**
 * /v1/skills API.
 *
 * - POST /v1/skills/snapshot — 各 session の hook が repo の SKILL.md 内容を投げる
 * - GET  /v1/skills           — 各 (repo, skill) の最新 snapshot 一覧 (UI)
 * - GET  /v1/skills/history   — 履歴
 */

import { Hono } from "hono";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillsRepo } from "../db/skills-repo.js";
import { analyze } from "../skills/analyzer.js";
import { eventBus } from "../events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedBaseline: string | null = null;
function loadBaseline(skillName: string): string | null {
  if (skillName !== "concordia") return null;
  if (cachedBaseline) return cachedBaseline;
  try {
    cachedBaseline = readFileSync(join(__dirname, "..", "skills", "concordia.md"), "utf8");
    return cachedBaseline;
  } catch {
    return null;
  }
}

const SnapshotSchema = z.object({
  repo_origin: z.string().nullable().optional(),
  repo_path: z.string().min(1),
  skill_name: z.string().min(1).max(64),
  content: z.string().min(0).max(200_000),
  source: z.enum(["setup", "self-update", "external", "hook"]).default("hook"),
});

export interface SkillsApiDeps {
  skills: SkillsRepo;
}

export function skillsRouter(deps: SkillsApiDeps): Hono {
  const app = new Hono();

  app.post("/snapshot", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SnapshotSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const input = parsed.data;

    const previous = deps.skills.latest(input.repo_path, input.skill_name);
    const baseline = loadBaseline(input.skill_name);

    const analysis = analyze({
      current: input.content,
      previous: previous?.content,
      baseline: baseline ?? undefined,
      expected_skill_name: input.skill_name,
    });

    // 同 hash なら skip (差分なし)
    if (previous && previous.content_hash === analysis.content_hash) {
      return c.json({ skipped: "no_change", snapshot: serialize(previous) });
    }

    const row = deps.skills.insert({
      repo_origin: input.repo_origin ?? null,
      repo_path: input.repo_path,
      skill_name: input.skill_name,
      content: input.content,
      content_hash: analysis.content_hash,
      size_bytes: analysis.size_bytes,
      line_count: analysis.line_count,
      section_count: analysis.section_count,
      source: input.source,
      poison_score: analysis.poison_score,
      poison_reasons: analysis.poison_reasons,
      growth_score: analysis.growth_score,
      growth_notes: analysis.growth_notes,
    });

    eventBus.emit({
      type: "skill.snapshot",
      skill_name: input.skill_name,
      repo_path: input.repo_path,
      poison_score: analysis.poison_score,
      growth_score: analysis.growth_score,
      ts: row.ts,
    });

    return c.json({ snapshot: serialize(row) });
  });

  app.get("/", (c) => {
    return c.json({ skills: deps.skills.listLatest().map(serialize) });
  });

  app.get("/history", (c) => {
    const repo_path = c.req.query("repo_path");
    const skill_name = c.req.query("skill_name") ?? "concordia";
    if (!repo_path) return c.json({ error: "repo_path required" }, 400);
    return c.json({
      history: deps.skills
        .history(repo_path, skill_name, 50)
        .map(serialize),
    });
  });

  return app;
}

function serialize(s: {
  id: number; repo_origin: string | null; repo_path: string; skill_name: string;
  ts: number; content_hash: string; size_bytes: number; line_count: number;
  section_count: number; source: string; poison_score: number; poison_reasons: string;
  growth_score: number; growth_notes: string; content: string;
}) {
  return {
    id: s.id,
    repo_origin: s.repo_origin,
    repo_path: s.repo_path,
    skill_name: s.skill_name,
    ts: s.ts,
    content_hash: s.content_hash,
    size_bytes: s.size_bytes,
    line_count: s.line_count,
    section_count: s.section_count,
    source: s.source,
    poison_score: s.poison_score,
    poison_reasons: safeParse(s.poison_reasons),
    growth_score: s.growth_score,
    growth_notes: safeParse(s.growth_notes),
    content_preview: s.content.length > 1500 ? s.content.slice(0, 1500) + "…" : s.content,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
