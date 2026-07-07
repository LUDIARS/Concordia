import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readBlockContent } from "@ludiars/memory";
import { libraryRouter } from "../src/api/library.js";
import { makeTestDir } from "./helpers/db.js";
import { registerCleanup } from "./helpers/cleanup.js";

describe("readBlockContent", () => {
  it("reads a live file under rootDir", () => {
    const dir = makeTestDir("concordia-content-");
    writeFileSync(join(dir, "foo.md"), "本文だよ", "utf-8");
    const r = readBlockContent(dir, "foo.md", false);
    expect(r?.content).toBe("本文だよ");
    expect(r?.truncated).toBe(false);
  });

  it("reads an archived file under rootDir/_archive", () => {
    const dir = makeTestDir("concordia-content-");
    mkdirSync(join(dir, "_archive"), { recursive: true });
    writeFileSync(join(dir, "_archive", "old.md"), "退避済み", "utf-8");
    expect(readBlockContent(dir, "old.md", true)?.content).toBe("退避済み");
    // 同 path でも live 側には無い。
    expect(readBlockContent(dir, "old.md", false)).toBeNull();
  });

  it("reads SKILL.md for a directory skill", () => {
    const dir = makeTestDir("concordia-content-");
    mkdirSync(join(dir, "my-skill"), { recursive: true });
    writeFileSync(join(dir, "my-skill", "SKILL.md"), "スキル本文", "utf-8");
    expect(readBlockContent(dir, "my-skill", false)?.content).toBe("スキル本文");
    // SKILL.md の無いディレクトリは null。
    mkdirSync(join(dir, "empty"), { recursive: true });
    expect(readBlockContent(dir, "empty", false)).toBeNull();
  });

  it("rejects path traversal", () => {
    const dir = makeTestDir("concordia-content-");
    expect(readBlockContent(dir, "../secret.md", false)).toBeNull();
    expect(readBlockContent(dir, "..\\..\\secret.md", false)).toBeNull();
  });
});

describe("GET /v1/library/content", () => {
  function setup() {
    const arsDir = makeTestDir("concordia-ars-");
    const projectsDir = makeTestDir("concordia-projects-");
    const memDir = join(projectsDir, "E--Document-Ars", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "MEMORY.md"),
      ["# MEMORY", "", "- [Foo](feedback_foo.md) — フック"].join("\n"),
      "utf-8",
    );
    writeFileSync(join(memDir, "feedback_foo.md"), "---\nname: foo\n---\nメモ本文", "utf-8");

    const prev = process.env.CONCORDIA_CLAUDE_PROJECTS_DIR;
    process.env.CONCORDIA_CLAUDE_PROJECTS_DIR = projectsDir;
    registerCleanup(() => {
      if (prev === undefined) delete process.env.CONCORDIA_CLAUDE_PROJECTS_DIR;
      else process.env.CONCORDIA_CLAUDE_PROJECTS_DIR = prev;
    });
    return libraryRouter({ resolveWorkspaceRoots: () => [arsDir] });
  }

  it("returns block content", async () => {
    const app = setup();
    const res = await app.request(
      "/content?source=mem:E--Document-Ars&path=feedback_foo.md",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("メモ本文");
  });

  it("404s for missing path and 400 without params", async () => {
    const app = setup();
    expect((await app.request("/content?source=mem:E--Document-Ars&path=nope.md")).status).toBe(404);
    expect((await app.request("/content?source=mem:E--Document-Ars")).status).toBe(400);
  });
});
