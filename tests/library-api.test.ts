import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { libraryRouter } from "../src/api/library.js";
import { makeTestDir } from "./helpers/db.js";
import { registerCleanup } from "./helpers/cleanup.js";

/** arsDir (skills) + projectsDir (memory home) を temp に作り、 router を組む。 */
function setup() {
  const arsDir = makeTestDir("concordia-ars-");
  const projectsDir = makeTestDir("concordia-projects-");

  // グローバルスキル。
  const skillsDir = join(arsDir, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(skillsDir, "my-skill.md"),
    "---\nname: my-skill\ndescription: テストスキル\n---\n本文",
    "utf-8",
  );

  // 中央メモリ home。
  const memDir = join(projectsDir, "E--Document-Ars", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, "MEMORY.md"),
    ["# MEMORY", "", "- [Foo](feedback_foo.md) — フック"].join("\n"),
    "utf-8",
  );
  writeFileSync(join(memDir, "feedback_foo.md"), "---\nname: foo\n---\n本文", "utf-8");

  const prev = process.env.CONCORDIA_CLAUDE_PROJECTS_DIR;
  process.env.CONCORDIA_CLAUDE_PROJECTS_DIR = projectsDir;
  registerCleanup(() => {
    if (prev === undefined) delete process.env.CONCORDIA_CLAUDE_PROJECTS_DIR;
    else process.env.CONCORDIA_CLAUDE_PROJECTS_DIR = prev;
  });

  const app = libraryRouter({ resolveWorkspaceRoots: () => [arsDir] });
  return { app, arsDir, memDir };
}

describe("GET /v1/library", () => {
  it("returns memory + skill sources with summary", async () => {
    const { app } = setup();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sources: Array<{ id: string; kind: string; blocks: unknown[] }>;
      summary: { memoryBlocks: number; skillBlocks: number };
    };
    const ids = body.sources.map((s) => s.id);
    expect(ids).toContain("mem:E--Document-Ars");
    expect(ids).toContain("skill:global");
    expect(body.summary.memoryBlocks).toBe(1);
    expect(body.summary.skillBlocks).toBe(1);
  });
});

describe("POST /v1/library/archive (dry-run)", () => {
  it("returns a plan without applying", async () => {
    const { app } = setup();
    const res = await app.request("/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ sourceId: "mem:E--Document-Ars", name: "feedback_foo.md" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; items: Array<{ ok: boolean; action: string }> };
    expect(body.applied).toBe(false);
    expect(body.items[0]).toMatchObject({ ok: true, action: "move-and-deindex" });
  });

  it("404s when no block resolves", async () => {
    const { app } = setup();
    const res = await app.request("/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ sourceId: "mem:nope", name: "x.md" }] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/library/analyze", () => {
  it("reports disabled when CONCORDIA_DISABLE_CLAUDE=1 (vitest env)", async () => {
    const { app } = setup();
    const res = await app.request("/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ home: "mem:E--Document-Ars" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disabled: boolean };
    expect(body.disabled).toBe(true);
  });
});
