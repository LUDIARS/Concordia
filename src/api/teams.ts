import { Hono } from "hono";
import { z } from "zod";
import type { TeamRow, TeamsRepo } from "../db/teams-repo.js";
import { eventBus } from "../events.js";

const PrRulesSchema = z.object({
  base: z.string().trim().min(1).max(200),
  push: z.literal("revisor"),
}).strict();

const VibesDefaultsSchema = z.object({
  claim_sec: z.number().int().positive().max(86_400),
}).strict();

const SettingsSchema = z.object({
  revisor_lane: z.enum(["local", "github"]).optional(),
  pr_rules: PrRulesSchema.optional(),
  test_policy: z.enum(["confirm-queue", "custos-unity"]).optional(),
  worktree: z.enum(["allowed", "repo-root-only"]).optional(),
  visibility: z.enum(["public", "private"]).optional(),
  vibes_defaults: VibesDefaultsSchema.optional(),
}).strict();

const RepositoriesSchema = z.array(z.string().trim().min(1).max(500)).max(200)
  .refine((repos) => new Set(repos).size === repos.length, "duplicate repository");

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  repos: RepositoriesSchema.default([]),
  settings: SettingsSchema.default({}),
  rules_text: z.string().max(50_000).default(""),
});

const PatchSchema = CreateSchema.partial();

export type TeamSettings = z.infer<typeof SettingsSchema>;

export function teamsRouter(repo: TeamsRepo): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ teams: repo.list().map((team) => serializeTeam(repo, team)) }));

  // Concordia binds to loopback and this route shares the existing admin UI trust boundary.
  app.post("/", async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_team", detail: parsed.error.flatten() }, 400);
    const row = repo.create(parsed.data);
    repo.setRepos(row.id, parsed.data.repos);
    eventBus.emit({
      type: "team.created",
      team_id: row.id,
      name: row.name,
      slug: row.slug,
      ts: Math.floor(Date.now() / 1000),
    });
    return c.json({ team: serializeTeam(repo, row) }, 201);
  });

  app.patch("/:id", async (c) => {
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_team", detail: parsed.error.flatten() }, 400);
    const row = repo.patch(c.req.param("id"), parsed.data);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (parsed.data.repos) repo.setRepos(row.id, parsed.data.repos);
    eventBus.emit({
      type: "team.changed",
      team_id: row.id,
      fields: Object.keys(parsed.data),
      ts: Math.floor(Date.now() / 1000),
    });
    return c.json({ team: serializeTeam(repo, row) });
  });

  return app;
}

function serializeTeam(repo: TeamsRepo, row: TeamRow): TeamRow & { settings: TeamSettings; repos: string[] } {
  const settings = SettingsSchema.parse(JSON.parse(row.settings_json) as unknown);
  return { ...row, settings, repos: repo.repos(row.id) };
}
