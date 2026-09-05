import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  appendPlanReviewAnswer,
  isPlanTaskHash,
  planFilePath,
  readLatestPlan,
  readPlan,
  PLAN_DIR_REL,
} from "./plan-file.js";

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repoWithPlan(hash: string, plan: Record<string, unknown>): Promise<string> {
  const repo = await mkdtemp(join(os.tmpdir(), "cc-plan-test-"));
  created.push(repo);
  await mkdir(join(repo, PLAN_DIR_REL), { recursive: true });
  await writeFile(join(repo, PLAN_DIR_REL, `${hash}.json`), JSON.stringify(plan, null, 2), "utf8");
  return repo;
}

describe("plan task hash の検証", () => {
  it("16 桁 hex だけ受ける", () => {
    expect(isPlanTaskHash("0123456789abcdef")).toBe(true);
    expect(isPlanTaskHash("0123456789ABCDEF")).toBe(false);
    expect(isPlanTaskHash("0123456789abcde")).toBe(false);
    expect(isPlanTaskHash("../../../etc/passwd")).toBe(false);
  });

  it("不正な hash はパスを作らない (任意ファイル書き込みを構造的に防ぐ)", () => {
    expect(planFilePath("E:/repo", "..")).toBeNull();
    expect(planFilePath("E:/repo", "0123456789abcdef")).not.toBeNull();
  });
});

describe("readPlan / readLatestPlan", () => {
  it("questions と unresolved を読む", async () => {
    const repo = await repoWithPlan("0123456789abcdef", {
      questions: ["問い 1"],
      unresolved: [{ repo: "cc", subject: "src/x.ts", reason: "未紐付け" }],
    });
    const plan = await readPlan(repo, "0123456789abcdef");
    expect(plan).toEqual({
      taskHash: "0123456789abcdef",
      questions: ["問い 1"],
      unresolved: [{ subject: "src/x.ts", reason: "未紐付け" }],
    });
  });

  it("plan が無ければ null (投げない)", async () => {
    const repo = await mkdtemp(join(os.tmpdir(), "cc-plan-test-"));
    created.push(repo);
    expect(await readLatestPlan(repo)).toBeNull();
    expect(await readPlan(repo, "0123456789abcdef")).toBeNull();
  });

  it("壊れた JSON でも null で済ませる", async () => {
    const repo = await mkdtemp(join(os.tmpdir(), "cc-plan-test-"));
    created.push(repo);
    await mkdir(join(repo, PLAN_DIR_REL), { recursive: true });
    await writeFile(join(repo, PLAN_DIR_REL, "0123456789abcdef.json"), "{ broken", "utf8");
    expect(await readPlan(repo, "0123456789abcdef")).toBeNull();
  });

  it("plan directory の symlink / junction をたどって repo 外を読み書きしない", async () => {
    const repo = await mkdtemp(join(os.tmpdir(), "cc-plan-test-repo-"));
    const outside = await mkdtemp(join(os.tmpdir(), "cc-plan-test-outside-"));
    created.push(repo, outside);
    const hash = "0123456789abcdef";
    const outsideFile = join(outside, `${hash}.json`);
    await writeFile(outsideFile, JSON.stringify({ questions: ["秘密"], unresolved: [] }), "utf8");
    await mkdir(join(repo, ".anatomia"), { recursive: true });
    await symlink(outside, join(repo, PLAN_DIR_REL), process.platform === "win32" ? "junction" : "dir");

    expect(await readPlan(repo, hash)).toBeNull();
    expect(await appendPlanReviewAnswer(repo, hash, {
      answeredBy: "discord:42",
      text: "上書き",
      answeredAt: "2026-09-05T00:00:00.000Z",
      source: "discord:c/reply",
    })).toBe(false);
    expect(JSON.parse(await readFile(outsideFile, "utf8"))).toEqual({ questions: ["秘密"], unresolved: [] });
  });

  it("hash 形式でないファイルは候補にしない", async () => {
    const repo = await repoWithPlan("0123456789abcdef", { questions: ["本命"], unresolved: [] });
    await writeFile(join(repo, PLAN_DIR_REL, "notes.json"), JSON.stringify({ questions: ["別物"] }), "utf8");
    const plan = await readLatestPlan(repo);
    expect(plan?.questions).toEqual(["本命"]);
  });
});

describe("appendPlanReviewAnswer", () => {
  it("reviewAnswers[] に追記し、plan 本体は書き換えない", async () => {
    const repo = await repoWithPlan("0123456789abcdef", {
      version: "plan-v2",
      task: "元のタスク",
      questions: ["問い 1"],
      unresolved: [],
    });
    const ok = await appendPlanReviewAnswer(repo, "0123456789abcdef", {
      answeredBy: "discord:42",
      text: "説明はこう直してほしい",
      answeredAt: "2026-09-05T00:00:00.000Z",
      source: "discord:c/m",
    });
    expect(ok).toBe(true);

    const saved = JSON.parse(
      await readFile(join(repo, PLAN_DIR_REL, "0123456789abcdef.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved["task"]).toBe("元のタスク");
    expect(saved["questions"]).toEqual(["問い 1"]);
    expect(saved["reviewAnswers"]).toHaveLength(1);

    await appendPlanReviewAnswer(repo, "0123456789abcdef", {
      answeredBy: "discord:43",
      text: "2 件目",
      answeredAt: "2026-09-05T00:01:00.000Z",
      source: "discord:c/m2",
    });
    const twice = JSON.parse(
      await readFile(join(repo, PLAN_DIR_REL, "0123456789abcdef.json"), "utf8"),
    ) as { reviewAnswers: unknown[] };
    expect(twice.reviewAnswers).toHaveLength(2);
  });

  it("plan が無ければ false (回答経路は落とさない)", async () => {
    const repo = await mkdtemp(join(os.tmpdir(), "cc-plan-test-"));
    created.push(repo);
    expect(await appendPlanReviewAnswer(repo, "0123456789abcdef", {
      answeredBy: "discord:42",
      text: "x",
      answeredAt: "2026-09-05T00:00:00.000Z",
      source: "discord:c/m",
    })).toBe(false);
  });

  it("同じ source の再配送は一度だけ追記する", async () => {
    const repo = await repoWithPlan("0123456789abcdef", { questions: ["問い"], unresolved: [] });
    const answer = {
      answeredBy: "discord:42",
      text: "回答",
      answeredAt: "2026-09-05T00:00:00.000Z",
      source: "discord:c/reply-1",
    };
    expect(await appendPlanReviewAnswer(repo, "0123456789abcdef", answer)).toBe(true);
    expect(await appendPlanReviewAnswer(repo, "0123456789abcdef", answer)).toBe(true);
    const saved = JSON.parse(
      await readFile(join(repo, PLAN_DIR_REL, "0123456789abcdef.json"), "utf8"),
    ) as { reviewAnswers: unknown[] };
    expect(saved.reviewAnswers).toHaveLength(1);
  });

  it("同時追記でも全回答を保持する", async () => {
    const repo = await repoWithPlan("0123456789abcdef", { questions: ["問い"], unresolved: [] });
    await Promise.all([1, 2, 3].map((id) => appendPlanReviewAnswer(repo, "0123456789abcdef", {
      answeredBy: `discord:${id}`,
      text: `回答 ${id}`,
      answeredAt: `2026-09-05T00:0${id}:00.000Z`,
      source: `discord:c/reply-${id}`,
    })));
    const saved = JSON.parse(
      await readFile(join(repo, PLAN_DIR_REL, "0123456789abcdef.json"), "utf8"),
    ) as { reviewAnswers: unknown[] };
    expect(saved.reviewAnswers).toHaveLength(3);
  });
});
