/**
 * @implements spec/feature/operational-log-lifecycle.md — bounded cc-live retention
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rotateLogFileIfOversize, type RotationPolicy } from "./log-file-rotation.js";

const testDirs: string[] = [];

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "concordia-logrotate-"));
  testDirs.push(base);
  return base;
}

function policy(maxBytes: number, keep = 5): RotationPolicy {
  return { maxBytes, keep };
}

function archivesOf(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("cc-live.") && name.endsWith(".jsonl") && name !== "cc-live.jsonl")
    .sort();
}

describe("rotateLogFileIfOversize", () => {
  it("閾値未満なら何もしない", async () => {
    const dir = await fixture();
    const file = path.join(dir, "cc-live.jsonl");
    fs.writeFileSync(file, "x".repeat(100));

    expect(rotateLogFileIfOversize(file, policy(1024))).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(archivesOf(dir)).toHaveLength(0);
  });

  it("未作成なら何もしない (pino 側の create に任せる)", async () => {
    const dir = await fixture();
    expect(rotateLogFileIfOversize(path.join(dir, "cc-live.jsonl"), policy(1))).toBe(false);
  });

  it("閾値以上なら退避し、元のパスを空ける", async () => {
    const dir = await fixture();
    const file = path.join(dir, "cc-live.jsonl");
    fs.writeFileSync(file, "y".repeat(2048));

    expect(rotateLogFileIfOversize(file, policy(1024), new Date(2026, 6, 30, 16, 45, 30))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);

    const archives = archivesOf(dir);
    expect(archives).toEqual(["cc-live.20260730-164530.jsonl"]);
    expect(fs.readFileSync(path.join(dir, archives[0]!), "utf8")).toHaveLength(2048);
  });

  it("keep を超えた古い退避ファイルを消す", async () => {
    const dir = await fixture();
    const file = path.join(dir, "cc-live.jsonl");

    // 既存の退避ファイルを mtime 昇順で 3 件用意する。
    const existing = ["cc-live.20260701-000000.jsonl", "cc-live.20260702-000000.jsonl", "cc-live.20260703-000000.jsonl"];
    existing.forEach((name, index) => {
      const archive = path.join(dir, name);
      fs.writeFileSync(archive, "old");
      const when = new Date(2026, 6, 1 + index);
      fs.utimesSync(archive, when, when);
    });

    fs.writeFileSync(file, "z".repeat(2048));
    expect(rotateLogFileIfOversize(file, policy(1024, 2), new Date(2026, 6, 30, 16, 45, 30))).toBe(true);

    // 新しい退避 1 件 + 既存の最新 1 件 = 2 件だけ残る。
    expect(archivesOf(dir)).toEqual(["cc-live.20260703-000000.jsonl", "cc-live.20260730-164530.jsonl"]);
  });

  it("stamp を持たない同名 prefix のファイルは keep 超過でも消さない", async () => {
    const dir = await fixture();
    const file = path.join(dir, "concordia-log");
    const bystander = path.join(dir, "concordia-log.lock");
    fs.writeFileSync(bystander, "not an archive");
    fs.writeFileSync(file, "w".repeat(2048));

    expect(rotateLogFileIfOversize(file, policy(1024, 0), new Date(2026, 6, 30, 16, 45, 30))).toBe(true);

    expect(fs.existsSync(bystander)).toBe(true);
    expect(fs.existsSync(path.join(dir, "concordia-log.20260730-164530"))).toBe(false);
  });

  it("拡張子が無いパスでも退避できる", async () => {
    const dir = await fixture();
    const file = path.join(dir, "concordia-log");
    fs.writeFileSync(file, "w".repeat(2048));

    expect(rotateLogFileIfOversize(file, policy(1024), new Date(2026, 6, 30, 16, 45, 30))).toBe(true);
    expect(fs.existsSync(path.join(dir, "concordia-log.20260730-164530"))).toBe(true);
  });
});
